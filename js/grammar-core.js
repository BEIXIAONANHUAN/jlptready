// ============================================================
// 语法板块共享口径层（第 3 阶段主会话定义，各语法页面只调用、不各自实现）
//
// 内容：
// 1. SRS 状态机（与 js/review.js 逐字平行）：模式 B 阶梯 1/2/4 天、连续 3 次对毕业、
//    模式 A 1/3/7/15/30 档位、答错/模糊/忘记的降级与薄弱池写法。
//    全部为纯函数，返回 user_grammar 字段补丁，由调用方 DB.updateUserGrammar 落库。
// 2. 语法打卡判定（与 js/checkin.js 平行）：只读 daily_logs 的语法列
//    （new_grammar_count / grammar_test_score / grammar_streak）与 user_grammar，
//    绝不动单词列；与 CheckIn 互不调用、互不共享状态。
// 3. 考试评级（与 js/exam.js 一致）：S≥95 / A≥85 / B≥70 / C<70。
// 4. 题库抽题共享工具（按 grammar_id 分组、按题型分类、reviewed 优先）。
//
// 红线：本文件只读写 grammar / user_grammar / grammar_questions 三表
//       和 daily_logs 的 6 个语法新列；不 import 也不调用单词侧模块。
// ============================================================
window.GrammarCore = (function () {
  const INTERVALS = [1, 2, 4];            // 模式 B 艾宾浩斯阶梯（天），同 review.js
  const A_LADDER = [1, 3, 7, 15, 30];     // 模式 A 间隔档位（天），同 review.js
  const NEW_PER_DAY = 6;                  // 每日新语法 6 个（v2.0 §3.2）

  // ---------- 模式 A 档位升降（与 review.js nextRung 同逻辑） ----------
  function nextRung(cur, dir) {
    let i = A_LADDER.indexOf(cur);
    if (i === -1) i = 0;
    i = Math.min(A_LADDER.length - 1, Math.max(0, i + dir));
    return A_LADDER[i];
  }

  // ---------- SRS 字段补丁（纯函数，镜像 review.js 写法） ----------

  // 新学测试通过：进入模式 B 池（status='learning'、count=0、due=明天）
  function newPassFields() {
    return { status: 'learning', mode_b_count: 0, mode_b_due: DB.tomorrowISO() };
  }

  // 新学首次答错：记薄弱（wrong_count 累计、weak_reason='新学答错'）
  function newWrongFields(ug) {
    return { wrong_count: (ug.wrong_count || 0) + 1, weak_reason: '新学答错' };
  }

  // 模式 B 复习作答（镜像 review.js：对 → 阶梯升/毕业；错 → 清零回明天）
  function reviewResultFields(ug, correct) {
    if (correct) {
      const newCount = (ug.mode_b_count || 0) + 1;
      if (newCount >= 3) {
        // 毕业：连续 3 次复习做对 → mastered，进入模式 A 已掌握池
        return {
          status: 'mastered',
          mode_b_count: newCount,
          mode_b_due: null,
          mode_a_interval: 1,
          mode_a_due: DB.tomorrowISO(),
        };
      }
      return { mode_b_count: newCount, mode_b_due: DB.datePlusDays(INTERVALS[newCount - 1]) };
    }
    return {
      mode_b_count: 0,
      mode_b_due: DB.tomorrowISO(),
      wrong_count: (ug.wrong_count || 0) + 1,
      weak_reason: '复习做错',
    };
  }

  // 模式 A 翻卡自评（镜像 review.js）：know 升档 / vague 降档+薄弱（不降级）/ forget 降级回模式 B
  function modeAResultFields(ug, rating) {
    if (rating === 'know') {
      const iv = nextRung(ug.mode_a_interval || 1, +1);
      return { mode_a_interval: iv, mode_a_due: DB.datePlusDays(iv) };
    }
    if (rating === 'vague') {
      const iv = nextRung(ug.mode_a_interval || 1, -1);
      return { mode_a_interval: iv, mode_a_due: DB.datePlusDays(iv), weak_reason: '卡片模糊' };
    }
    // forget
    return {
      status: 'learning',
      mode_b_count: 0,
      mode_b_due: DB.tomorrowISO(),
      mode_a_due: null,
      weak_reason: '卡片忘记',
      wrong_count: (ug.wrong_count || 0) + 1,
    };
  }

  // 考试做错（镜像 exam.js 口径）：wrong_count+1、weak_reason='考试做错'；答对不写库
  function examWrongFields(ug) {
    return { wrong_count: (ug.wrong_count || 0) + 1, weak_reason: '考试做错' };
  }

  // 移出薄弱池（镜像 wrongbook.js 踩坑注释：reason 与 wrong_count 必须一起清零）
  function clearWeakFields() {
    return { weak_reason: null, wrong_count: 0 };
  }

  // 考试评级（与 exam.js ratingOf 一致）
  function ratingOf(score) {
    if (score >= 95) return 'S';
    if (score >= 85) return 'A';
    if (score >= 70) return 'B';
    return 'C';
  }

  // ---------- 题库抽题工具 ----------
  // 把 getGrammarQuestions 的返回按 grammar_id → {continuation:[], context:[], similar:[]} 分组，
  // 每组内 reviewed=true 的排前面（v2.0 §9.3：抽题优先已审题），同优先级内随机。
  function groupQuestions(rows) {
    const map = new Map();
    for (const q of rows) {
      if (!map.has(q.grammar_id)) map.set(q.grammar_id, { continuation: [], context: [], similar: [] });
      const g = map.get(q.grammar_id);
      if (g[q.type]) g[q.type].push(q);
    }
    for (const g of map.values()) {
      for (const arr of Object.values(g)) {
        arr.sort((a, b) => ((b.reviewed ? 1 : 0) - (a.reviewed ? 1 : 0)) || (Math.random() - 0.5));
      }
    }
    return map;
  }

  // ---------- 语法打卡判定（与 checkin.js 平行，只读写 grammar 列） ----------

  // 某天（含）往前数连续达标天数：grammar_streak>0 或 is_rest（休息日不断签，全局共用）
  async function chainEndingAt(dateStr) {
    const rows = await DB.getGrammarStreakRows();
    const map = {};
    for (const r of rows) map[r.date] = r;
    const qualifies = (r) => !!r && (r.grammar_streak > 0 || r.is_rest);

    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const iso = (x) => {
      const mm = String(x.getMonth() + 1).padStart(2, '0');
      const dd = String(x.getDate()).padStart(2, '0');
      return `${x.getFullYear()}-${mm}-${dd}`;
    };
    let n = 0;
    while (qualifies(map[iso(dt)])) {
      n++;
      dt.setDate(dt.getDate() - 1);
    }
    return n;
  }

  // 写 grammar_streak：失败重试一次（口径同 CheckIn.writeStreakWithRetry）
  async function writeStreakWithRetry(date, streak) {
    try {
      await DB.updateDailyLogFields(date, { grammar_streak: streak });
    } catch (e1) {
      console.error('[GrammarCore] grammar_streak 写入失败，正在重试一次', e1);
      await DB.updateDailyLogFields(date, { grammar_streak: streak });
    }
  }

  // 语法自动打卡判定（幂等；永不 throw）。口径：
  //   休息日不打；已打（grammar_streak>0）直接返回；
  //   平日主任务 = new_grammar_count>0；周末主任务 = grammar_test_score 非空；
  //   另需语法 due 清零（模式 B 到期 + 模式 A 到期，语法 FK 保证条目存在，无需再回查）。
  async function maybeCompleteToday() {
    try {
      const today = DB.todayISO();
      const log = await DB.getDailyLog(today);
      if (log && log.is_rest) return { written: false, streak: null };
      if (log && (log.grammar_streak || 0) > 0) return { written: false, streak: log.grammar_streak };

      const isWk = [0, 6].includes(new Date().getDay());
      const mainDone = isWk
        ? !!(log && log.grammar_test_score != null)
        : !!(log && (log.new_grammar_count || 0) > 0);
      if (!mainDone) return { written: false, streak: null };

      const [dueB, dueA] = await Promise.all([DB.getGrammarReviewDueCount(), DB.getGrammarModeADueCount()]);
      if (dueB + dueA > 0) return { written: false, streak: null };

      const chain = await chainEndingAt(DB.datePlusDays(-1));
      const streak = chain + 1;
      await writeStreakWithRetry(today, streak);
      console.log('[GrammarCore] 语法打卡完成，streak =', streak);
      return { written: true, streak };
    } catch (e) {
      console.error('[GrammarCore] 语法打卡判定失败', e);
      return { written: false, streak: null };
    }
  }

  // 加载时补判入口（语法首页 / 语法打卡页）：复用 maybeCompleteToday 全部条件，幂等
  async function ensureTodayCheckedIn() {
    return maybeCompleteToday();
  }

  return {
    INTERVALS, A_LADDER, NEW_PER_DAY, nextRung,
    newPassFields, newWrongFields, reviewResultFields, modeAResultFields,
    examWrongFields, clearWeakFields, ratingOf,
    groupQuestions,
    chainEndingAt, maybeCompleteToday, ensureTodayCheckedIn,
  };
})();
