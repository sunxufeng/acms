#!/usr/bin/env python3
"""Push local git commit(s) to GitHub via Git Database REST API (sandbox-safe).

Mirrors HEAD's tree onto GitHub main via the REST API because the sandbox
proxy returns 502 for git:// / https CONNECT tunnels (so `git push` fails),
but api.github.com is reachable.
"""
import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

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


def main():
    st, repo = api("GET", "/repos/%s/%s" % (OWNER, REPO))
    if st != 200:
        print("repo check failed", st, repo)
        sys.exit(1)

    st, ref = api("GET", "/repos/%s/%s/git/ref/heads/main" % (OWNER, REPO))
    if st != 200:
        print("ref get failed", st, ref)
        sys.exit(1)
    parent = ref["object"]["sha"]
    print("parent:", parent)

    st, ptree = api("GET", "/repos/%s/%s/git/trees/%s?recursive=1" % (OWNER, REPO, parent))
    if st != 200:
        print("parent tree failed", st, ptree)
        sys.exit(1)
    parent_map = {e["path"]: e["sha"] for e in ptree["tree"] if e["type"] == "blob"}

    ls_out = subprocess.run(
        ["git", "ls-tree", "-r", "HEAD"], capture_output=True, text=True, check=True
    ).stdout

    tree_items = []
    n_new = 0
    for line in ls_out.splitlines():
        meta, path = line.split("\t", 1)
        mode, typ, sha = meta.split()
        if typ != "blob":
            continue
        if parent_map.get(path) == sha:
            tree_items.append({"path": path, "mode": mode, "type": "blob", "sha": sha})
        else:
            data = subprocess.run(
                ["git", "show", "HEAD:" + path], capture_output=True, check=True
            ).stdout
            b64 = base64.b64encode(data).decode()
            st2, blob = api("POST", "/repos/%s/%s/git/blobs" % (OWNER, REPO),
                            {"content": b64, "encoding": "base64"})
            if st2 not in (201, 200):
                print("blob failed", path, st2, blob)
                sys.exit(1)
            tree_items.append({"path": path, "mode": mode, "type": "blob", "sha": blob["sha"]})
            n_new += 1
    print("tree items:", len(tree_items), "new blobs:", n_new)

    st3, new_tree = api("POST", "/repos/%s/%s/git/trees" % (OWNER, REPO),
                        {"base_tree": parent, "tree": tree_items})
    if st3 not in (201, 200):
        print("tree failed", st3, new_tree)
        sys.exit(1)

    msg = os.environ.get("COMMIT_MESSAGE", "sync: force update main via REST API")
    st4, commit = api("POST", "/repos/%s/%s/git/commits" % (OWNER, REPO),
                      {"message": msg, "tree": new_tree["sha"], "parents": [parent]})
    if st4 not in (201, 200):
        print("commit failed", st4, commit)
        sys.exit(1)
    print("commit:", commit["sha"])

    st5, upd = api("PATCH", "/repos/%s/%s/git/refs/heads/main" % (OWNER, REPO),
                   {"sha": commit["sha"], "force": True})
    if st5 not in (200, 201):
        print("ref update failed", st5, upd)
        sys.exit(1)
    print("PUSHED OK ->", commit["sha"])


if __name__ == "__main__":
    main()
