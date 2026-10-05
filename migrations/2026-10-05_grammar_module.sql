-- ============================================================
-- 语法板块建表 migration（双板块改造 第 2 阶段）
-- 依据：《语法板块设计方案 v2.0》§2.1 + 附录 B、《网站双板块门户设计 v1.0》§4.1
--
-- 执行方式：Supabase Dashboard → SQL Editor → 整段粘贴执行。
-- 全部幂等（IF NOT EXISTS），可重复执行。
-- 注意：若 words / user_words / daily_logs 等现有表启用了 RLS 策略，
--       请为 grammar / user_grammar / grammar_questions 配置相同策略；
--       若现有表未启用 RLS（当前单用户 anon key 直连模式），本文件无需额外处理。
-- ============================================================

-- ---------- B.1 新表：grammar（语法库表，§2.1.1） ----------
CREATE TABLE IF NOT EXISTS grammar (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern      text NOT NULL,              -- 语法条目，如「～ばかりか」（「〜」必须保留）
  meaning      text NOT NULL,              -- 中文释义
  continuation text,                       -- 接续规则，如「名詞＋ばかりか」
  example1     text,                       -- 代表性例句 1（日文）
  example1_zh  text,                       -- 例句 1 中文翻译
  example2     text,                       -- 代表性例句 2（日文）
  example2_zh  text,                       -- 例句 2 中文翻译
  pos          text NOT NULL,              -- 功能分类（主题），100% 映射附录 A 十六主题
  level        text NOT NULL,              -- N5 / N4 / N3 / N2
  theme_order  int NOT NULL,               -- 主题单元学习顺序序号（1–16），每日新学按此推进
  frequency    int DEFAULT 0,              -- 考频权重（预留，MVP 不参与调度）
  created_at   timestamp DEFAULT now()
);

-- ---------- B.2 新表：user_grammar（用户语法进度表，§2.1.2） ----------
-- 与 user_words 逐字对称；薄弱是派生态（wrong_count>0 或 weak_reason 非空），
-- status 不设 'weak'，始终保持 unlearned / learning / mastered。
CREATE TABLE IF NOT EXISTS user_grammar (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grammar_id      uuid NOT NULL REFERENCES grammar(id) UNIQUE,  -- 单用户，unique 约束同 user_words
  status          text DEFAULT 'unlearned',
  mode_b_count    int DEFAULT 0,           -- 模式 B 连续做对次数（0→1→2→3 毕业）
  mode_b_due      date,                    -- 模式 B 下次复习日期
  mode_a_interval int DEFAULT 1,           -- 模式 A 间隔档位（天），毕业置 1
  mode_a_due      date,                    -- 模式 A 下次复习日期
  weak_reason     text,                    -- 新学答错 / 复习做错 / 卡片模糊 / 卡片忘记 / 考试做错
  wrong_count     int DEFAULT 0,           -- 累计做错次数
  created_at      timestamp DEFAULT now(),
  updated_at      timestamp DEFAULT now()
);

-- ---------- B.3 新表：grammar_questions（语法题库表，§2.1.3） ----------
CREATE TABLE IF NOT EXISTS grammar_questions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grammar_id  uuid NOT NULL REFERENCES grammar(id),
  type        text NOT NULL,               -- continuation / context / similar
  question    text NOT NULL,               -- 题干
  question_zh text,                        -- 题干中文翻译（语境填空用）
  options     jsonb NOT NULL,              -- 选项数组，如 ["から","ても","うえに","ので"]
  correct     int NOT NULL,                -- 正确答案索引（0=A, 1=B …）
  explanation text NOT NULL,               -- 解析说明（答错后展示）
  source      text DEFAULT 'auto',         -- auto / manual
  reviewed    boolean DEFAULT false,       -- 人工抽查通过标记
  level       text,                        -- N5 / N4 / N3 / N2（人工辨析题入库时一并写入）
  theme       text,                        -- 主题单元名（16 主题之一）
  bloom_level text,                        -- 布鲁姆层级（人工题元数据）
  difficulty  text,                        -- 难度（人工题元数据）
  created_at  timestamp DEFAULT now()
);

-- ---------- B.4 daily_logs 扩展（语法专用列，nullable 或带 default，不影响现有行） ----------
ALTER TABLE daily_logs ADD COLUMN IF NOT EXISTS new_grammar_count int DEFAULT 0;  -- 今日新学语法数（累加，口径同 new_words_count）
ALTER TABLE daily_logs ADD COLUMN IF NOT EXISTS grammar_test_score int;           -- 语法周末考试得分（可空）
ALTER TABLE daily_logs ADD COLUMN IF NOT EXISTS grammar_test_rating text;         -- 语法周末考试评级 S/A/B/C（可空）
ALTER TABLE daily_logs ADD COLUMN IF NOT EXISTS quiz_grammar_correct int DEFAULT 0; -- 查语法强化自测正确数
ALTER TABLE daily_logs ADD COLUMN IF NOT EXISTS quiz_grammar_total int DEFAULT 0;   -- 查语法强化自测总题数

-- ---------- 语法 streak 平行字段（门户 v1.0 §4.1） ----------
-- 单词 streak 存于 daily_logs.streak，语法同款平行新增 grammar_streak；
-- is_rest 是全局休息日（两板块同时休息），不复制。
ALTER TABLE daily_logs ADD COLUMN IF NOT EXISTS grammar_streak int DEFAULT 0;

-- ---------- B.6 索引 ----------
CREATE INDEX IF NOT EXISTS idx_grammar_level_pos ON grammar(level, pos);
CREATE INDEX IF NOT EXISTS idx_grammar_theme_order ON grammar(theme_order);
CREATE INDEX IF NOT EXISTS idx_user_grammar_b ON user_grammar(status, mode_b_due);
CREATE INDEX IF NOT EXISTS idx_user_grammar_a ON user_grammar(status, mode_a_due);
CREATE INDEX IF NOT EXISTS idx_gq_grammar_type ON grammar_questions(grammar_id, type);
CREATE INDEX IF NOT EXISTS idx_gq_reviewed ON grammar_questions(reviewed);
