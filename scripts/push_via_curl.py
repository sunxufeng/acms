#!/usr/bin/env python3
"""
用 GitHub Git Database API 推送本地提交 —— **网络层走 curl**（不是 python urllib）。

什么时候需要它（2026-09-13 实测）：
  · `git push`（github.com:443）不通；
  · 连 `scripts/push_via_api.py` 也不行 —— 同一台机器上 curl 访问 api.github.com 返回 200，
    而 python 的 urllib/ssl 出站被环境重置（`SSL: UNEXPECTED_EOF_WHILE_READING` /
    `Connection reset by peer`）。
  ⇒ 于是让 python 只做「算 + 解析」，HTTP 一律交给 curl 子进程。

用法：
  GH_TOKEN=$(printf "protocol=https\\nhost=github.com\\n\\n" | git credential fill | sed -n 's/^password=//p') \
    python3 scripts/push_via_curl.py [分支，默认 main]

行为：把本地 HEAD 相对远端同名分支 tip 的差异，按 blob → tree → commit → 更新 ref 推上去。
远端会生成新 SHA（不追求 SHA 一致，但内容与提交信息一致）；
推完请 `git fetch && git reset --hard origin/<分支>` 对齐本地。
"""
import base64
import json
import os
import subprocess
import sys

REPO = os.environ.get('REPO', 'sunxufeng/acms')
API = 'https://api.github.com/repos/' + REPO
BRANCH = sys.argv[1] if len(sys.argv) > 1 else 'main'
TOKEN = os.environ.get('GH_TOKEN', '')
if not TOKEN:
    raise SystemExit('需要 GH_TOKEN 环境变量')


def git(*args, strip=True):
    r = subprocess.run(['git', *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit('git %s 失败: %s' % (' '.join(args), r.stderr.strip()[:200]))
    # ⚠️ message 这类内容**不能 strip**：少一个尾部换行，算出来的 commit SHA 就与本地不同
    #    （实测踩过：tree/parent/时间全一致，只差尾换行 → SHA 不同 → 下次推送时
    #     `git diff 远端SHA..HEAD` 直接失败，而本机 github.com 不通、fetch 也补不回来）
    return r.stdout.strip() if strip else r.stdout


def api(method, path, payload=None):
    args = [
        'curl', '-sS', '--max-time', '60', '-X', method,
        '-H', 'Authorization: Bearer ' + TOKEN,
        '-H', 'Accept: application/vnd.github+json',
    ]
    data = None
    if payload is not None:
        args += ['-H', 'Content-Type: application/json', '--data-binary', '@-']
        data = json.dumps(payload, ensure_ascii=False).encode()
    args.append(API + path)
    env = {k: v for k, v in os.environ.items()
           if k.lower() not in ('http_proxy', 'https_proxy', 'all_proxy')}
    r = subprocess.run(args, input=data, capture_output=True, env=env)
    out = r.stdout.decode('utf-8', 'replace')
    if r.returncode != 0:
        raise SystemExit('curl 失败(%s): %s' % (path, r.stderr.decode()[:200]))
    try:
        return json.loads(out)
    except Exception:
        raise SystemExit('响应不是 JSON（%s）：%s' % (path, out[:300]))


local_sha = git('rev-parse', 'HEAD')
print('本地 HEAD:', local_sha)
remote = api('GET', '/git/ref/heads/' + BRANCH)
remote_sha = remote['object']['sha']
print('远端 %s: %s' % (BRANCH, remote_sha))
if local_sha == remote_sha:
    print('已是最新，无需推送')
    raise SystemExit(0)

if subprocess.run(['git', 'cat-file', '-e', remote_sha + '^{commit}']).returncode != 0:
    raise SystemExit('⚠️ 远端 tip %s 不在本地仓库，先 git fetch 再跑本脚本' % remote_sha)

base_tree = api('GET', '/git/commits/' + remote_sha)['tree']['sha']
print('base tree:', base_tree)

changed = [f for f in git('diff', '--name-only', remote_sha, local_sha).split('\n') if f.strip()]
print('本次差异文件 %d 个' % len(changed))
entries = []
for f in changed:
    if os.path.isfile(f):
        blob = api('POST', '/git/blobs', {
            'content': base64.b64encode(open(f, 'rb').read()).decode(),
            'encoding': 'base64',
        })
        entries.append({'path': f, 'mode': '100755' if os.access(f, os.X_OK) else '100644',
                        'type': 'blob', 'sha': blob['sha']})
        print('  blob ok:', f)
    else:
        entries.append({'path': f, 'mode': '100644', 'type': 'blob', 'sha': None})
        print('  deleted:', f)

new_tree = api('POST', '/git/trees', {'base_tree': base_tree, 'tree': entries})['sha']
print('new tree:', new_tree)

# ⚠️ message 必须**原样**取（含尾部换行）：直接读 commit 对象的原始文本，
#    不要用 `git log --format=%B` + strip —— 那样算出的 SHA 会与本地不同。
raw_commit = git('cat-file', 'commit', 'HEAD', strip=False)
msg = raw_commit.partition('\n\n')[2]
new_commit = api('POST', '/git/commits', {
    'message': msg,
    'tree': new_tree,
    'parents': [remote_sha],
    'author': {'name': git('log', '-1', '--format=%an'), 'email': git('log', '-1', '--format=%ae'),
               'date': git('log', '-1', '--format=%aI')},
    'committer': {'name': git('log', '-1', '--format=%cn'), 'email': git('log', '-1', '--format=%ce'),
                  'date': git('log', '-1', '--format=%cI')},
})['sha']
print('new commit:', new_commit)

api('PATCH', '/git/refs/heads/' + BRANCH, {'sha': new_commit, 'force': False})
back = api('GET', '/git/ref/heads/' + BRANCH)['object']['sha']
print('%s 现在指向: %s' % (BRANCH, back))
if back == new_commit:
    print('推送完成 ✅（远端是新 SHA，本地请 git fetch 后 reset 对齐）')
else:
    raise SystemExit('❌ 推送校验失败')
