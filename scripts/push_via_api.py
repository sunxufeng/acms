#!/usr/bin/env python3
"""Push local git commit(s) to GitHub via Git Database REST API (sandbox-safe).

Mirrors origin/main..HEAD onto GitHub main via the REST API because the sandbox
proxy returns 502 for github.com CONNECT tunnels (so `git push` fails), but
api.github.com is reachable.

特性：
- 逐 commit 复制（非 squash），支持一次推送多个本地提交
- 精确保留 author/committer/message → 远端 commit SHA 与本地完全一致（SHA-perfect）
- 正确处理文件删除（tree entry sha=null）与 mode 变更
- 仅支持线性历史（遇 merge commit 报错退出）
- fast-forward 校验：远端 HEAD 必须是本地 HEAD 的祖先
"""
import base64
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

TOKEN = os.environ["GH_TOKEN"]
OWNER, REPO = "sunxufeng", "acms"
API = "https://api.github.com"


def api(method, path, body=None):
    req = urllib.request.Request(
        API + path,
        method=method,
        headers={
            "Authorization": "Bearer " + TOKEN,
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "acms-push",
        },
        data=json.dumps(body).encode() if body is not None else None,
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.load(e)
        except Exception:
            return e.code, {"message": str(e)}


def git(*args, binary=False):
    out = subprocess.run(["git"] + list(args), capture_output=True, check=True)
    return out.stdout if binary else out.stdout.decode()


def parse_commit(sha):
    """解析 commit 对象：返回 dict(tree/parents/author/committer/message)"""
    raw = git("cat-file", "commit", sha, binary=True).decode()
    head, _, message = raw.partition("\n\n")
    meta = {"message": message}
    for line in head.splitlines():
        key, _, val = line.partition(" ")
        if key == "tree":
            meta["tree"] = val
        elif key == "parent":
            meta.setdefault("parents", []).append(val)
        elif key in ("author", "committer"):
            m = re.match(r"^(.*?) <(.*?)> (\d+) ([+-]\d{4})$", val)
            if not m:
                raise SystemExit("cannot parse %s line: %r" % (key, val))
            name, email, ts, off = m.groups()
            sign = 1 if off[0] == "+" else -1
            tz = timezone(sign * timedelta(hours=int(off[1:3]), minutes=int(off[3:5])))
            meta[key] = {
                "name": name,
                "email": email,
                "date": datetime.fromtimestamp(int(ts), tz=tz).isoformat(),
            }
    return meta


def main():
    st, repo = api("GET", "/repos/%s/%s" % (OWNER, REPO))
    if st != 200:
        print("repo check failed", st, repo)
        sys.exit(1)

    st, ref = api("GET", "/repos/%s/%s/git/ref/heads/main" % (OWNER, REPO))
    if st != 200:
        print("ref get failed", st, ref)
        sys.exit(1)
    remote_head = ref["object"]["sha"]
    print("remote main:", remote_head)

    # 本地待推送提交（oldest first）
    commits = git("rev-list", "--reverse", "%s..HEAD" % remote_head).split()
    if not commits:
        print("nothing to push (remote already up to date)")
        return

    # fast-forward 校验
    mb = subprocess.run(["git", "merge-base", "--is-ancestor", remote_head, "HEAD"])
    if mb.returncode != 0:
        print("REFUSE: remote main (%s) is not an ancestor of local HEAD" % remote_head)
        print("Pull/rebase first.")
        sys.exit(1)

    # 第一个待推提交的 parent 必须就是远端 HEAD（保证逐提交复制可行）
    first = parse_commit(commits[0])
    if first["parents"] != [remote_head]:
        print("REFUSE: first unpushed commit's parent %s != remote head %s"
              % (first["parents"], remote_head))
        print("History diverged; rebase onto remote first.")
        sys.exit(1)

    prev = remote_head
    for c in commits:
        meta = parse_commit(c)
        if len(meta.get("parents", [])) != 1:
            print("REFUSE: merge commit %s not supported (linear only)" % c)
            sys.exit(1)
        parent = meta["parents"][0]
        if parent != prev:
            print("REFUSE: commit %s parent %s != previous %s (non-linear)" % (c, parent, prev))
            sys.exit(1)

        # 父提交 tree SHA（远端已有该 tree）
        parent_tree = git("rev-parse", parent + "^{tree}").strip()

        # diff 行格式: :<old_mode> <new_mode> <old_sha> <new_sha> <status>\t<path>
        entries = []
        d = git("diff-tree", "-r", "--no-renames", parent, c)
        for line in d.splitlines():
            parts = line.split("\t")
            if len(parts) != 2:
                continue
            fields = parts[0].split()
            if len(fields) != 5:
                continue
            path = parts[1]
            old_mode = fields[0].lstrip(":")
            new_mode, old_sha, new_sha = fields[1], fields[2], fields[3]
            if new_sha == "0000000000000000000000000000000000000000":
                # 删除文件
                entries.append({"path": path, "mode": old_mode, "type": "blob", "sha": None})
            else:
                if old_sha != new_sha:
                    # 内容有变化 → 上传新 blob
                    data = git("show", new_sha, binary=True)
                    st2, blob = api("POST", "/repos/%s/%s/git/blobs" % (OWNER, REPO),
                                    {"content": base64.b64encode(data).decode(),
                                     "encoding": "base64"})
                    if st2 not in (201, 200):
                        print("blob failed", path, st2, blob)
                        sys.exit(1)
                    new_sha = blob["sha"]
                entries.append({"path": path, "mode": new_mode, "type": "blob", "sha": new_sha})

        st3, new_tree = api("POST", "/repos/%s/%s/git/trees" % (OWNER, REPO),
                            {"base_tree": parent_tree, "tree": entries})
        if st3 not in (201, 200):
            print("tree failed", st3, new_tree)
            sys.exit(1)
        if new_tree["sha"] != meta["tree"]:
            print("WARN: remote tree %s != local tree %s for %s" % (new_tree["sha"], meta["tree"], c))

        st4, commit = api("POST", "/repos/%s/%s/git/commits" % (OWNER, REPO),
                          {"message": meta["message"], "tree": new_tree["sha"],
                           "parents": [parent],
                           "author": meta["author"], "committer": meta["committer"]})
        if st4 not in (201, 200):
            print("commit failed", st4, commit)
            sys.exit(1)
        mark = "OK" if commit["sha"] == c else "MISMATCH(local=%s)" % c
        print("commit %s -> %s %s" % (c[:7], commit["sha"][:7], mark))
        prev = commit["sha"]

    st5, upd = api("PATCH", "/repos/%s/%s/git/refs/heads/main" % (OWNER, REPO),
                   {"sha": prev, "force": False})
    if st5 not in (200, 201):
        print("ref update failed", st5, upd)
        sys.exit(1)
    local_head = git("rev-parse", "HEAD").strip()
    if prev == local_head:
        print("PUSHED OK (SHA-perfect) ->", prev)
    else:
        print("PUSHED OK ->", prev)
        print("NOTE: remote head differs from local %s (metadata mismatch); align locally." % local_head)


if __name__ == "__main__":
    main()
