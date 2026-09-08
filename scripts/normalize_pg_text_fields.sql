-- 修复迁移引入的文本字段富文本数组问题
-- ============================================================
-- 背景：飞书文本字段(type=1)读回为 [{text:"x"}] 数组。迁移时走 BaseClient.fromReadFields
--       （只对 datetime 转换，文本原样返回），于是 PG 的 jsonb 里文本字段存成了数组/对象。
--       显示侧 SqlStore.formatReadValue 用 toText() 还原成字符串（看起来正常），
--       但登录/过滤直接查 data->>'字段' 原始值，精确匹配(is)失败 -> 登录报 NOT_REGISTERED。
-- 修复：把所有 type=1 文本字段的 array/object 形态就地归一化为纯字符串，与 toText 语义一致。
-- 注意：
--   * 仅处理 jsonb_typeof IN ('array','object')，纯字符串/空值不动 -> 可重复执行
--   * 不动 datetime/单选/多选/关联等其它类型
--   * 执行前务必先 pg_dump 备份（见同目录说明）
-- ============================================================

DO $$
DECLARE
  t record;
  f record;
  n integer;
BEGIN
  FOR t IN SELECT table_id, sql_table FROM acms_tables LOOP
    FOR f IN SELECT name FROM acms_fields WHERE table_id = t.table_id AND type = 1 LOOP
      EXECUTE format(
        'UPDATE %I SET data = jsonb_set(data, ARRAY[%L], to_jsonb(
           COALESCE(
             CASE jsonb_typeof(data->%2$L)
               WHEN ''array'' THEN (SELECT string_agg(COALESCE(x->>''text'', ''''), '''') FROM jsonb_array_elements(data->%2$L) x)
               WHEN ''object'' THEN data->%2$L->>''text''
               ELSE data->>%2$L
             END, '''')
         )) WHERE jsonb_typeof(data->%2$L) IN (''array'',''object'')',
        t.sql_table, f.name);
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n > 0 THEN
        RAISE NOTICE 'normalized %I.%L rows=%', t.sql_table, f.name, n;
      END IF;
    END LOOP;
  END LOOP;
END $$;
