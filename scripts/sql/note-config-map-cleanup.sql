-- 笔记配置映射表清理（2026-09-17）
--
-- 背景：`t_tblefsixxwzckvb8`（笔记配置映射）用**随机 id** 写入（`base.create()`），
-- 同一篇笔记每被同步一次就多一行；实测 688 行里：
--   · 88 行挂在**已删除的配置**上（`rec_c099fb0b…` 名 1234567、`rec_a3c0ee95…`/`rec_1ce02c3f…` 名 Angela…）
--   · 157 行是同一篇笔记的重复（50 条 ×2、19 条 ×3）
-- 后果：「我的笔记」的「配置名称」列读到哪一行是随机的 —— 命中悬空行时显示成历史配置名
--（Joy 看到 1234567、Angela 看到 Angela Get Note），而筛选下拉里只有**当前**配置名，
-- 于是「按配置名称筛选」一条都筛不出来。
--
-- 代码侧同时已改：`processNote` 改用 `createWithId(笔记ID)`（幂等 upsert），不再产生重复。
--
-- 幂等：可重复执行。第二次执行时已无重复行，DELETE 影响 0 行。
-- 回滚：`CREATE TABLE ... AS SELECT` 的备份表 `bak_notemap_20260917` 保留原样，
--   需要回滚时 `TRUNCATE t_tblefsixxwzckvb8; INSERT INTO t_tblefsixxwzckvb8 SELECT * FROM bak_notemap_20260917;`

BEGIN;

-- ① 备份（已存在则跳过，避免重复执行时覆盖掉最初的快照）
CREATE TABLE IF NOT EXISTS bak_notemap_20260917 AS SELECT * FROM t_tblefsixxwzckvb8;

-- ② 每篇笔记只保留一行：**优先保留配置仍存在的那一行**，其次保留更新时间最新的
WITH ranked AS (
  SELECT m.id,
         ROW_NUMBER() OVER (
           PARTITION BY m.data->>'笔记ID'
           ORDER BY
             (CASE WHEN EXISTS (
                SELECT 1 FROM t_tblmkqtz5iogyhv6 s WHERE s.id = m.data->>'配置ID'
              ) THEN 0 ELSE 1 END),
             COALESCE((m.data->>'更新时间')::bigint, 0) DESC,
             m.id
         ) AS rn
  FROM t_tblefsixxwzckvb8 m
  WHERE COALESCE(m.data->>'笔记ID', '') <> ''
)
DELETE FROM t_tblefsixxwzckvb8 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- ③ 把保留下来的行「配置名称」刷成**当前**名字（显示层已按 配置ID 解析，
--    这一步是为了让遗留兜底路径与导出数据也不再出现历史名）
UPDATE t_tblefsixxwzckvb8 m
SET data = jsonb_set(m.data, '{配置名称}', to_jsonb(s.data->>'配置名称')),
    updated_at = now()
FROM t_tblmkqtz5iogyhv6 s
WHERE s.id = m.data->>'配置ID'
  AND COALESCE(s.data->>'配置名称', '') <> ''
  AND COALESCE(m.data->>'配置名称', '') <> COALESCE(s.data->>'配置名称', '');

COMMIT;

-- 核对（应当输出：总行数 ≈ 不同笔记数；悬空行 0；重复组 0）
--   SELECT count(*) AS 总行数, count(DISTINCT data->>'笔记ID') AS 不同笔记 FROM t_tblefsixxwzckvb8;
--   SELECT count(*) AS 悬空行 FROM t_tblefsixxwzckvb8 m
--     WHERE NOT EXISTS (SELECT 1 FROM t_tblmkqtz5iogyhv6 s WHERE s.id = m.data->>'配置ID');
--   SELECT count(*) AS 重复组 FROM (
--     SELECT data->>'笔记ID' FROM t_tblefsixxwzckvb8 GROUP BY 1 HAVING count(*) > 1) x;
