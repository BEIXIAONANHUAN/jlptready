// ============================================================
// 成就徽章（12 枚）
//
// 持久化：Supabase 表 user_achievements 为准（badge_id 唯一，解锁日期
// unlocked_at 只增不改），本机 localStorage（键 n5n2_achievements）是镜像缓存。
// 加载时双向合并：云端 ∪ 本机，同一徽章保留更早的日期，差异写回两端——
// 任何设备、任何顺序打开都不会覆盖已有徽章日期。
// 「修复徽章日期」按钮（我的数据页）按 daily_logs 反推历史日期一次性校正。
//
// 「铜墙铁壁」（连续 20 题全对）的连对计数仍在 localStorage（键 n5n2_combo），
// 仅本机运行时状态，丢失无碍、不在迁移范围。
// 由三个做题模块（newwords / review / exam）在每次作答后调用 noteAnswer() 更新，
// 达成时立即解锁并弹祝贺提示；其余徽章在「我的数据」页评估解锁。
// ============================================================
window.Achievements = (function () {
  const LS_KEY = 'n5n2_achievements';     // 本机镜像（合并语义，不是唯一数据源）
  const COMBO_KEY = 'n5n2_combo';

  const DEFS = [
    { id: 'first_day',    name: '初出茅庐',  desc: '完成首日学习' },
    { id: 'streak7',      name: '七日之火',  desc: '连续打卡 7 天' },
    { id: 'streak30',     name: '一月筑基',  desc: '连续打卡 30 天' },
    { id: 'streak100',    name: '百日成钢',  desc: '连续打卡 100 天' },
    { id: 'perfect_once', name: '百发百中',  desc: '单次测试 100% 正确' },
    { id: 'day100',       name: '一日千里',  desc: '单日学习 100+ 词' },
    { id: 'combo20',      name: '铜墙铁壁',  desc: '连续 20 题全对' },
    { id: 'mastered1000', name: '词汇破千',  desc: '累计掌握 1000 词' },
    { id: 'n4_clear',     name: 'N4 通关',   desc: 'N4 词库全部掌握' },
    { id: 'n3_clear',     name: 'N3 通关',   desc: 'N3 词库全部掌握' },
    { id: 'n2_clear',     name: 'N2 征服者', desc: 'N2 词库全部掌握' },
    { id: 'perfect10',    name: '满分王者',  desc: '累计 10 次考试满分' },
  ];

  // 内存镜像 { 徽章id: 解锁日期 }；首次使用时云端+本机合并加载
  let unlocks = {};
  let loaded = false;

  // ---------- 本机镜像 ----------
  function readLocal() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveLocal(map) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(map)); } catch (e) { /* 忽略 */ }
  }
  // 并集合并：同一徽章保留更早的 unlocked_at
  function mergeUnlocks(a, b) {
    const out = { ...a };
    for (const [id, date] of Object.entries(b)) {
      if (!out[id] || date < out[id]) out[id] = date;
    }
    return out;
  }

  async function load() {
    if (loaded) return;
    let cloud = {};
    try { cloud = await DB.getAchievements(); } catch (e) { console.warn('[Achievements] 云端加载失败，先按本机镜像', e); }
    const local = readLocal();
    unlocks = mergeUnlocks(local, cloud);
    // 差异写回（只增不改）：云端缺的按本机日期补插；本机缺的/日期更晚的校正为更早值
    let dirty = false;
    for (const [id, date] of Object.entries(unlocks)) {
      if (!cloud[id]) DB.unlockAchievement(id, date).catch((e) => console.warn('[Achievements] 云端回补失败 ' + id, e));
      if (!local[id] || local[id] !== date) dirty = true;
    }
    if (dirty) saveLocal(unlocks);
    loaded = true;
  }

  function getCombo() {
    return parseInt(localStorage.getItem(COMBO_KEY) || '0', 10) || 0;
  }

  // 克制的琥珀色祝贺弹窗：底部滑入，2.8 秒后消失
  function toast(name) {
    const el = document.createElement('div');
    el.className = 'ach-toast';
    el.innerHTML = `<span class="ach-toast-title">解锁成就</span><span class="ach-toast-name">${name}</span>`;
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('show'), 10);
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 400);
    }, 2800);
  }

  // 全部成就的唯一触发入口（evaluate 的 12 项条件 + noteAnswer 的连对）：
  // 内存判重 + 云端插入判重，任何一层表明已解锁都不弹窗；插入成功才算新解锁。
  // 云端已有而内存没有（本机镜像缺失/其他设备解锁过）：以云端为准回补内存，绝不改日期。
  async function unlock(id) {
    await load(); // 内存须先与云端/本机合并，空档不会把已解锁误判成未解锁
    if (unlocks[id]) return false;
    let inserted = null;
    try {
      inserted = await DB.unlockAchievement(id);
    } catch (e) {
      console.warn('[Achievements] 解锁写入失败 ' + id, e); // 离线等情况按成功处理（内存已记，云端可后补）
    }
    if (inserted === false) {
      try { unlocks = mergeUnlocks(unlocks, await DB.getAchievements()); saveLocal(unlocks); } catch (e) { /* 忽略 */ }
      return false;
    }
    unlocks[id] = DB.todayISO();
    saveLocal(unlocks);
    const def = DEFS.find((d) => d.id === id);
    if (def) toast(def.name);
    return true;
  }

  // 一次性修复：徽章日期被错误覆盖（如全部记成同一天）时，按 daily_logs 反推
  // 真实解锁日期，清空云端重插正确值，并同步本机镜像与内存。
  // 规则：first_day=最早学习日；combo20=最早有做题记录的日期；perfect_once=最早
  // 考试满分日；streak7=streak 首次≥7 的日期。返回修好的 { 徽章id: 日期 }。
  async function restoreDates() {
    await load();
    const logs = await DB.getAllLogs(); // 按日期升序
    const fixed = {};
    if (logs.length) fixed.first_day = logs[0].date;
    const withQuiz = logs.find((l) => (l.quiz_total || 0) > 0);
    if (withQuiz) fixed.combo20 = withQuiz.date;
    const perfect = logs.find((l) => l.test_score === 100);
    if (perfect) fixed.perfect_once = perfect.date;
    const s7 = logs.find((l) => (l.streak || 0) >= 7);
    if (s7) fixed.streak7 = s7.date;
    if (!Object.keys(fixed).length) return fixed;

    const rows = Object.entries(fixed).map(([badge_id, d]) => ({ badge_id, unlocked_at: d }));
    await DB.replaceAchievements(rows);
    unlocks = mergeUnlocks(unlocks, fixed); // 修复值都是更早的真实日期，覆盖错误值
    saveLocal(unlocks);
    return fixed;
  }

  // 每次作答后调用（correct=本次是否答对）：维护连对计数，达成即解锁
  function noteAnswer(correct) {
    const combo = correct ? getCombo() + 1 : 0;
    try { localStorage.setItem(COMBO_KEY, String(combo)); } catch (e) { /* 忽略 */ }
    if (combo >= 20) unlock('combo20');
  }

  // 在「我的数据」页评估全部徽章条件，返回最新的解锁表（内存镜像）
  // ctx: { logs, streak, masteredTotal, levelStats: {N5:{total,mastered},...} }
  async function evaluate(ctx) {
    await load();
    const { logs, streak, masteredTotal, levelStats } = ctx;
    const cleared = (lv) => levelStats[lv] && levelStats[lv].total > 0 && levelStats[lv].mastered >= levelStats[lv].total;

    const checks = {
      first_day: logs.some((l) => (l.new_words_count || 0) > 0 || (l.review_count || 0) > 0),
      streak7: streak >= 7,
      streak30: streak >= 30,
      streak100: streak >= 100,
      // 单次测试 100%：复习正确率或周末考试分数任一满分
      perfect_once: logs.some((l) => l.review_acc === 100 || l.test_score === 100),
      day100: logs.some((l) => (l.new_words_count || 0) >= 100),
      combo20: getCombo() >= 20, // 实时解锁在 noteAnswer，这里兜底补判
      mastered1000: masteredTotal >= 1000,
      n4_clear: cleared('N4'),
      n3_clear: cleared('N3'),
      n2_clear: cleared('N2'),
      // 满分王者：累计 10 次周末考试满分（test_score=100）
      perfect10: logs.filter((l) => l.test_score === 100).length >= 10,
    };

    for (const [id, ok] of Object.entries(checks)) {
      if (ok) await unlock(id);
    }
    return unlocks;
  }

  // 数据迁移后强制重新加载云端徽章（我的数据页的同步按钮调用）
  async function reload() {
    loaded = false;
    await load();
    return unlocks;
  }

  return { DEFS, unlock, noteAnswer, evaluate, reload, restoreDates };
})();
