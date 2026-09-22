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
commit 的 tree / parent / author / committer / message 全部原样取自本地提交对象，
**因此远端 SHA 与本地一致**（SHA-perfect）—— 这点很要紧：脚本下次要 `git diff 远端SHA HEAD`，
若远端 SHA 是自己另算出来的对象，diff 会直接失败，而 github.com 不通、fetch 也补不回来。
"""

# ⚠️ 网络在「小请求通、大 POST body 偶发超时」这个模式下工作（见 api() 的注释），
#    所以每个请求都带重试 + 180s 超时；失败信息会打印出来，别当静默卡死。
import base64
import json
import os
import subprocess
import sys
import time

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


def api(method, path, payload=None, attempts=4, timeout=180):
    """发一次 GitHub API 请求。

    ⚠️ 必须带重试与较长超时（2026-09-14 实测）：同一台机器 curl 打 api.github.com 是 200、
    但**上传 blob 时随机 `curl: (28) Connection timed out after 60000 ms`** ——
    网络在「小请求通、大 POST body 偶发卡住」这个模式下，单发不带重试会把推送打断在半路，
    白等一分钟还要从头发。改 180s 超时 + 最多 4 次重试后稳定通过。
    重试只对**幂等**的 Git Database 接口有意义：blob/tree/commit 都是按内容寻址，重复提交无副作用。
    """
    args = [
        # ⚠️ `-w` 的值**不能以 @ 开头**（curl 会把 @xxx 当成"从文件读格式串"，
        #    报 `option -w: error encountered when reading a file`）
        'curl', '-sS', '--max-time', str(timeout), '-w', '\nHTTPCODE:%{http_code}', '-X', method,
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

    last = ''
    for i in range(attempts):
        r = subprocess.run(args, input=data, capture_output=True, env=env)
        out = r.stdout.decode('utf-8', 'replace')
        if r.returncode == 0:
            # ⚠️ 状态码必须看（2026-09-23 加，代价：一次推送排查花了 20 分钟）：
            #    此前**完全不看状态码**，只 `json.loads(out)` —— 而 GitHub 的 4xx/5xx 响应
            #    也是合法 JSON，于是错误体被当成成功返回，调用方在 `blob['sha']` 处抛
            #    KeyError（`KeyError: 'sha'`），真正原因（如
            #    `403 Resource not accessible by personal access token` = PAT 被降成只读）
            #    被彻底吞掉，看起来像"脚本坏了"而不是"token 没权限"。
            body, _, code = out.rpartition('HTTPCODE:')
            code = code.strip()
            try:
                parsed = json.loads(body or '{}')
            except Exception:
                last = '响应不是 JSON：' + out[:200]
            else:
                if code.startswith('4') or code.startswith('5'):
                    msg = parsed.get('message') if isinstance(parsed, dict) else None
                    raise SystemExit(
                        'GitHub API %s %s -> HTTP %s：%s\n'
                        '（403 Resource not accessible by personal access token ⇒ 该 PAT 缺 Contents: write，'
                        '要去 GitHub Settings → Developer settings → Fine-grained tokens 里把仓库权限改成 Read and write）'
                        % (method, path, code, msg or body[:200])
                    )
                return parsed
        else:
            last = r.stderr.decode()[:200]
        if i < attempts - 1:
            print('   … %s 第 %d 次失败，2s 后重试：%s' % (path, i + 1, last.strip()[:110]))
            time.sleep(2)
    raise SystemExit('curl 失败(%s，重试 %d 次)：%s' % (path, attempts, last))


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

# ⚠️ 必须带 `--no-renames`（2026-09-19 实测踩到）：
#    开了重命名检测时，`diff --name-only` 对「A 改名到 B」**只输出新路径 B**，
#    旧路径 A 根本不出现在列表里 ⇒ 脚本不会把它标成 deleted ⇒ base_tree 里那份旧文件
#    继续留在远端，**远端 tree 与本地 HEAD 不再一致**。
#    本次表现：`git mv home-school-comms/AiSummarizeModal.tsx components/` 之后，
#    远端多出一个 `apps/web/app/home-school-comms/AiSummarizeModal.tsx`（本地早已没有）。
#    加 --no-renames 后，改名会被拆成「删除旧 + 新增新」两条，删除才表达得出来。
changed = [f for f in git('diff', '--name-only', '--no-renames', remote_sha, local_sha).split('\n') if f.strip()]
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
