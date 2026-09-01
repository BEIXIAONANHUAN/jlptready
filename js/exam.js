// ============================================================
// 周末考试（仅周六、周日开放）
//
// 规则：
// - 每天 60 题，四选一，题型与平时一致（读音/写法/释义随机混合，每词 1 题）。
// - 题目构成：50 道薄弱词（wrong_count>0 或 weak_reason 非空，优先 wrong_count 高的）
//   + 10 道已掌握词（mastered，随机）。薄弱词不足 50 时用 learning 词补足，
//   再不足用 mastered 词补足；mastered 不足 10 个则全用。所有题完全随机穿插。
// - 考试没有重练：每题一次作答机会，答错多停留一会看清答案。
// - 答错的词：weak_reason='周末考试做错'、wrong_count+1（mastered 词不降级，
//   只进薄弱词池口径）；答对不写库。
// - 评分：score = 正确率（0–100 整数），评级 S≥95 / A≥85 / B≥70 / C<70，
//   写入 daily_logs 当天的 test_score、test_rating。
// - 会话存 localStorage（键 n5n2_exam_session）：中途退出可续考，
//   当天完成后重进显示成绩页，一天只考一次。
// ============================================================
window.Exam = (function () {
  const LS_KEY = 'n5n2_exam_session';
  const EXAM_SIZE = 60;
  const WEAK_TARGET = 50;
  const MASTERED_TARGET = 10;
  const MS_CORRECT = 450;
  const MS_WRONG = 1400; // 考试无重练，答错停留稍久看清正确答案
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

  function loadSession() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_KEY));
      if (s && s.date === DB.todayISO() && Array.isArray(s.items)) session = s;
      else session = null; // 考试按天作废，不跨天续考
    } catch (e) { session = null; }
  }
  function saveSession() {
    if (!session) return;
    session.lastTick = Date.now();
    try { localStorage.setItem(LS_KEY, JSON.stringify(session)); } catch (e) { console.warn('[Exam] 存档失败', e); }
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

    const rows = [...weakSide, ...masteredSide];
    if (!rows.length) {
      session = { date: DB.todayISO(), stage: 'empty', items: [], queue: [], stats: { answered: 0, correct: 0 }, elapsedMs: 0, lastTick: Date.now(), persisted: true };
      return;
    }

    const words = await DB.getWordsByIds(rows.map((r) => r.word_id));
    const byId = {};
    for (const w of words) byId[w.id] = w;

    const items = [];
    const queue = [];
    rows.forEach((uw, i) => {
      const word = byId[uw.word_id];
      if (!word) return;
      const idx = items.length;
      items.push({ uw, word });
      queue.push({ i: idx, type: pickType(word) });
    });
    shuffle(queue); // 完全随机穿插

    const pool = await DB.getDistractorPool();

    pendingWrites = [];
    session = {
      date: DB.todayISO(),
      stage: 'start',
      items, queue, pool,
      stats: { answered: 0, correct: 0 },
      elapsedMs: 0, lastTick: Date.now(),
      persisted: false,
      score: null, rating: null,
    };
  }

  // 每词随机 1 种题型（纯假名词只有释义题）
  function pickType(w) {
    const valid = w.word === w.reading ? ['meaning'] : ['reading', 'writing', 'meaning'];
    return valid[Math.floor(Math.random() * valid.length)];
  }

  // ---------- 入口 ----------
  async function enter() {
    const body = $('exam-body');
    if (!body) return;

    if (!isWeekend()) {
      body.innerHTML = '<div class="placeholder">周末考试仅周六、周日开放</div>';
      return;
    }

    loadSession();
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
        <div class="summary-score"><span class="num">${session.items.length}</span> 题</div>
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

  // 四选一选项：干扰项优先同 level、同词性，互不重复且不等于正确答案
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
        <span>第 <span class="num">${session.stats.answered + 1}</span>/<span class="num">${session.items.length}</span> 题</span>
        <span>答对 <span class="num">${session.stats.correct}</span></span>
      </div>
      <div class="quiz-card" id="quiz-card">
        <div class="quiz-type">${TYPE_LABEL[q.type]} · ${hint}</div>
        ${promptHtml}
        <div class="options">${optsHtml}</div>
      </div>`;

    document.querySelectorAll('#exam-body .option').forEach((el) => {
      el.addEventListener('click', () => answer(Number(el.dataset.idx)));
    });
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
      //（mastered 词不降级，只记薄弱标记）
      pendingWrites.push(
        DB.updateUserWord(item.uw.id, {
          weak_reason: '周末考试做错',
          wrong_count: (item.uw.wrong_count || 0) + 1,
        }).catch((e) => console.error('[Exam] 写库失败 word_id=' + item.uw.word_id, e))
      );
    }
    session.queue.shift();
    saveSession(); // 每题存档，中途退出可续考

    setTimeout(() => {
      inputLock = false;
      tick();
      renderQuiz();
    }, correct ? MS_CORRECT : MS_WRONG);
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
    const total = session.items.length;
    const wrong = session.stats.answered - session.stats.correct;
    const mins = Math.max(1, Math.round(session.elapsedMs / 60000));

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
          <div class="done-item"><div class="done-num num">${mins}</div><div class="done-label">用时（分钟）</div></div>
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

  return { enter };
})();
