#!/usr/bin/env python3
"""
当 git fetch 被代理拦截（CONNECT 502）时，通过 GitHub REST API 精确重建远端提交。

原理：提交的 SHA 由 (tree, parents, author, committer, message) 决定。
只要按同样的顺序、同样的文件内容、同样的作者信息与时间戳重放，就能得到完全相同的 SHA，
从而把远端历史「原样」搬到本地，避免强推丢失他人提交。

用法：
  GH_TOKEN=<PAT> python3 scripts/fetch_via_api.py <remote_sha> [<remote_sha2> ...]
  GH_TOKEN=<PAT> python3 scripts/fetch_via_api.py --sync          # 拉取本地缺失的远端 main

约束：每个提交的父提交必须已存在于本地（或由本次运行先行重建），故按从旧到新顺序传入。
"""
import base64
import calendar
import datetime
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

REPO = "sunxufeng/acms"
API = f"https://api.github.com/repos/{REPO}"


def gh(path):
    token = os.environ.get("GH_TOKEN", "")
    req = urllib.request.Request(
        f"{API}{path}",
        headers={
            "Authorization": f"Bearer {token}",
            "User-Agent": "acms-fetch-via-api",
            "Accept": "application/vnd.github+json",
        },
    )
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def git(*args, env=None, check=True):
    e = dict(os.environ)
    if env:
        e.update(env)
    p = subprocess.run(["git"] + list(args), capture_output=True, text=True, env=e)
    if check and p.returncode != 0:
        raise RuntimeError("git %s failed: %s" % (" ".join(args), p.stderr.strip()))
    return p.stdout.strip()


def local_has(sha):
    p = subprocess.run(["git", "cat-file", "-e", sha + "^{commit}"],
                       capture_output=True, text=True)
    return p.returncode == 0


def file_content_at(sha, path):
    """取某提交下某个文件的内容（走 blob API，避开 contents API 的大小限制）。"""
    tree = gh(f"/commits/{sha}")["commit"]["tree"]["sha"]
    parts = path.split("/")
    cur = gh(f"/git/trees/{tree}")
    node = None
    for i, part in enumerate(parts):
        entries = cur.get("tree", [])
        node = next((x for x in entries if x["path"] == part), None)
        if node is None:
            return None
        if i < len(parts) - 1:
            cur = gh(f"/git/trees/{node['sha']}")
    if node is None or node["type"] != "blob":
        return None
    blob = gh(f"/git/blobs/{node['sha']}")
    if blob.get("encoding") == "base64":
        return base64.b64decode(blob["content"])
    return blob["content"].encode("utf-8")


def reconstruct(sha):
    meta = gh(f"/commits/{sha}")
    c = meta["commit"]
    parents = [p["sha"] for p in meta["parents"]]
    if len(parents) != 1:
        raise RuntimeError(f"{sha[:8]} 有 {len(parents)} 个父提交，暂不支持（merge commit）")
    parent = parents[0]
    if not local_has(parent):
        raise RuntimeError(f"父提交 {parent[:8]} 不在本地，请先按顺序重建它")

    files = meta.get("files", [])
    index = f"/tmp/fetch_via_api_{sha}.idx"
    env = {"GIT_INDEX_FILE": index}
    if os.path.exists(index):
        os.remove(index)
    git("read-tree", parent, env=env)

    for f in files:
        path, status = f["filename"], f["status"]
        if status == "removed":
            git("update-index", "--force-remove", path, env=env)
            continue
        content = file_content_at(sha, path)
        if content is None:
            raise RuntimeError(f"取不到 {sha[:8]} 下 {path} 的内容")
        tmp = f"/tmp/fetch_via_api_blob"
        with open(tmp, "wb") as fh:
            fh.write(content)
        blob = git("hash-object", "-w", tmp, env=env)
        # 保留原 mode（新增文件用 100644）
        ls = subprocess.run(["git", "ls-files", "-s", path],
                            capture_output=True, text=True,
                            env={**os.environ, **env}).stdout.strip()
        mode = ls.split(" ")[0] if ls else "100644"
        git("update-index", "--add", "--cacheinfo", f"{mode},{blob},{path}", env=env)

    tree = git("write-tree", env=env)
    if tree != c["tree"]["sha"]:
        raise RuntimeError(
            f"树不匹配 {sha[:8]}：本地 {tree[:12]} != 远端 {c['tree']['sha'][:12]}"
        )

    # GitHub API 把提交时间归一化成 UTC（...Z），而提交对象里存的是作者本地时区偏移，
    # 直接按 +0000 重放会算错 SHA。这里遍历候选时区 + 消息尾换行两种写法，
    # 直到重放出的 SHA 与远端一致。
    epoch = calendar.timegm(
        datetime.datetime.strptime(c["author"]["date"], "%Y-%m-%dT%H:%M:%SZ").timetuple()
    )
    epoch_c = calendar.timegm(
        datetime.datetime.strptime(c["committer"]["date"], "%Y-%m-%dT%H:%M:%SZ").timetuple()
    )
    msg_path = "/tmp/fetch_via_api_msg"
    msg_variants = [c["message"], c["message"] + "\n"]
    offsets = []
    for h in range(-12, 15):
        for m in (0, 30, 45):
            offsets.append("%+03d%02d" % (h, m))
    offsets = sorted(set(offsets), key=lambda o: (o != "+0800", o != "+0000", o))

    new_sha = None
    for tz in offsets:
        for msg in msg_variants:
            with open(msg_path, "w", encoding="utf-8") as fh:
                fh.write(msg)
            cenv = {
                "GIT_AUTHOR_NAME": c["author"]["name"],
                "GIT_AUTHOR_EMAIL": c["author"]["email"],
                "GIT_AUTHOR_DATE": f"{epoch} {tz}",
                "GIT_COMMITTER_NAME": c["committer"]["name"],
                "GIT_COMMITTER_EMAIL": c["committer"]["email"],
                "GIT_COMMITTER_DATE": f"{epoch_c} {tz}",
            }
            out = subprocess.run(
                ["git", "commit-tree", tree, "-p", parent, "-F", msg_path],
                capture_output=True, text=True, env={**os.environ, **cenv},
            ).stdout.strip()
            if out == sha:
                new_sha = out
                print(f"    (时区 {tz})")
                break
        if new_sha:
            break

    if new_sha != sha:
        raise RuntimeError(
            f"SHA 不匹配：无法重放 {sha}（树已一致，差异在时区/消息结尾）"
        )
    print(f"  ✓ 重建 {sha[:8]}  {c['message'].splitlines()[0][:60]}")
    os.remove(index)
    return sha


def main():
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return 1
    if args[0] == "--sync":
        remote = gh("/git/ref/heads/main")["object"]["sha"]
        # 从远端往回找，直到命中本地已有的提交
        chain = []
        cur = remote
        while cur and not local_has(cur):
            chain.append(cur)
            parents = gh(f"/commits/{cur}")["parents"]
            cur = parents[0]["sha"] if parents else None
        chain.reverse()
        if not chain:
            print("本地已与远端同步。")
            return 0
        print(f"远端 main = {remote[:8]}，需要重建 {len(chain)} 个提交")
        for sha in chain:
            reconstruct(sha)
        return 0

    for sha in args:
        full = gh(f"/commits/{sha}")["sha"]
        if local_has(full):
            print(f"  = 已存在 {full[:8]}")
            continue
        reconstruct(full)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except urllib.error.HTTPError as e:
        print("HTTP 错误:", e.code, e.read().decode()[:300])
        sys.exit(2)
    except Exception as e:
        print("失败:", e)
        sys.exit(1)
