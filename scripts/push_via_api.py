#!/usr/bin/env python3
"""Push local git commit(s) to GitHub via Git Database REST API (sandbox-safe)."""
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
        return e.code, json.load(e)


def main():
    st, repo = api("GET", "/repos/%s/%s" % (OWNER, REPO))
    if st == 404:
        st, repo = api("POST", "/user/repos", {"name": REPO, "private": True, "auto_init": False})
        if st not in (200, 201):
            print("create repo failed", st, repo)
            sys.exit(1)
        print("repo created")
    elif st != 200:
        print("repo check failed", st, repo)
        sys.exit(1)

    st, ref = api("GET", "/repos/%s/%s/git/ref/heads/main" % (OWNER, REPO))
    parent = ref["object"]["sha"] if st == 200 else None
    print("parent:", parent)

    ls_out = subprocess.run(["git", "ls-files", "-s"], capture_output=True, text=True, check=True).stdout
    entries = {}
    for line in ls_out.splitlines():
        parts = line.split(None, 3)
        if len(parts) == 4:
            entries[parts[3]] = parts[0]

    tree_items = []
    for path, mode in entries.items():
        data = subprocess.run(["git", "show", "HEAD:" + path], capture_output=True, check=True).stdout
        st, blob = api("POST", "/repos/%s/%s/git/blobs" % (OWNER, REPO), {
            "content": data.decode("utf-8", "surrogateescape"),
            "encoding": "utf-8",
        })
        if st != 201:
            print("blob failed", path, st, blob)
            sys.exit(1)
        tree_items.append({"path": path, "mode": mode, "type": "blob", "sha": blob["sha"]})
    print("%d blobs" % len(tree_items))

    body = {"tree": tree_items}
    if parent:
        body["base_tree"] = parent
    st, tree = api("POST", "/repos/%s/%s/git/trees" % (OWNER, REPO), body)
    if st != 201:
        print("tree failed", st, tree)
        sys.exit(1)

    msg = subprocess.run(["git", "log", "-1", "--pretty=%B"], capture_output=True, text=True, check=True).stdout.strip()
    cb = {
        "message": msg,
        "tree": tree["sha"],
        "author": {"name": "sunxufeng", "email": "sunxufeng@users.noreply.github.com"},
    }
    if parent:
        cb["parents"] = [parent]
    st, commit = api("POST", "/repos/%s/%s/git/commits" % (OWNER, REPO), cb)
    if st != 201:
        print("commit failed", st, commit)
        sys.exit(1)

    st, ref = api("PATCH", "/repos/%s/%s/git/refs/heads/main" % (OWNER, REPO), {"sha": commit["sha"], "force": False})
    if st == 200:
        print("pushed:", commit["sha"])
    else:
        print("ref update failed", st, ref)
        sys.exit(1)


if __name__ == "__main__":
    main()
