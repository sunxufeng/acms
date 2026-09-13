#!/usr/bin/env python3
"""
把 scripts/calc_menu_perm_patch.mjs 算出的补丁落库到**生产** role_permission_config。

用法（在服务器上执行）：
  python3 scripts/apply_menu_perm_patch.py                    # dry-run，只打印将要发生的变更
  python3 scripts/apply_menu_perm_patch.py --apply            # 真正写库（自动备份）
  PATCH_FILE=/tmp/perm_patch.json python3 ... --apply         # 指定补丁文件

设计要点：
- **幂等**：只追加角色当前没有的权限点，重复执行不会重复添加，也不会删任何权限点（只增不减）；
- **先备份**：写前把原值存 /tmp/role_permission_config.bak.<ts>.json；
- **回读校验**：写完立刻从库里读回来核对（不信 psql 的"执行成功"，本项目多次被 ssh 重放坑到
  —— 同一条写命令跑两次，第一次生效、第二次因幂等跳过，只看当次输出会误判成败）；
- **表名自己解析**：代码里的 tableId 是别名，生产真实表 ID 在 /opt/acms/.env 的 TABLE_ID_MAP，
  不解析会 TableIdNotFound（这是本项目脚本侧的老坑）。
"""
import json
import os
import subprocess
import sys
import time

APPLY = '--apply' in sys.argv
ENV_FILE = os.environ.get('ACMS_ENV', '/opt/acms/.env')
CONFIG_KEY = 'role_permission_config'
PATCH_FILE = os.environ.get('PATCH_FILE', '/tmp/perm_patch.json')
# 代码里「系统配置表」的别名 ID（packages/contracts/src/tables.ts 的 TABLES.systemConfig）
SYS_CONFIG_ALIAS = 'tblvBrRCWO65L6Yg'


def read_env():
    out = {}
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            out[k] = v.strip().strip('"').strip("'")
    return out


def psql(db, sql, tuples_only=True):
    args = ['psql', db, '-t', '-A', '-c', sql]
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit('psql 失败: ' + r.stderr.strip()[:300])
    return r.stdout.strip()


def main():
    env = read_env()
    db = env.get('DATABASE_URL')
    if not db:
        raise SystemExit('DATABASE_URL 未找到')
    table_id = SYS_CONFIG_ALIAS
    try:
        idmap = json.loads(env.get('TABLE_ID_MAP') or '{}')
        table_id = idmap.get(SYS_CONFIG_ALIAS, SYS_CONFIG_ALIAS)
    except Exception:
        pass
    table = 't_' + table_id.lower()
    print('系统配置表:', table)

    patch = json.load(open(PATCH_FILE))
    raw = psql(db, "SELECT data->>'配置值' FROM %s WHERE data->>'配置键'='%s';" % (table, CONFIG_KEY))
    if not raw:
        raise SystemExit('未取到 ' + CONFIG_KEY)
    cfg = json.loads(raw)

    total = 0
    touched = []
    for r in cfg.get('roles', []):
        want = patch.get(r.get('key')) or []
        if not want:
            continue
        have = set(r.get('permissions') or [])
        add = [p for p in want if p not in have]
        if not add:
            continue
        r['permissions'] = list(r.get('permissions') or []) + add
        total += len(add)
        touched.append((r.get('key'), len(add), len(have), len(r['permissions'])))

    if not touched:
        print('没有需要变更的角色（已是目标状态）')
        return

    print('将变更的角色：')
    for key, n, before, after in touched:
        print('  %s: +%d  (%d -> %d)' % (key, n, before, after))
    print('合计新增 %d 条' % total)

    if not APPLY:
        print('\n[dry-run] 未写库。加 --apply 执行。')
        return

    bak = '/tmp/role_permission_config.bak.%d.json' % int(time.time())
    with open(bak, 'w') as f:
        f.write(raw)
    print('\n已备份 -> ' + bak)

    new_raw = json.dumps(cfg, ensure_ascii=False, separators=(',', ':'))
    sqlfile = '/tmp/_apply_menu_perm.sql'
    with open(sqlfile, 'w') as f:
        f.write("\\set payload '" + new_raw.replace("'", "''") + "'\n")
        f.write(
            "UPDATE %s SET data = jsonb_set(data, '{配置值}', to_jsonb(:'payload'::text)) "
            "WHERE data->>'配置键' = '%s';\n" % (table, CONFIG_KEY)
        )
    r = subprocess.run(['psql', db, '-q', '-f', sqlfile], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit('写库失败: ' + r.stderr.strip()[:300])
    os.remove(sqlfile)
    print('写库完成')

    back = json.loads(psql(db, "SELECT data->>'配置值' FROM %s WHERE data->>'配置键'='%s';" % (table, CONFIG_KEY)))
    ok = 0
    for r2 in back.get('roles', []):
        want = patch.get(r2.get('key')) or []
        if not want:
            continue
        if all(p in set(r2.get('permissions') or []) for p in want):
            ok += 1
    print('回读校验：%d/%d 个角色已包含全部预期权限点' % (ok, len(touched)))
    print('角色数不变:', len(back.get('roles', [])) == len(cfg.get('roles', [])))


if __name__ == '__main__':
    main()
