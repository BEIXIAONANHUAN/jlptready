// ============================================================
// 成就徽章（12 枚）
//
// 持久化：Supabase 表 user_achievements（badge_id 唯一，解锁日期 unlocked_at），
// 跨设备一致。运行时持内存镜像 unlocks，首次 evaluate 时从云端加载。
// 「同步本机数据到云端」按钮（我的数据页）负责把旧 localStorage 数据迁上来。
//
// 「铜墙铁壁」（连续 20 题全对）的连对计数仍在 localStorage（键 n5n2_combo），
// 仅本机运行时状态，丢失无碍、不在迁移范围。
// 由三个做题模块（newwords / review / exam）在每次作答后调用 noteAnswer() 更新，
// 达成时立即解锁并弹祝贺提示；其余徽章在「我的数据」页评估解锁。
// ============================================================
window.Achievements = (function () {
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

  // 内存镜像 { 徽章id: 解锁日期 }；首次使用时从云端加载，解锁时先写内存再异步落库
  let unlocks = {};
  let loaded = false;

  async function load() {
    if (loaded) return;
    try {
      unlocks = await DB.getAchievements();
      loaded = true;
    } catch (e) {
      console.warn('[Achievements] 云端加载失败，按空表处理', e);
    }
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

  function unlock(id) {
    if (unlocks[id]) return false;
    unlocks[id] = DB.todayISO();
    // 先写内存（立即生效），云端异步落库；失败仅告警，徽章条件可再次评估解锁
    DB.unlockAchievement(id).catch((e) => console.warn('[Achievements] 解锁写入失败 ' + id, e));
    const def = DEFS.find((d) => d.id === id);
    if (def) toast(def.name);
    return true;
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
      if (ok) unlock(id);
    }
    return unlocks;
  }

  // 数据迁移后强制重新加载云端徽章（我的数据页的同步按钮调用）
  async function reload() {
    loaded = false;
    await load();
    return unlocks;
  }

  return { DEFS, unlock, noteAnswer, evaluate, reload };
})();
