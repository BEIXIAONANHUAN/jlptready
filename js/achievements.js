// ============================================================
// 成就徽章（12 枚）
//
// 持久化方案：localStorage（键 n5n2_achievements，{ 徽章id: 解锁日期 }）。
// 单用户场景下不加数据库表最简可靠；徽章条件每次进「我的数据」时按数据库
// 实况重新判定，已解锁的永久保留（例如 streak 断了也不回收「七日之火」）。
//
// 「铜墙铁壁」（连续 20 题全对）的连对计数存在 localStorage（键 n5n2_combo），
// 由三个做题模块（newwords / review / exam）在每次作答后调用 noteAnswer() 更新，
// 达成时立即解锁并弹祝贺提示；其余徽章在「我的数据」页评估解锁。
// ============================================================
window.Achievements = (function () {
  const LS_KEY = 'n5n2_achievements';
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

  function getUnlocks() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveUnlocks(m) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(m)); } catch (e) { /* 忽略 */ }
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
    const map = getUnlocks();
    if (map[id]) return false;
    map[id] = DB.todayISO();
    saveUnlocks(map);
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

  // 在「我的数据」页评估全部徽章条件，返回最新的解锁表
  // ctx: { logs, streak, masteredTotal, levelStats: {N5:{total,mastered},...} }
  function evaluate(ctx) {
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
    return getUnlocks();
  }

  return { DEFS, getUnlocks, unlock, noteAnswer, evaluate };
})();
