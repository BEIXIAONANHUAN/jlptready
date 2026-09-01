// 数据访问层：封装所有 Supabase 查询
window.DB = (function () {
  const client = window.supabase.createClient(
    window.CONFIG.SUPABASE_URL,
    window.CONFIG.SUPABASE_ANON_KEY
  );

  // ---------- 日期工具（本地时区，不用 toISOString 避免日期偏移） ----------
  function dateISO(d) {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }
  const todayISO = () => dateISO(new Date());
  const tomorrowISO = () => datePlusDays(1);
  // 今天 + n 天（n 可为负数取昨天）
  function datePlusDays(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return dateISO(d);
  }

  // PostgREST 单次最多返回 1000 行，整表拉取需要分页
  async function fetchAll(table, select) {
    const PAGE = 1000;
    const out = [];
    let from = 0;
    while (true) {
      const { data, error } = await client.from(table).select(select).order('id').range(from, from + PAGE - 1);
      if (error) throw error;
      for (const r of data) out.push(r);
      if (data.length < PAGE) return out;
      from += PAGE;
    }
  }

  // ---------- 基础查询（第 1 步） ----------

  // 词库总数（连通性测试用）
  async function getWordTotal() {
    const { count, error } = await client
      .from('words')
      .select('*', { count: 'exact', head: true });
    if (error) throw error;
    return count;
  }

  // 词库中还没有学习记录的词数（备用，数据页会用）
  async function getNewWordCount() {
    const { count: total, error: e1 } = await client
      .from('user_words')
      .select('*', { count: 'exact', head: true });
    if (e1) throw e1;
    if (!total) return getWordTotal();

    const { count, error } = await client
      .from('user_words')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'unlearned');
    if (error) throw error;
    return count;
  }

  // ---------- 复习到期查询（第 3、4 步） ----------

  // 今日待复习数（模式 B）：status='learning' 且 mode_b_due 已到期
  async function getReviewDueCount() {
    const today = todayISO();
    const { count, error } = await client
      .from('user_words')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'learning')
      .lte('mode_b_due', today);
    if (error) throw error;
    return count;
  }

  // 今日模式 A 到期数：status='mastered' 且 mode_a_due 已到期
  async function getModeADueCount() {
    const today = todayISO();
    const { count, error } = await client
      .from('user_words')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'mastered')
      .lte('mode_a_due', today);
    if (error) throw error;
    return count;
  }

  // 模式 B 到期词（user_words 行，按到期日升序）
  async function getModeBDueWords() {
    const today = todayISO();
    const { data, error } = await client
      .from('user_words')
      .select('*')
      .eq('status', 'learning')
      .lte('mode_b_due', today)
      .order('mode_b_due')
      .limit(1000);
    if (error) throw error;
    return data;
  }

  // 模式 A 到期词（卡片自测用，按到期日升序）
  async function getModeADueWords() {
    const today = todayISO();
    const { data, error } = await client
      .from('user_words')
      .select('*')
      .eq('status', 'mastered')
      .lte('mode_a_due', today)
      .order('mode_a_due')
      .limit(1000);
    if (error) throw error;
    return data;
  }

  // 模式 A 池全部 mastered 记录（随机抽检的抽样池，分页拉取）
  async function getMasteredPool() {
    const PAGE = 1000;
    const out = [];
    let from = 0;
    while (true) {
      const { data, error } = await client
        .from('user_words')
        .select('*')
        .eq('status', 'mastered')
        .order('id')
        .range(from, from + PAGE - 1);
      if (error) throw error;
      for (const r of data) out.push(r);
      if (data.length < PAGE) return out;
      from += PAGE;
    }
  }

  // 按 word_id 列表取 user_words 记录（抽检名单恢复用）
  async function getUserWordsByWordIds(wordIds) {
    if (!wordIds.length) return [];
    const { data, error } = await client.from('user_words').select('*').in('word_id', wordIds);
    if (error) throw error;
    return data;
  }

  // 近期日志的 streak/is_rest（连击计算用，新→旧）
  async function getStreakRows() {
    const { data, error } = await client
      .from('daily_logs')
      .select('date,streak,is_rest')
      .order('date', { ascending: false })
      .limit(400);
    if (error) throw error;
    return data;
  }

  // 连续打卡天数：从今天（或昨天）往回数「连续达标」的天数。
  // 达标口径：该天 streak>0（完成当日全部任务时由 CheckIn 写入）或 is_rest（休息日不断签）。
  async function getStreak() {
    const rows = await getStreakRows();
    const map = {};
    for (const r of rows) map[r.date] = r;
    const qualifies = (r) => !!r && (r.streak > 0 || r.is_rest);

    const d = new Date();
    if (!qualifies(map[dateISO(d)])) d.setDate(d.getDate() - 1); // 今天还未达标则从昨天起算
    let streak = 0;
    while (qualifies(map[dateISO(d)])) {
      streak++;
      d.setDate(d.getDate() - 1);
    }
    return streak;
  }

  // ---------- 今日新词（第 2 步） ----------

  // 全部词的 id + 考频权重（每日选词用，约 6582 行，分页拉取）
  const getAllWordIdFreq = () => fetchAll('words', 'id,frequency');

  // 已有学习记录的 word_id 列表
  async function getUserWordIds() {
    const rows = await fetchAll('user_words', 'word_id');
    return rows.map((r) => r.word_id);
  }

  // 按 id 列表取完整词条
  async function getWordsByIds(ids) {
    const { data, error } = await client.from('words').select('*').in('id', ids);
    if (error) throw error;
    return data;
  }

  // 干扰项池：从词库随机偏移位置取 1000 条（出题时优先挑同等级同词性的）
  async function getDistractorPool() {
    const total = await getWordTotal();
    const maxStart = Math.max(0, total - 1000);
    const start = Math.floor(Math.random() * (maxStart + 1));
    const { data, error } = await client
      .from('words')
      .select('id,word,reading,meaning,pos,level')
      .range(start, start + 999);
    if (error) throw error;
    return data;
  }

  // 这批 word_id 里哪些已经有 user_words 记录（防止重复插入）
  async function getExistingUserWordIds(wordIds) {
    if (!wordIds.length) return [];
    const { data, error } = await client.from('user_words').select('word_id').in('word_id', wordIds);
    if (error) throw error;
    return data.map((r) => r.word_id);
  }

  async function insertUserWords(rows) {
    const { error } = await client.from('user_words').insert(rows);
    if (error) throw error;
  }

  // 更新当天日志的 new_words_count：有当天记录就只更新这一个字段，没有则新建
  async function upsertDailyLogNewWords(date, count) {
    const { data, error } = await client.from('daily_logs').select('id').eq('date', date).maybeSingle();
    if (error) throw error;
    if (data) {
      const { error: e } = await client.from('daily_logs').update({ new_words_count: count }).eq('date', date);
      if (e) throw e;
    } else {
      const { error: e } = await client.from('daily_logs').insert({ date, new_words_count: count });
      if (e) throw e;
    }
  }

  // ---------- 今日复习（第 3、4 步） ----------
  // 更新单个 user_words 记录的任意字段
  async function updateUserWord(id, fields) {
    const { error } = await client.from('user_words').update(fields).eq('id', id);
    if (error) throw error;
  }

  // 取某天的日志行（没有返回 null）
  async function getDailyLog(date) {
    const { data, error } = await client.from('daily_logs').select('*').eq('date', date).maybeSingle();
    if (error) throw error;
    return data;
  }

  // 复习完成后写入日志：review_count 在当天已有值上累加，review_acc 记录本次正确率
  async function addReviewResult(date, wordsCount, acc) {
    const log = await getDailyLog(date);
    if (log) {
      const { error } = await client
        .from('daily_logs')
        .update({ review_count: (log.review_count || 0) + wordsCount, review_acc: acc })
        .eq('date', date);
      if (error) throw error;
    } else {
      const { error } = await client.from('daily_logs').insert({ date, review_count: wordsCount, review_acc: acc });
      if (error) throw error;
    }
  }

  // ---------- 周末考试 + 错题本（第 5 步） ----------

  // 薄弱词池：wrong_count>0 或 weak_reason 非空，按做错次数降序
  async function getWeakRows(limit) {
    const { data, error } = await client
      .from('user_words')
      .select('*')
      .or('wrong_count.gt.0,weak_reason.not.is.null')
      .order('wrong_count', { ascending: false })
      .limit(limit || 1000);
    if (error) throw error;
    return data;
  }

  // 学习中的词（考试凑题用）
  async function getLearningRows() {
    const { data, error } = await client.from('user_words').select('*').eq('status', 'learning').limit(1000);
    if (error) throw error;
    return data;
  }

  // 历次考试成绩（算历史最高用）
  async function getExamHistory() {
    const { data, error } = await client
      .from('daily_logs')
      .select('date,test_score,test_rating')
      .not('test_score', 'is', null)
      .order('date', { ascending: false });
    if (error) throw error;
    return data;
  }

  // 写入当天考试成绩（test_score / test_rating）
  async function setExamResult(date, score, rating) {
    const log = await getDailyLog(date);
    if (log) {
      const { error } = await client.from('daily_logs').update({ test_score: score, test_rating: rating }).eq('date', date);
      if (error) throw error;
    } else {
      const { error } = await client.from('daily_logs').insert({ date, test_score: score, test_rating: rating });
      if (error) throw error;
    }
  }

  // ---------- 查单词 + 我的数据（第 6 步） ----------

  // 汉字/假名/中文模糊搜索（最多 50 条）
  async function searchWords(q) {
    const kw = String(q).replace(/[,()%_\\]/g, ' ').trim(); // 去掉 or 语法字符和通配符，防注入
    if (!kw) return [];
    const { data, error } = await client
      .from('words')
      .select('*')
      .or(`word.ilike.%${kw}%,reading.ilike.%${kw}%,meaning.ilike.%${kw}%`)
      .limit(50);
    if (error) throw error;
    return data;
  }

  // 单词的学习记录（查单词详情用，没有返回 null）
  async function getUserWordByWordId(wordId) {
    const { data, error } = await client.from('user_words').select('*').eq('word_id', wordId).maybeSingle();
    if (error) throw error;
    return data;
  }

  // 统计用：全部学习记录的轻量字段
  const getUserWordStatsRows = () => fetchAll('user_words', 'word_id,status,wrong_count,weak_reason');

  // 统计用：全词库 id+level（算等级分布）
  const getAllWordLevels = () => fetchAll('words', 'id,level');

  // 统计用：全部日志
  async function getAllLogs() {
    const { data, error } = await client.from('daily_logs').select('*').order('date');
    if (error) throw error;
    return data;
  }

  // ---------- 打卡 + 宜休（第 7 步） ----------

  // 通用写日志：有当天记录则只更新给定字段，没有则新建
  async function updateDailyLogFields(date, fields) {
    const log = await getDailyLog(date);
    if (log) {
      const { error } = await client.from('daily_logs').update(fields).eq('date', date);
      if (error) throw error;
    } else {
      const { error } = await client.from('daily_logs').insert({ date, ...fields });
      if (error) throw error;
    }
  }

  // 某月全部日志（月历热力图用，year 全年、month 0-based）
  async function getMonthLogs(year, month) {
    const lastDay = new Date(year, month + 1, 0).getDate();
    const mm = String(month + 1).padStart(2, '0');
    const { data, error } = await client
      .from('daily_logs')
      .select('*')
      .gte('date', `${year}-${mm}-01`)
      .lte('date', `${year}-${mm}-${String(lastDay).padStart(2, '0')}`)
      .order('date');
    if (error) throw error;
    return data;
  }

  // 总学习天数（完成打卡的天数，streak>0）
  async function getStudyDaysTotal() {
    const { count, error } = await client
      .from('daily_logs')
      .select('*', { count: 'exact', head: true })
      .gt('streak', 0);
    if (error) throw error;
    return count;
  }

  return {
    todayISO, tomorrowISO, datePlusDays,
    getWordTotal, getNewWordCount, getStreak, getStreakRows,
    getReviewDueCount, getModeADueCount, getModeBDueWords, getModeADueWords,
    getMasteredPool, getUserWordsByWordIds,
    getAllWordIdFreq, getUserWordIds, getWordsByIds, getDistractorPool,
    getExistingUserWordIds, insertUserWords, upsertDailyLogNewWords,
    updateUserWord, getDailyLog, addReviewResult,
    getWeakRows, getLearningRows, getExamHistory, setExamResult,
    searchWords, getUserWordByWordId, getUserWordStatsRows, getAllWordLevels, getAllLogs,
    updateDailyLogFields, getMonthLogs, getStudyDaysTotal,
  };
})();
