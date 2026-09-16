-- 2026-09-17「知识库配置」加「关联用户」字段 + 存量单人归属回填
--
-- 背景：把「知识库配置」从**单人归属**（归属人/归属人ID，2026-09-07 加）改成
--       **多用户关联**（照「邮件账户设置」范式）：一条配置可关联多个用户，
--       被关联的人都能看到它、以及它对应的「我的笔记」；系统管理员看全部。
--
-- 🔴 为什么是 SQL 而不是飞书 API：
--   生产 `SQL_TABLES=*`（见 /opt/acms/.env），**所有表都经 RoutingStore 路由到 PostgreSQL**，
--   飞书 Base 只是历史镜像（`SQL_SHADOW_WRITE=0`，不再同步）。
--   所以字段元数据必须写进 `acms_fields`、数据必须写进 `t_<tableId>` 的 jsonb ——
--   改飞书 Base 对运行时**零影响**（2026-09-17 实测：飞书那边加字段成功了，
--   但接口读到的仍是 PG，schema 里没有该字段）。
--   非 SQL 模式（`SQL_TABLES` 未覆盖该表）才需要走飞书：
--   见 `scripts/add_note_linked_users_field.mjs`。
--
-- 幂等：两条语句都可重复执行（字段按 (table_id,name) 去重；回填跳过已有值的行）。
--
-- 用法：
--   PGPASSWORD=… psql -h 127.0.0.1 -U acms -d acms-prd -v ON_ERROR_STOP=1 -f scripts/sql/note-linked-users.sql

-- ① 字段元数据 -----------------------------------------------------------------
-- 类型 18 = 单向关联；property 里 `multiple: true` **不可省**
-- （只写 table_id 会被飞书拒为 1254089 LinkFieldPropertyError，实测）。
-- ⚠️ property.table_id 必须是**生产真实表 id**：代码里 `USER_TABLE.tableId`
--    是 DEV Base 的 id，会被 TABLE_ID_MAP 重映射成 `tblTV6VAO5x2967y`。
INSERT INTO acms_fields (table_id, field_id, name, type, property)
VALUES ('tblmKQtZ5IOgyhv6', 'fld_notelinkedusr', '关联用户', 18,
        '{"multiple": true, "table_id": "tblTV6VAO5x2967y", "table_name": "系统用户与角色表"}'::jsonb)
ON CONFLICT (table_id, name) DO NOTHING;

-- ② 存量回填：把「归属人ID」（openId）换成「关联用户」（用户 record id 数组）----
-- 只动「关联用户」为空的行 —— 人工加过关联的配置**绝不能被覆盖**。
-- 关联值形态：jsonb 数组存 record id 字符串（与邮件账户表 `["recXXX"]` 一致，
-- 后端 `idsOf()` 兼容数组 / {link_record_ids} / JSON 字符串三种形态）。
UPDATE t_tblmkqtz5iogyhv6 c
SET data = c.data || jsonb_build_object('关联用户', jsonb_build_array(u.id))
FROM t_tbltv6vao5x2967y u
WHERE coalesce(c.data->>'归属人ID', '') <> ''
  AND u.data->>'飞书 Open ID' = c.data->>'归属人ID'
  AND NOT (c.data ? '关联用户');

-- ③ 核对（应输出 总数=17 / 已关联=17；如有「无归属=1+」需人工处理）------------------
SELECT (SELECT count(*) FROM t_tblmkqtz5iogyhv6) AS 总数,
       (SELECT count(*) FROM t_tblmkqtz5iogyhv6 WHERE data ? '关联用户') AS 已关联,
       (SELECT count(*) FROM t_tblmkqtz5iogyhv6 WHERE coalesce(data->>'归属人ID','') = '') AS 无归属;
