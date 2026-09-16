#!/usr/bin/env python3
"""
把远端 main tip 的 commit 对象「重建」到本地并对其 refs/remotes/origin/main。

## 为什么需要它

`scripts/push_via_curl.py` 是**快照式推送**：它只把**本地 HEAD 的 tree**
打成一个 commit 推上去，`parents` 固定写成**推送前的远端 tip**
（见该脚本 `'parents': [remote_sha]`）。

⇒ 一次推 N 个本地 commit 时，远端只多 1 个 commit（内容等价、SHA 不同），
  本地与远端从此 **SHA 分叉**（tree 相同）。
⇒ 下次再推时该脚本会硬失败：

    ⚠️ 远端 tip <sha> 不在本地仓库，先 git fetch 再跑本脚本

而 `github.com` 的 fetch 通道被沙箱/代理拦截，`git fetch` 往往跑不通。

## 做法

远端那个 commit 与本地 HEAD **只差 parent 一行**（tree / author / committer /
message 全同，因为脚本就是拿本地 HEAD 的原文构造的）。所以：

1. 读本地 `HEAD` 的 commit 原文（`git cat-file commit HEAD`）
2. 把 `parent <本地 HEAD^>` 换成 `parent <远端 tip 的 parent>`
3. `git hash-object -t commit -w --stdin` 写回对象库
4. 算出的 SHA **等于远端 tip** ⇒ 说明重建正确，于是对齐
   `refs/remotes/origin/main`（此时 `git status` 不再假报 ahead/behind）

⚠️ 判「本地与远端是否等价」始终比 **tree SHA**，不比 commit SHA。

## 用法

    python3 scripts/sync_remote_ref.py            # 需要 GH_TOKEN（读 ref 与 commit 元数据）
    python3 scripts/sync_remote_ref.py --dry-run
"""
import json
import os
import subprocess
import sys

REPO = 'sunxufeng/acms'
TOKEN = os.environ.get('GH_TOKEN', '')
DRY = '--dry-run' in sys.argv

if not TOKEN:
    print('需要 GH_TOKEN（只读即可：Contents: read）')
    sys.exit(1)


def api(path):
    """⚠️ 走 curl 而不是 urllib：本机 urllib 访问 api.github.com 会偶发
    `SSL: UNEXPECTED_EOF_WHILE_READING`（沙箱/代理层问题），同一个域名 curl 稳定 200。
    与 `scripts/push_via_curl.py` 用同一条通道，少一类干扰。"""
    p = subprocess.run(
        ['curl', '-sS', '-H', 'Accept: application/vnd.github+json',
         '-H', 'Authorization: Bearer ' + TOKEN,
         f'https://api.github.com{path}'],
        capture_output=True, text=True,
    )
    if p.returncode != 0:
        print(f'curl {path} 失败: {p.stderr[:200]}')
        sys.exit(1)
    d = json.loads(p.stdout)
    if isinstance(d, dict) and d.get('message') and 'rate limit' in str(d.get('message')):
        print('API 限流，稍后重试或换用带 token 的请求')
        sys.exit(1)
    return d


def git(*args, **kw):
    return subprocess.run(['git', *args], capture_output=True, **kw)


remote_sha = api(f'/repos/{REPO}/git/ref/heads/main')['object']['sha']
rc = api(f'/repos/{REPO}/git/commits/{remote_sha}')
remote_parent = rc['parents'][0]['sha'] if rc['parents'] else None

local_head = git('rev-parse', 'HEAD', text=True).stdout.strip()
local_tree = git('rev-parse', 'HEAD^{tree}', text=True).stdout.strip()
local_parent = git('rev-parse', 'HEAD^', text=True).stdout.strip()

print(f'远端 tip  : {remote_sha}')
print(f'   tree   : {rc["tree"]["sha"]}')
print(f'   parent : {remote_parent}')
print(f'本地 HEAD : {local_head}')
print(f'   tree   : {local_tree}')

if rc['tree']['sha'] == local_tree:
    print('✅ tree 一致（内容等价）')
else:
    print('ℹ️ tree 不一致：远端不是本地 HEAD 的快照，可能有未推送的改动（下面只在能重建时才对齐）')

if remote_parent is None:
    print('远端 commit 没有 parent（首个提交），跳过重建')
    sys.exit(0)

raw = git('cat-file', 'commit', 'HEAD').stdout
new = raw.replace(b'parent ' + local_parent.encode(), b'parent ' + remote_parent.encode())
if new == raw:
    print('ℹ️ 本地 HEAD 的 parent 与远端 tip 的 parent 相同，无需改写')
else:
    got = git('hash-object', '-t', 'commit', '-w', '--stdin', input=new).stdout.decode().strip()
    print(f'重建对象  : {got}')
    if got != remote_sha:
        print('❌ 重建结果与远端 tip 不一致 —— 远端 commit 不是本地 HEAD 的等价快照，'
              '不要强行对齐（会掩盖真实差异）')
        sys.exit(1)
    print('✅ 重建成功（与远端 tip 完全一致）')
    if DRY:
        print('[dry-run] 跳过 update-ref')
        sys.exit(0)

git('update-ref', 'refs/remotes/origin/main', remote_sha)
print('✅ refs/remotes/origin/main 已对齐 → 现在可以正常跑 push_via_curl.py 了')
print(git('status', '-sb', text=True).stdout.strip().split('\n')[0])
