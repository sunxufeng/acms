#!/usr/bin/env python3
# 服务端验证：伪造管理员会话，对 daily-followups 做 新建+读取 往返，确认
# 沟通时间(含时分) / 沟通人备注 / 沟通时长(分钟) 字段正常。
import json, os, subprocess, secrets, time, urllib.request, urllib.error

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
    "沟通主题": "验证主题",
    "沟通时间": "2026-08-22T14:30",
    "沟通人备注": "这是沟通人备注测试",
    "沟通时长(分钟)": "30",
    "沟通明细": "# 对话明细",
    "沟通总结": "总结内容",
}
st, txt = req("POST", "/daily-followups", body)
print("CREATE daily-followups", st, txt[:400])
try:
    rec = json.loads(txt)
    rid = rec.get("id")
except Exception:
    rid = None
print("NEW_ID", rid)

if rid:
    st, txt = req("GET", f"/daily-followups/{rid}")
    print("GET daily-followups", st, txt[:600])
    try:
        g = json.loads(txt)
        print("  沟通时间 =", repr(g.get("沟通时间")))
        print("  沟通人备注 =", repr(g.get("沟通人备注")))
        print("  沟通时长(分钟) =", repr(g.get("沟通时长(分钟)")))
    except Exception as e:
        print("parse err", e)
    st, txt = req("DELETE", f"/daily-followups/{rid}")
    print("DELETE daily-followups", st, txt[:100])

# home-school-comms 往返
body2 = {
    "沟通主题": "家校验证主题",
    "沟通时间": "2026-08-22T09:05",
    "家长反馈": "家长反馈内容",
    "沟通人备注": "家校沟通人备注",
    "沟通时长(分钟)": "45",
    "沟通明细": "# 家校明细",
    "沟通总结": "家校总结",
}
st, txt = req("POST", "/home-school-comms", body2)
print("CREATE home-school-comms", st, txt[:400])
try:
    rec = json.loads(txt)
    rid2 = rec.get("id")
except Exception:
    rid2 = None
print("NEW_ID_HSC", rid2)
if rid2:
    st, txt = req("GET", f"/home-school-comms/{rid2}")
    print("GET home-school-comms", st, txt[:600])
    try:
        g = json.loads(txt)
        print("  沟通时间 =", repr(g.get("沟通时间")))
        print("  家长反馈 =", repr(g.get("家长反馈")))
        print("  沟通人备注 =", repr(g.get("沟通人备注")))
        print("  沟通时长(分钟) =", repr(g.get("沟通时长(分钟)")))
    except Exception as e:
        print("parse err", e)
    st, txt = req("DELETE", f"/home-school-comms/{rid2}")
    print("DELETE home-school-comms", st, txt[:100])

subprocess.run(["redis-cli", "DEL", f"session:{SID}"], capture_output=True, text=True)
print("VERIFY DONE")
