// ============================================================
// 周末考试（仅周六、周日开放）
//
// 规则：
// - 每天 60 个词，每词随机抽 2 种题型各出 1 题，共 120 题，四选一
//   （纯假名词只有释义题，出 2 道释义题）。
// - 选词构成：50 个薄弱词（wrong_count>0 或 weak_reason 非空，优先 wrong_count 高的）
//   + 10 个已掌握词（mastered，随机）。薄弱词不足 50 时用 learning 词补足，
//   再不足用 mastered 词补足；mastered 不足 10 个时用薄弱词（再拼 learning）补齐差额，
//   保证组卷 60 词（总词池不足 60 的极端情况除外，此时全用）。
// - 120 题整体 Fisher-Yates 洗牌：不分段、同词 2 题不连出，每次组卷重新随机。
// - 考试没有重练：每题一次作答机会，答错显示正确答案与详情卡，点击题目卡继续。
// - 答错的词：weak_reason='周末考试做错'、wrong_count+1（mastered 词不降级，
//   只进薄弱词池口径）；答对不写库。
// - 评分：score = 正确率（0–100 整数），评级 S≥95 / A≥85 / B≥70 / C<70，
//   写入 daily_logs 当天的 test_score、test_rating。
// - 「今天是否已考」的唯一事实来源是 daily_logs.test_score（首页卡片同源）：
//   有分数 → 结算页；快照仅作明细补充与断点续考。会话存 Supabase 表
//   user_session_progress（module_type='exam'）：中途退出可续考——题目队列
//   顺序与已答统计按存档原样恢复，不重新洗牌；跨天作废（按今天日期查询）。
//   当天完成后重进显示成绩页，一天只考一次。
//   旧的 localStorage 断点由「我的数据」页的「同步本机数据到云端」按钮迁移。
// ============================================================
window.Exam = (function () {
  const EXAM_SIZE = 60;
  const WEAK_TARGET = 50;
  const MASTERED_TARGET = 10;
  const RATING_ORDER = { S: 4, A: 3, B: 2, C: 1 };

  let session = null;
  let current = null;    // 当前题 { q, options, answerIdx }
  let inputLock = false;
  let pendingWrites = [];

  // ---------- 小工具 ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  function tick() {
    if (!session) return;
    const now = Date.now();
    const gap = now - (session.lastTick || now);
    if (gap > 0 && gap < 60000) session.elapsedMs += gap;
    session.lastTick = now;
  }
  const isWeekend = () => [0, 6].includes(new Date().getDay());

  // 从云端恢复今天的断点（done 的也恢复——成绩页展示依赖快照里的 score/rating）
  async function loadSession() {
    try {
      const row = await DB.getSessionProgress('exam', DB.todayISO());
      session = row && row.queue_snapshot ? row.queue_snapshot : null;
    } catch (e) {
      session = null;
      console.warn('[Exam] 云端断点读取失败，按无断点处理', e);
    }
  }

  // 断点异步落库（每题存档）：status 跟 stage 走；答错词的待写字段在快照的
  // wronged 里，恢复时幂等补写
  function saveSession() {
    if (!session) return;
    session.lastTick = Date.now();
    const st = session.stats || {};
    // 调用点深拷贝：防 stage 突变后被晚到的 fire-and-forget 写入序列化旧引用
    const snapshot = JSON.parse(JSON.stringify(session));
    DB.saveSessionProgress('exam', session.date, {
      status: session.stage === 'done' ? 'completed' : 'in_progress',
      queue_snapshot: snapshot,
      current_index: st.answered || 0,
      correct_count: st.correct || 0,
      wrong_count: (st.answered || 0) - (st.correct || 0),
    }).catch((e) => console.warn('[Exam] 断点保存失败', e));
  }

  // ---------- 组卷 ----------
  async function createSession() {
    const [weak, learning, mastered] = await Promise.all([
      DB.getWeakRows(200),       // 已按 wrong_count 降序
      DB.getLearningRows(),
      DB.getMasteredPool(),
    ]);

    const pickedIds = new Set();
    const weakSide = [];     // 50 题侧：薄弱 → learning 补 → mastered 补
    const masteredSide = []; // 10 题侧：mastered

    // ① 薄弱词优先 wrong_count 高的，取 50
    for (const r of weak.slice(0, WEAK_TARGET)) {
      weakSide.push(r);
      pickedIds.add(r.word_id);
    }

    // ② 已掌握词随机 10（排除已在薄弱侧的，避免重复出题；不足 10 个全用）
    const masteredCands = shuffle(mastered.filter((r) => !pickedIds.has(r.word_id)));
    for (const r of masteredCands.slice(0, MASTERED_TARGET)) {
      masteredSide.push(r);
      pickedIds.add(r.word_id);
    }

    // ③ 薄弱不足 50 → 用 learning 词补足
    if (weakSide.length < WEAK_TARGET) {
      const fill = shuffle(learning.filter((r) => !pickedIds.has(r.word_id)))
        .slice(0, WEAK_TARGET - weakSide.length);
      for (const r of fill) { weakSide.push(r); pickedIds.add(r.word_id); }
    }

    // ④ 仍不足 → 用剩余 mastered 词补足
    if (weakSide.length < WEAK_TARGET) {
      const fill = masteredCands.filter((r) => !pickedIds.has(r.word_id))
        .slice(0, WEAK_TARGET - weakSide.length);
      for (const r of fill) { masteredSide.push(r); pickedIds.add(r.word_id); }
    }

    // ⑤ 已掌握侧不足 10 → 用薄弱词（再不够拼 learning）补齐差额，保证总数 60。
    // 极端情况：三类词去重后的总池不足 60 时只能全用（无法凭空造词）。
    if (masteredSide.length < MASTERED_TARGET) {
      const fill = shuffle(weak.concat(learning).filter((r) => !pickedIds.has(r.word_id)))
        .slice(0, MASTERED_TARGET - masteredSide.length);
      for (const r of fill) { masteredSide.push(r); pickedIds.add(r.word_id); }
    }

    const rows = [...weakSide, ...masteredSide];
    if (!rows.length) {
      session = { date: DB.todayISO(), stage: 'empty', items: [], queue: [], stats: { answered: 0, correct: 0 }, elapsedMs: 0, lastTick: Date.now(), persisted: true };
      return;
    }

    const words = await DB.getWordsByIds(rows.map((r) => r.word_id));
    const byId = {};
    for (const w of words) byId[w.id] = w;

    // 每词随机抽 2 种题型出 2 题（纯假名词只有释义题，出 2 道释义题），
    // 全部题目混在一起 Fisher-Yates 洗牌：不分薄弱/掌握段、同词 2 题不连出
    const items = [];
    const queue = [];
    rows.forEach((uw) => {
      const word = byId[uw.word_id];
      if (!word) return;
      const idx = items.length;
      items.push({ uw, word });
      pickTypes(word, 2).forEach((type) => queue.push({ i: idx, type }));
    });
    shuffle(queue); // 完全随机穿插

    const pool = await DB.getDistractorPool();

    pendingWrites = [];
    session = {
      date: DB.todayISO(),
      stage: 'start',
      items, queue, pool,
      totalQ: queue.length,
      stats: { answered: 0, correct: 0 },
      wronged: {},   // 已答错词的待写库字段（断点恢复时幂等补写用）
      elapsedMs: 0, lastTick: Date.now(),
      persisted: false,
      score: null, rating: null,
    };
  }

  // 每词随机抽 n 种题型（纯假名词只有释义题，不足 n 种则用释义题补齐）
  function pickTypes(w, n) {
    const valid = w.word === w.reading ? ['meaning'] : ['reading', 'writing', 'meaning'];
    shuffle(valid);
    const types = valid.slice(0, n);
    while (types.length < n) types.push(valid[0]);
    return types;
  }

  // ---------- 入口 ----------
  async function enter() {
    const body = $('exam-body');
    if (!body) return;

    if (!isWeekend()) {
      body.innerHTML = '<div class="placeholder">周末考试仅周六、周日开放</div>';
      return;
    }

    await loadSession();

    // 幂等补写（任何已恢复的会话都做）：上次关闭页面时答错题目的薄弱池写库
    // 可能未落地（绝对值字段，重复写无副作用）
    if (session && session.wronged) {
      pendingWrites = Object.entries(session.wronged).map(([uwId, fields]) =>
        DB.updateUserWord(uwId, fields).catch((e) => console.error('[Exam] 断点补写失败 user_word_id=' + uwId, e))
      );
    }

    // 「今天是否已考」的唯一事实来源：daily_logs.test_score（与首页卡片同一数据源）。
    // 有分数 → 直接结算页；快照缺失的历史考试（如迁移双轨期在旧代码上完成的）
    // 用 daily_logs 的 quiz 统计重建结算数据。
    let log = null;
    try { log = await DB.getDailyLog(DB.todayISO()); } catch (e) { console.warn('[Exam] 今日成绩查询失败', e); }
    if (log && log.test_score != null) {
      if (!session || session.stage !== 'done') {
        // 快照缺失的历史考试：daily_logs 的 quiz_correct/quiz_total 是当天
        // 全模块累计（复习+考试+新词），绝不能当本次考试题数。考试题数固定
        // 60 词 × 2 = 120；答对数由得分反推（分数本身以 test_score 为准）。
        const totalQ = EXAM_SIZE * 2;
        const correct = Math.round(((log.test_score || 0) * totalQ) / 100);
        session = {
          date: DB.todayISO(), stage: 'done', persisted: true, items: [], wronged: {},
          score: log.test_score, rating: log.test_rating,
          totalQ,
          stats: { answered: totalQ, correct },
          elapsedMs: null, // 历史重建数据，无时长记录
        };
      }
      const history = await DB.getExamHistory();
      renderDone(false, null, history);
      return;
    }
    // 快照 done 但 daily_logs 缺分数（上次成绩保存失败）：补写分数后再进结算页，
    // 保证首页卡片与本页状态一致
    if (session && session.stage === 'done') {
      DB.setExamResult(session.date, session.score, session.rating)
        .catch((e) => console.warn('[Exam] 成绩补写失败', e));
      const history = await DB.getExamHistory();
      renderDone(false, null, history);
      return;
    }

    if (session) {
      tick();
      render();
      return;
    }

    body.innerHTML = '<div class="placeholder">正在组卷…</div>';
    try {
      await createSession();
      saveSession();
      render();
    } catch (e) {
      console.error('[Exam] 组卷失败', e);
      body.innerHTML = '<div class="placeholder">加载失败，请检查网络后重新进入</div>';
    }
  }

  function render() {
    tick();
    switch (session.stage) {
      case 'start': renderStart(); break;
      case 'quiz': renderQuiz(); break;
      case 'done': renderDone(); break;
      default: $('exam-body').innerHTML = '<div class="placeholder">还没有可考的内容<br>先在工作日学几天新词吧</div>';
    }
  }

  // ---------- 考前页 ----------
  function renderStart() {
    $('exam-body').innerHTML = `
      <div class="summary-card">
        <div class="summary-head">周末考试</div>
        <div class="summary-score"><span class="num">${session.totalQ || session.items.length}</span> 题</div>
        <div class="preview-tip">50 道薄弱词 + 10 道已掌握词随机穿插，每题只有一次作答机会</div>
        <button class="btn btn-primary" id="btn-start-exam">开始考试</button>
      </div>`;
    $('btn-start-exam').addEventListener('click', () => {
      session.stage = 'quiz';
      saveSession();
      renderQuiz();
    });
  }

  // ---------- 考试做题 ----------
  const TYPE_LABEL = { reading: '读音题', writing: '写法题', meaning: '释义题' };

  // 四选一选项：干扰项优先同 level、同词性，互不重复且不等于正确答案。
  // 读音题/写法题排除 reading 不含任何假名的词（词库里部分片假名词的
  // reading 存的是英文罗马字，如 hamburger，混进选项等于送分）；释义题不受影响。
  function buildOptions(word, type) {
    const field = type === 'reading' ? 'reading' : 'word';
    const seen = new Set([word[field]]);
    const picks = [];
    const tiers = [
      session.pool.filter((p) => p.level === word.level && p.pos === word.pos),
      session.pool.filter((p) => p.level === word.level),
      session.pool,
    ];
    for (const tier of tiers) {
      for (const p of shuffle(tier)) {
        if (picks.length >= 3) break;
        if (type !== 'meaning' && !/[぀-ヿ]/.test(p.reading)) continue;
        const t = p[field];
        if (!t || seen.has(t)) continue;
        seen.add(t);
        picks.push(p);
      }
      if (picks.length >= 3) break;
    }
    return shuffle([word].concat(picks));
  }

  function renderQuiz() {
    const q = session.queue[0];
    if (!q) { finish(); return; }

    const w = session.items[q.i].word;
    const options = buildOptions(w, q.type);
    current = { q, options, answerIdx: options.findIndex((o) => o.id === w.id) };
    inputLock = false;

    let promptHtml, hint;
    if (q.type === 'reading') {
      promptHtml = `<div class="quiz-prompt jp">${esc(w.word)}</div>`;
      hint = '请选择正确的读音';
    } else if (q.type === 'writing') {
      promptHtml = `<div class="quiz-prompt jp">${esc(w.reading)}</div>`;
      hint = '请选择正确的写法';
    } else {
      promptHtml = `<div class="quiz-prompt quiz-prompt-zh">${esc(w.meaning)}</div>`;
      hint = '请选择对应的日语单词';
    }

    const optsHtml = options.map((o, i) => {
      const main = q.type === 'reading' ? o.reading : o.word;
      const sub = q.type === 'meaning' ? `<span class="opt-sub jp">${esc(o.reading)}</span>` : '';
      return `<button class="option" data-idx="${i}"><span class="opt-main jp">${esc(main)}</span>${sub}</button>`;
    }).join('');

    $('exam-body').innerHTML = `
      <div class="quiz-progress">
        <span>第 <span class="num">${session.stats.answered + 1}</span>/<span class="num">${session.totalQ || session.items.length}</span> 题</span>
        <span>答对 <span class="num">${session.stats.correct}</span></span>
      </div>
      <div class="quiz-card" id="quiz-card">
        <div class="quiz-type">${TYPE_LABEL[q.type]} · ${hint}</div>
        ${promptHtml}
        <div class="options">${optsHtml}</div>
        <div class="tap-continue" id="tap-continue" style="display:none">点击继续</div>
      </div>
      <div class="word-detail" id="word-detail" style="display:none"></div>`;

    document.querySelectorAll('#exam-body .option').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (inputLock) return;   // 已作答：不拦截，冒泡到题目卡触发「点击继续」
        e.stopPropagation();     // 未作答：作答，不触发卡片点击
        answer(Number(el.dataset.idx));
      });
    });
    // 作答后点击题目卡任意位置进入下一题
    $('quiz-card').addEventListener('click', proceed);
  }

  function answer(idx) {
    if (inputLock || !current) return;
    inputLock = true;
    tick();

    const q = session.queue[0];
    const item = session.items[q.i];
    const correct = idx === current.answerIdx;
    if (window.Achievements) Achievements.noteAnswer(correct); // 连对计数（铜墙铁壁徽章）

    session.stats.answered++;
    if (correct) session.stats.correct++;

    const optEls = document.querySelectorAll('#exam-body .option');
    const card = $('quiz-card');
    if (correct) {
      optEls[idx].classList.add('correct');
      card.classList.add('pop');
    } else {
      optEls[idx].classList.add('wrong');
      optEls[current.answerIdx].classList.add('correct');
      // 答错的词进薄弱池口径：weak_reason='周末考试做错'、wrong_count+1
      //（mastered 词不降级，只记薄弱标记）。字段入存档，断点恢复时幂等补写。
      session.wronged[item.uw.id] = {
        weak_reason: '周末考试做错',
        wrong_count: (item.uw.wrong_count || 0) + 1,
      };
      pendingWrites.push(
        DB.updateUserWord(item.uw.id, session.wronged[item.uw.id])
          .catch((e) => console.error('[Exam] 写库失败 word_id=' + item.uw.word_id, e))
      );
    }
    session.queue.shift();
    saveSession(); // 每题存档，中途退出可续考

    showDetail(item.word); // 显示单词详情卡，等用户点击题目卡继续（不再自动跳转）
  }

  // 作答后：题目卡下方显示单词详情卡 + 「点击继续」提示（2 秒后淡出，仅提示，点击始终有效）
  function showDetail(w) {
    const card = $('quiz-card');
    card.classList.add('awaiting');
    const tip = $('tap-continue');
    tip.style.display = '';
    setTimeout(() => tip.classList.add('fade'), 2000);

    const kanaOnly = w.word === w.reading; // 纯假名词没有汉字写法，只显示假名
    $('word-detail').innerHTML = `
      <div class="wd-meaning">${esc(w.meaning)}</div>
      <div class="wd-jp jp">${kanaOnly ? esc(w.reading) : `${esc(w.word)}&nbsp;&nbsp;${esc(w.reading)}`}</div>
      ${w.pos ? `<div class="wd-pos">${esc(w.pos)}</div>` : ''}`;
    $('word-detail').style.display = '';
  }

  // 点击题目卡 → 下一题（队列空时 renderQuiz 内部会进收尾）
  function proceed() {
    if (!inputLock || !current) return; // 未作答时点击无效
    inputLock = false;
    current = null;
    tick();
    renderQuiz();
  }

  // ---------- 评分与收尾 ----------
  function ratingOf(score) {
    if (score >= 95) return 'S';
    if (score >= 85) return 'A';
    if (score >= 70) return 'B';
    return 'C';
  }

  async function finish() {
    session.stage = 'done';
    session.score = session.stats.answered ? Math.round((session.stats.correct / session.stats.answered) * 100) : 0;
    session.rating = ratingOf(session.score);
    saveSession();
    renderDone(true);
    await saveResult();
  }

  async function saveResult() {
    try {
      await Promise.all(pendingWrites);
      await DB.setExamResult(session.date, session.score, session.rating);
      // 考试做题统计累加进当天 quiz_correct/quiz_total（quizLogged 防重试重复累加；
      // 失败只告警，不影响考试成绩保存）
      if (!session.quizLogged) {
        try {
          await DB.addQuizStats(session.date, session.stats.correct, session.stats.answered);
          session.quizLogged = true;
        } catch (e) {
          console.warn('[Exam] 做题统计写入失败（不影响成绩保存）', e);
        }
      }
      const history = await DB.getExamHistory();
      session.persisted = true;
      saveSession();
      renderDone(false, null, history);
      if (window.CheckIn) CheckIn.maybeCompleteToday(); // 考试完成 → 尝试自动打卡
    } catch (e) {
      console.error('[Exam] 成绩保存失败', e);
      renderDone(false, '成绩保存失败，请检查网络后点击重试');
    }
  }

  function renderDone(saving, saveError, history) {
    const total = session.totalQ || (session.items && session.items.length) || 0;
    const wrong = session.stats.answered - session.stats.correct;
    // 历史数据（daily_logs 重建）没有用时记录 → 显示 —
    const mins = session.elapsedMs == null ? null : Math.max(1, Math.round(session.elapsedMs / 60000));

    // 历史最高（含今天）
    let bestHtml = '';
    if (!saving && !saveError && history && history.length) {
      let bestScore = -1, bestRating = null;
      for (const h of history) {
        if (h.test_score > bestScore) bestScore = h.test_score;
        if (h.test_rating && (!bestRating || RATING_ORDER[h.test_rating] > RATING_ORDER[bestRating])) bestRating = h.test_rating;
      }
      bestHtml = `<div class="compare-line">历史最高分 <span class="num">${bestScore}</span> <span class="dot">·</span> 历史最高评级 <span class="num">${bestRating}</span></div>`;
    }

    $('exam-body').innerHTML = `
      <div class="summary-card">
        <div class="summary-head">周末考试完成</div>
        <div class="exam-result">
          <div class="exam-score num">${session.score}</div>
          <div class="rating-badge rating-${session.rating}">${session.rating}</div>
        </div>
        <div class="done-grid">
          <div class="done-item"><div class="done-num num">${total}</div><div class="done-label">总题数</div></div>
          <div class="done-item"><div class="done-num num">${session.stats.correct}</div><div class="done-label">答对</div></div>
          <div class="done-item"><div class="done-num num">${wrong}</div><div class="done-label">答错（已入薄弱池）</div></div>
          <div class="done-item"><div class="done-num num">${mins == null ? '—' : mins}</div><div class="done-label">${mins == null ? '用时（历史重建数据，无时长记录）' : '用时（分钟）'}</div></div>
        </div>
        ${bestHtml}
        <div class="done-status">${saveError || (saving ? '正在保存成绩…' : '成绩已保存')}</div>
        ${saveError ? '<button class="btn btn-primary" id="btn-retry-save">重试保存</button>' : ''}
        <button class="btn btn-primary" id="btn-back-home">回首页</button>
      </div>`;
    $('btn-back-home').addEventListener('click', () => { location.hash = '#/'; });
    const retry = $('btn-retry-save');
    if (retry) retry.addEventListener('click', saveResult);
  }

  // 今日宜休时由首页调用：丢弃未完成的会话（内存 + 云端）。
  // 已完成的存档保留——成绩页展示和「一天只考一次」都依赖它。
  function discard() {
    if (session && session.stage !== 'done') session = null;
    (async () => {
      try {
        const row = await DB.getSessionProgress('exam', DB.todayISO());
        if (row && row.status !== 'completed') await DB.deleteSessionProgress('exam', DB.todayISO());
      } catch (e) { console.warn('[Exam] 断点清除失败', e); }
    })();
  }

  return { enter, discard };
})();
