#!/usr/bin/env python3
import json, urllib.request, sys

BASE = "http://localhost:3001/api"
TOKEN = open("/tmp/gx_token.txt").read().strip()
BASE_ID = sys.argv[1] if len(sys.argv) > 1 else None

def req(method, path, body=None):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Authorization", "Bearer " + TOKEN)
    r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r) as resp:
            return json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, path, e.read().decode()[:300]); raise

# 1. 选 base
if not BASE_ID:
    bases = req("GET", "/bases")
    bl = bases if isinstance(bases, list) else bases.get("bases", bases.get("items", []))
    BASE_ID = bl[0]["id"]
print("BASE:", BASE_ID)

def make_table(name):
    r = req("POST", f"/tables?baseId={BASE_ID}", {"name": name})
    return r.get("table", r).get("id") if isinstance(r.get("table", r), dict) else r["id"]

def make_field(tid, body):
    r = req("POST", f"/fields?tableId={tid}", body)
    return r["field"]["id"]

def list_fields(tid):
    return req("GET", f"/fields?tableId={tid}")["fields"]

def make_record(tid, fields):
    r = req("POST", f"/records?tableId={tid}", {"fields": fields})
    return r["record"]

# 2. 源（模板）表：客户等级 + 折扣
src = make_table("冒烟_折扣模板表")
sf = list_fields(src)
src_primary = sf[0]["id"]
lvl = make_field(src, {"name": "客户等级", "type": "singleLineText"})
disc = make_field(src, {"name": "折扣", "type": "number", "precision": 2})
# vip 唯一一条 0.8
make_record(src, {src_primary: "VIP政策", lvl: "vip", disc: 0.8})
make_record(src, {src_primary: "普通政策A", lvl: "normal", disc: 1.0})
make_record(src, {src_primary: "普通政策B", lvl: "normal", disc: 0.95})  # normal 两条 → 多匹配不填

# 3. 主表：单号(自动编号规则) + 客户等级 + 推荐折扣(lookup 默认，匹配字段)
main = make_table("冒烟_订单主表")
mf = list_fields(main)
main_primary = mf[0]["id"]
num_f = make_field(main, {
    "name": "单号", "type": "autoNumber",
    "numberRule": {"segments": [
        {"type": "fixed", "text": "ORD-"},
        {"type": "time", "format": "yyyyMMdd"},
        {"type": "counter", "digits": 4, "reset": "never"},
    ]},
})
mlvl = make_field(main, {"name": "客户等级", "type": "singleLineText"})
lookup_cfg = {
    "mode": "lookup",
    "sourceTableId": src,
    "filter": {"kind": "condition", "fieldId": lvl, "op": "is", "value": "",
               "valueType": "field", "valueFieldId": mlvl},
    "valueFieldId": disc,
}
mlookup = make_field(main, {"name": "推荐折扣", "type": "number", "precision": 2,
                            "defaultConfig": lookup_cfg})

# 4. 建记录：vip（唯一命中→0.8 + 单号）
rec1 = make_record(main, {main_primary: "订单1", mlvl: "vip"})
print("REC1 单号 =", rec1["fields"].get(num_f))
print("REC1 推荐折扣 =", rec1["fields"].get(mlookup))
assert rec1["fields"].get(mlookup) == 0.8, "lookup vip 应抓到 0.8"
num1 = rec1["fields"].get(num_f, "")
assert num1.startswith("ORD-") and num1.endswith("0001"), f"编号形态异常: {num1}"

# 5. 建记录：normal（多条命中→不填）
rec2 = make_record(main, {main_primary: "订单2", mlvl: "normal"})
print("REC2 推荐折扣 =", rec2["fields"].get(mlookup), "(应为空/None，多匹配不填)")
assert rec2["fields"].get(mlookup) in (None, "", 0) or rec2["fields"].get(mlookup) is None
num2 = rec2["fields"].get(num_f, "")
print("REC2 单号 =", num2)
assert num2.endswith("0002"), f"计数器应递增: {num2}"

# 6. 编辑期联动：把订单2等级改成 vip → 推荐折扣应重算为 0.8
up = req("PATCH", f"/records/{rec2['id']}?tableId={main}", {"fields": {mlvl: "vip"}})
rec2u = up["record"]
print("REC2 改 vip 后 推荐折扣 =", rec2u["fields"].get(mlookup), "(应重算为 0.8)")
assert rec2u["fields"].get(mlookup) == 0.8, "编辑期 lookup 应重算"

print("\n[OK] 编号生成 + lookup 静态抓取 + 匹配字段 + 编辑期联动 全部通过")
