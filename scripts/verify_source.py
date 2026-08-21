#!/usr/bin/env python3
# 服务端验证：伪造管理员会话，对 source-followups 做 新建+读取 往返，确认
# 跟进时间(含时分) / 家长反馈态度 / 沟通明细 / 沟通总结 / 沟通附件清单 字段正常，
# 并测试 AI总结 prepare 接口。
import json, subprocess, secrets, time, urllib.request, urllib.error

SID = secrets.token_hex(16)
EXPIRES = int(time.time()) + 7200
user = {
    "openId": "forge", "name": "验证", "roles": ["系统管理员"],
    "campuses": ["北京"], "maxDataLevel": "L4",
    "sessionId": SID, "expiresAt": EXPIRES,
}
val = json.dumps(user, ensure_ascii=False)
r = subprocess.run(["redis-cli", "SET", f"session:{SID}", val, "EX", "3600"], capture_output=True, text=True)
print("redis SET:", r.stdout.strip(), r.stderr.strip())

BASE = "http://127.0.0.1:3000/api/v1"
HDRS = {"Content-Type": "application/json", "Cookie": f"acms_sid={SID}"}

def req(method, path, body=None):
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    reqo = urllib.request.Request(BASE + path, data=data, headers=HDRS, method=method)
    try:
        with urllib.request.urlopen(reqo) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

body = {
    "关联学生": "张三",
    "家长": "张父",
    "家长反馈态度": "积极",
    "沟通主题": "招生咨询跟进",
    "跟进时间": "2026-08-22T14:30",
    "沟通明细": "# 对话明细",
    "沟通总结": "招生跟进总结",
}
st, txt = req("POST", "/source-followups", body)
print("CREATE source-followups", st, txt[:400])
try:
    rec = json.loads(txt)
    rid = rec.get("id")
except Exception:
    rid = None
print("NEW_ID", rid)

if rid:
    st, txt = req("GET", f"/source-followups/{rid}")
    print("GET source-followups", st, txt[:800])
    try:
        g = json.loads(txt)
        print("  跟进时间 =", repr(g.get("跟进时间")))
        print("  关联学生 =", repr(g.get("关联学生")))
        print("  家长反馈态度 =", repr(g.get("家长反馈态度")))
        print("  沟通明细 =", repr(g.get("沟通明细")))
        print("  沟通总结 =", repr(g.get("沟通总结")))
    except Exception as e:
        print("parse err", e)

    # 测试 AI总结 prepare 接口
    st, txt = req("GET", f"/source-followups-ai/{rid}/prepare")
    print("AI prepare", st, txt[:300])

    st, txt = req("DELETE", f"/source-followups/{rid}")
    print("DELETE source-followups", st, txt[:100])

subprocess.run(["redis-cli", "DEL", f"session:{SID}"], capture_output=True, text=True)
print("VERIFY DONE")
