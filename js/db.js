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

  // ---------- 成就徽章（云端表 user_achievements） ----------
  // 已解锁徽章 → { 徽章id: 解锁日期 'YYYY-MM-DD' }
  async function getAchievements() {
    const { data, error } = await client.from('user_achievements').select('badge_id,unlocked_at');
    if (error) throw error;
    const map = {};
    for (const r of data || []) map[r.badge_id] = String(r.unlocked_at || '').slice(0, 10);
    return map;
  }

  // 解锁（幂等，只插不改）：badge_id 有唯一约束，重复解锁被 23505 兜底拦截。
  // date 可传历史日期（修复用）；绝不 UPDATE 已有记录的 unlocked_at。
  async function unlockAchievement(badgeId, date) {
    const { error } = await client.from('user_achievements')
      .insert({ badge_id: badgeId, unlocked_at: date || todayISO() });
    if (error) {
      if (error.code === '23505') return false; // 已解锁
      throw error;
    }
    return true;
  }

  // 清空并重建徽章表（一次性修复用）：rows = [{ badge_id, unlocked_at }]
  async function replaceAchievements(rows) {
    const { error: e1 } = await client.from('user_achievements').delete().neq('badge_id', '');
    if (e1) throw e1;
    if (rows && rows.length) {
      const { error: e2 } = await client.from('user_achievements').insert(rows);
      if (e2) throw e2;
    }
  }

  // ---------- 断点续学（云端 user_session_progress，按 date + module_type 一行） ----------
  // queue_snapshot 存完整会话对象（jsonb）；current_index/correct_count/wrong_count
  // 是进度指示字段，首页卡片展示用，不必解析整个快照
  async function getSessionProgress(moduleType, date) {
    const { data, error } = await client.from('user_session_progress')
      .select('*').eq('module_type', moduleType).eq('date', date).maybeSingle();
    if (error) throw error;
    return data || null;
  }

  // 保存断点：当天该模块已有记录则更新，没有则插入（不依赖唯一约束）
  async function saveSessionProgress(moduleType, date, patch) {
    const upd = await client.from('user_session_progress')
      .update(patch).eq('module_type', moduleType).eq('date', date).select('id');
    if (upd.error) throw upd.error;
    if (upd.data && upd.data.length) return;
    const { error } = await client.from('user_session_progress')
      .insert({ module_type: moduleType, date, ...patch });
    if (error) throw error;
  }

  async function deleteSessionProgress(moduleType, date) {
    const { error } = await client.from('user_session_progress')
      .delete().eq('module_type', moduleType).eq('date', date);
    if (error) throw error;
  }

  // 迁移/合并：本机 localStorage（徽章 + 3 个会话断点）与云端双向合并。
  // force=false（默认）：徽章取并集、日期早者胜，只 INSERT 云端缺的，绝不改云端已有日期；
  // 断点仅补缺（该日期该模块云端已有记录则跳过）。
  // force=true（需用户二次确认）：本机为准，徽章清空重插、断点覆盖。
  // 合并结果写回本机徽章镜像。返回 { badges, sessions }。
  async function migrateLocalData(force) {
    const LS = {
      ach: 'n5n2_achievements',
      new: 'n5n2_newwords_session',
      review: 'n5n2_review_session',
      exam: 'n5n2_exam_session',
    };
    let localBadges = {};
    try { localBadges = JSON.parse(localStorage.getItem(LS.ach)) || {}; } catch (e) { /* 忽略 */ }
    const cloud = await getAchievements();
    const report = { badges: 0, sessions: 0 };

    if (force) {
      const rows = Object.entries(localBadges).map(([badge_id, d]) => ({ badge_id, unlocked_at: d }));
      await replaceAchievements(rows);
      report.badges = rows.length;
    } else {
      for (const [badgeId, date] of Object.entries(localBadges)) {
        if (!cloud[badgeId]) {
          await unlockAchievement(badgeId, date); // 云端缺的才补，日期取本机值
          report.badges++;
        }
      }
    }

    // 三个模块的断点：按会话自带日期落库
    for (const mt of ['new', 'review', 'exam']) {
      let s = null;
      try { s = JSON.parse(localStorage.getItem(LS[mt])); } catch (e) { /* 忽略 */ }
      if (!s || !s.date) continue;
      const existing = await getSessionProgress(mt, s.date);
      if (existing && !force) continue;
      if (existing && force) await deleteSessionProgress(mt, s.date);
      const st = s.stats || {};
      const answered = st.qAnswered != null ? st.qAnswered : (st.answered || 0);
      const correct = st.qCorrect != null ? st.qCorrect : (st.correct || 0);
      const { error } = await client.from('user_session_progress').insert({
        module_type: mt,
        date: s.date,
        status: (s.stage === 'done' || s.finished) ? 'completed' : 'in_progress',
        queue_snapshot: s,
        current_index: answered,
        correct_count: correct,
        wrong_count: answered - correct,
      });
      if (error) throw error;
      report.sessions++;
    }

    // 回写合并后的徽章镜像到本机（早者胜）
    const merged = { ...cloud };
    for (const [badgeId, date] of Object.entries(localBadges)) {
      if (!merged[badgeId] || date < merged[badgeId]) merged[badgeId] = date;
    }
    try { localStorage.setItem(LS.ach, JSON.stringify(merged)); } catch (e) { /* 忽略 */ }
    return report;
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

  // 更新当天日志的 new_words_count：在当天已有值上累加（不是覆盖），没有则新建。
  // 正常流程每天只会完成一次新词，累加是对"同一天重复完成"的保底口径。
  async function upsertDailyLogNewWords(date, count) {
    const { data, error } = await client.from('daily_logs').select('id,new_words_count').eq('date', date).maybeSingle();
    if (error) throw error;
    if (data) {
      const { error: e } = await client.from('daily_logs')
        .update({ new_words_count: (data.new_words_count || 0) + count }).eq('date', date);
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

  // 复习完成后写入日志：review_count 在当天已有值上累加，review_acc 记录本次做题正确率。
  // acc 传 null（纯翻卡场次、没有做题词）时只累加 review_count，
  // 不覆盖当天已有的 review_acc，避免把真实的做题正确率刷成 100%。
  async function addReviewResult(date, wordsCount, acc) {
    const log = await getDailyLog(date);
    if (log) {
      const fields = { review_count: (log.review_count || 0) + wordsCount };
      if (acc != null) fields.review_acc = acc;
      const { error } = await client.from('daily_logs').update(fields).eq('date', date);
      if (error) throw error;
    } else {
      const row = { date, review_count: wordsCount };
      if (acc != null) row.review_acc = acc;
      const { error } = await client.from('daily_logs').insert(row);
      if (error) throw error;
    }
  }

  // ---------- 周末考试 + 错题本（第 5 步） ----------

  // 薄弱词池：wrong_count>0 或 weak_reason 非空，按做错次数降序。
  // 传 limit：只取前 N（周末考试组卷用）；不传：分页拉全量（错题本列表用，
  // 避免薄弱词超 1000 后静默截断）
  async function getWeakRows(limit) {
    if (limit) {
      const { data, error } = await client
        .from('user_words')
        .select('*')
        .or('wrong_count.gt.0,weak_reason.not.is.null')
        .order('wrong_count', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data;
    }
    const PAGE = 1000;
    const out = [];
    let from = 0;
    while (true) {
      const { data, error } = await client
        .from('user_words')
        .select('*')
        .or('wrong_count.gt.0,weak_reason.not.is.null')
        .order('wrong_count', { ascending: false })
        .order('id')
        .range(from, from + PAGE - 1);
      if (error) throw error;
      for (const r of data) out.push(r);
      if (data.length < PAGE) return out;
      from += PAGE;
    }
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

  // 当天做题统计累加（quiz_correct / quiz_total）：新词、复习、周末考试
  // 各自把本场「全部作答（含重练）」的正确数与总题数累加进去。
  // 分享卡片的当天正确率 = quiz_correct / quiz_total，有什么数据算什么。
  async function addQuizStats(date, correct, total) {
    if (!total) return; // 没有作答就不写
    const log = await getDailyLog(date);
    if (log) {
      const { error } = await client
        .from('daily_logs')
        .update({
          quiz_correct: (log.quiz_correct || 0) + correct,
          quiz_total: (log.quiz_total || 0) + total,
        })
        .eq('date', date);
      if (error) throw error;
    } else {
      const { error } = await client.from('daily_logs').insert({ date, quiz_correct: correct, quiz_total: total });
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

  // 已掌握词数（分享卡片的词库进度用）
  async function getMasteredCount() {
    const { count, error } = await client
      .from('user_words')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'mastered');
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
    getWeakRows, getLearningRows, getExamHistory, setExamResult, addQuizStats,
    searchWords, getUserWordByWordId, getUserWordStatsRows, getAllWordLevels, getAllLogs,
    updateDailyLogFields, getMonthLogs, getStudyDaysTotal, getMasteredCount,
    getAchievements, unlockAchievement, replaceAchievements,
    getSessionProgress, saveSessionProgress, deleteSessionProgress, migrateLocalData,
  };
})();
