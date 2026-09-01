// ============================================================
// 今日新词（强制做题）
// 流程：新词预览 → 分组做题（5 组 × 10 词，每词 3 题）→ 组间小结 → 当日总结
//
// 持久化：当日会话整体存在 localStorage（键 n5n2_newwords_session），
// 中途退出后下次点「今日新词」从断点继续；数据库只在当日全部完成时写入一次。
//
// 数据口径：
// - 一个词「通过」= 该词的 3 道题都答对过（答错的题会重新插回当前组的剩余
//   题目里，直到答对才出队）。因为答错必重排，组末不存在"未通过"的词；
//   组间小结里的「一次通过」指 3 题全部一次答对、从未答错的词，
//   答错过的词进入「薄弱词」列表。
// - 完成时写入 user_words：status='learning'，mode_b_count=0，
//   mode_b_due=明天（进入模式 B 待复习池）；答错过的词 wrong_count=答错次数、
//   weak_reason='做题做错'。
//   薄弱词池筛选口径：weak_reason 非空（后续复习模式还会把反复做错的词
//   status 置为 'weak'，两个条件取或即可筛出全部薄弱词）。
// ============================================================
window.NewWords = (function () {
  const LS_KEY = 'n5n2_newwords_session';
  const DAILY_COUNT = 50;   // 每个工作日的新词数量（周末不出新词）
  const GROUP_SIZE = 10;    // 每组词数
  const MS_CORRECT = 550;   // 答对后反馈停留时间
  const MS_WRONG = 1200;    // 答错后停留时间（要展示正确答案，稍长）

  let session = null;   // 当日会话（与 localStorage 同步）
  let current = null;   // 当前题目 { q, options, answerIdx }，不持久化，重进时按队首重建
  let inputLock = false;

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

  // 计时：把距上次操作的时间累进 elapsedMs；超过 60 秒的空档视为离开，不计入
  function tick() {
    if (!session) return;
    const now = Date.now();
    const gap = now - (session.lastTick || now);
    if (gap > 0 && gap < 60000) session.elapsedMs += gap;
    session.lastTick = now;
  }

  function loadSession() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_KEY));
      if (s && s.date && Array.isArray(s.words)) session = s;
    } catch (e) { /* 损坏的存档忽略，重新建会话 */ }
  }
  function saveSession() {
    if (!session) return;
    session.lastTick = Date.now();
    try { localStorage.setItem(LS_KEY, JSON.stringify(session)); } catch (e) { console.warn('[NewWords] 存档失败', e); }
  }

  const isWeekend = () => [0, 6].includes(new Date().getDay());

  // 按 frequency 考频权重不放回随机抽样（高频词更容易被先抽到）
  function weightedSample(items, n) {
    const pool = items.slice();
    const out = [];
    while (out.length < n && pool.length) {
      let total = 0;
      for (const it of pool) total += (it.frequency || 1);
      let r = Math.random() * total;
      let i = 0;
      for (; i < pool.length - 1; i++) { r -= (pool[i].frequency || 1); if (r <= 0) break; }
      out.push(pool.splice(i, 1)[0]);
    }
    return out;
  }

  // 一个词的 3 道题：纯假名词（没有汉字写法）出 3 道释义题，其余按 读音/写法/释义 各一道
  function questionTypesFor(w) {
    return w.word === w.reading ? ['meaning', 'meaning', 'meaning'] : ['reading', 'writing', 'meaning'];
  }

  // 建一组的题目队列：所有词的题混在一起完全打乱（同一词的 3 题不连着出）
  function buildQueue(idxs, words) {
    const q = [];
    for (const i of idxs) {
      questionTypesFor(words[i]).forEach((type, k) => q.push({ w: i, qid: i + '-' + k, type }));
    }
    return shuffle(q);
  }

  // ---------- 建会话 ----------
  async function createSession() {
    const [all, learnedIds] = await Promise.all([DB.getAllWordIdFreq(), DB.getUserWordIds()]);
    const learned = new Set(learnedIds);
    const candidates = all.filter((w) => !learned.has(w.id));

    const picked = weightedSample(candidates, DAILY_COUNT);
    if (!picked.length) {
      session = { date: DB.todayISO(), stage: 'empty', words: [], groups: [], groupIndex: 0, stats: { answered: 0, correct: 0 }, elapsedMs: 0, lastTick: Date.now(), persisted: true, pool: [] };
      return;
    }

    const ids = picked.map((w) => w.id);
    const rows = await DB.getWordsByIds(ids);
    const byId = {};
    for (const r of rows) byId[r.id] = r;
    const words = ids.map((id) => byId[id]).filter(Boolean); // 保持抽选顺序

    const groups = [];
    for (let g = 0; g < words.length; g += GROUP_SIZE) {
      const idxs = [];
      for (let i = g; i < Math.min(g + GROUP_SIZE, words.length); i++) idxs.push(i);
      const qstates = {};
      for (const i of idxs) qstates[i] = { passed: [], wrong: 0 };
      groups.push({ idxs, qstates, queue: buildQueue(idxs, words) });
    }

    const pool = await DB.getDistractorPool();

    session = {
      date: DB.todayISO(),
      stage: 'preview',
      words, groups, groupIndex: 0,
      stats: { answered: 0, correct: 0 },
      elapsedMs: 0, lastTick: Date.now(),
      persisted: false,
      pool,
    };
  }

  // ---------- 入口：路由进入 #/new 时调用 ----------
  async function enter() {
    loadSession();
    const body = $('new-body');
    if (!body) return;

    if (isWeekend()) {
      body.innerHTML = '<div class="placeholder">周末不出新词<br>回首页参加「周末考试」吧</div>';
      return;
    }

    if (session && session.stage === 'done') {
      if (session.date === DB.todayISO()) {
        // 今天已完成：若上次关闭时成绩没存上，补一次保存
        if (session.persisted) renderDone();
        else finishDay();
        return;
      }
      session = null; // 更早某天已完成的会话，开始新的一天
    }
    if (session) { tick(); render(); return; } // 断点续学（preview / quiz / summary / empty）

    body.innerHTML = '<div class="placeholder">正在准备今日新词…</div>';
    try {
      await createSession();
      saveSession();
      render();
    } catch (e) {
      console.error('[NewWords] 建会话失败', e);
      body.innerHTML = '<div class="placeholder">词库加载失败，请检查网络后重新进入</div>';
    }
  }

  function render() {
    tick();
    switch (session.stage) {
      case 'preview': renderPreview(); break;
      case 'quiz': renderQuiz(); break;
      case 'summary': renderSummary(); break;
      case 'done': renderDone(); break;
      default: $('new-body').innerHTML = '<div class="placeholder">词库已全部学完</div>';
    }
  }

  // ---------- 步骤 1：新词预览 ----------
  function renderPreview() {
    const rows = session.words.map((w) => `
      <div class="wrow">
        <span class="wrow-word jp">${esc(w.word)}</span>
        <span class="wrow-reading jp">${esc(w.reading)}</span>
        <span class="wrow-pos">${esc(w.pos || '')}</span>
        <span class="wrow-meaning">${esc(w.meaning)}</span>
      </div>`).join('');
    $('new-body').innerHTML = `
      <div class="preview-tip">今日 <span class="num">${session.words.length}</span> 个新词，先浏览一遍，准备好了再开始测试</div>
      <div class="wtable">${rows}</div>
      <div class="cta-bar"><div class="cta-inner">
        <button class="btn btn-danger" id="btn-start-test">开始测试</button>
      </div></div>`;
    $('btn-start-test').addEventListener('click', () => {
      session.stage = 'quiz';
      saveSession();
      render();
    });
  }

  // ---------- 步骤 2：分组做题 ----------
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
    const g = session.groups[session.groupIndex];
    if (!g || !g.queue.length) { session.stage = 'summary'; saveSession(); render(); return; }

    const q = g.queue[0];
    const w = session.words[q.w];
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

    $('new-body').innerHTML = `
      <div class="quiz-progress">
        <span>第 <span class="num">${session.groupIndex + 1}</span>/<span class="num">${session.groups.length}</span> 组</span>
        <span>本组剩余 <span class="num">${g.queue.length}</span> 题</span>
      </div>
      <div class="quiz-card" id="quiz-card">
        <div class="quiz-type">${TYPE_LABEL[q.type]} · ${hint}</div>
        ${promptHtml}
        <div class="options">${optsHtml}</div>
      </div>`;

    document.querySelectorAll('#new-body .option').forEach((el) => {
      el.addEventListener('click', () => answer(Number(el.dataset.idx)));
    });
  }

  function answer(idx) {
    if (inputLock || !current) return;
    inputLock = true;
    tick();

    const g = session.groups[session.groupIndex];
    const q = g.queue[0];
    const st = g.qstates[q.w];
    const correct = idx === current.answerIdx;

    session.stats.answered++;
    if (window.Achievements) Achievements.noteAnswer(correct); // 连对计数（铜墙铁壁徽章）
    const optEls = document.querySelectorAll('#new-body .option');
    const card = $('quiz-card');

    if (correct) {
      session.stats.correct++;
      if (!st.passed.includes(q.qid)) st.passed.push(q.qid);
      g.queue.shift();
      optEls[idx].classList.add('correct');
      card.classList.add('pop'); // 卡片轻微上浮 + 绿色边框
    } else {
      st.wrong++;
      // 错题重新排队：从队首移除后插回剩余题目的随机位置（不放最前，避免紧挨着重出），直到答对才消失
      g.queue.shift();
      const pos = g.queue.length ? 1 + Math.floor(Math.random() * g.queue.length) : 0;
      g.queue.splice(pos, 0, q);
      optEls[idx].classList.add('wrong');
      optEls[current.answerIdx].classList.add('correct'); // 同时标出正确答案
    }
    saveSession(); // 每答一题都存档，随时退出都能续上

    setTimeout(() => {
      inputLock = false;
      tick();
      if (!g.queue.length) {
        session.stage = 'summary';
        saveSession();
      }
      render();
    }, correct ? MS_CORRECT : MS_WRONG);
  }

  // ---------- 步骤 3：组间小结 ----------
  function renderSummary() {
    const g = session.groups[session.groupIndex];
    const isLast = session.groupIndex >= session.groups.length - 1;
    const clean = [], weak = [];
    for (const i of g.idxs) (g.qstates[i].wrong > 0 ? weak : clean).push(session.words[i]);

    const weakHtml = weak.length
      ? `<div class="weak-title">薄弱词（答错过，完成时会记入薄弱词池）</div>
         <div class="wtable">${weak.map((w) => `
           <div class="wrow">
             <span class="wrow-word jp">${esc(w.word)}</span>
             <span class="wrow-reading jp">${esc(w.reading)}</span>
             <span class="wrow-pos">${esc(w.pos || '')}</span>
             <span class="wrow-meaning">${esc(w.meaning)}</span>
           </div>`).join('')}</div>`
      : '<div class="weak-title">本组没有薄弱词，全部一次通过</div>';

    $('new-body').innerHTML = `
      <div class="summary-card">
        <div class="summary-head">第 <span class="num">${session.groupIndex + 1}</span>/<span class="num">${session.groups.length}</span> 组完成</div>
        <div class="summary-score">一次通过 <span class="num score-em">${clean.length}</span>/<span class="num">${g.idxs.length}</span></div>
        ${weakHtml}
        <div class="summary-btns">
          <button class="btn btn-secondary" id="btn-rest5">休息 5 分钟</button>
          <button class="btn btn-primary" id="btn-next-group">${isLast ? '查看今日总结' : '直接开始下一组'}</button>
        </div>
      </div>`;

    $('btn-rest5').addEventListener('click', () => {
      saveSession(); // 进度已存，回首页；下次点「今日新词」会回到本小结页
      location.hash = '#/';
    });
    $('btn-next-group').addEventListener('click', () => {
      if (isLast) {
        finishDay();
      } else {
        session.groupIndex++;
        session.stage = 'quiz';
        saveSession();
        render();
      }
    });
  }

  // ---------- 步骤 4：当日完成 ----------
  async function finishDay() {
    session.stage = 'done';
    saveSession();
    renderDone(); // 先渲染"正在保存成绩…"
    try {
      await finalize();
      saveSession();
      renderDone();
    } catch (e) {
      console.error('[NewWords] 成绩保存失败', e);
      renderDone('成绩保存失败，请检查网络后点击重试');
    }
  }

  // 完成时唯一一次数据库写入（persisted 标记防止刷新后重复写）
  async function finalize() {
    if (session.persisted) return;

    // 每词答错次数汇总
    const wrongByWord = {};
    for (const g of session.groups) {
      for (const entry of Object.entries(g.qstates)) wrongByWord[entry[0]] = entry[1].wrong;
    }

    // 已有记录的词跳过，防止重复插入
    const ids = session.words.map((w) => w.id);
    const existing = new Set(await DB.getExistingUserWordIds(ids));
    const tomorrow = DB.tomorrowISO();
    const rows = session.words
      .map((w, i) => ({ w, wrong: wrongByWord[i] || 0 }))
      .filter((x) => !existing.has(x.w.id))
      .map((x) => ({
        word_id: x.w.id,
        status: 'learning',
        mode_a_interval: 0,
        mode_a_due: null,
        mode_b_count: 0,
        mode_b_due: tomorrow,
        wrong_count: x.wrong,
        weak_reason: x.wrong > 0 ? '做题做错' : null,
      }));
    if (rows.length) await DB.insertUserWords(rows);
    await DB.upsertDailyLogNewWords(session.date, session.words.length);
    session.persisted = true;
    if (window.CheckIn) CheckIn.maybeCompleteToday(); // 新词完成 → 尝试自动打卡
  }

  function renderDone(saveError) {
    const total = session.words.length;
    const weakTotal = session.groups.reduce((n, g) => n + g.idxs.filter((i) => g.qstates[i].wrong > 0).length, 0);
    const acc = session.stats.answered ? Math.round((session.stats.correct / session.stats.answered) * 100) : 100;
    const mins = Math.max(1, Math.round(session.elapsedMs / 60000));

    $('new-body').innerHTML = `
      <div class="summary-card">
        <div class="summary-head">今日新词完成</div>
        <div class="done-grid">
          <div class="done-item"><div class="done-num num">${total}</div><div class="done-label">通过词数</div></div>
          <div class="done-item"><div class="done-num num">${acc}%</div><div class="done-label">今日正确率</div></div>
          <div class="done-item"><div class="done-num num">${mins}</div><div class="done-label">用时（分钟）</div></div>
          <div class="done-item"><div class="done-num num">${weakTotal}</div><div class="done-label">薄弱词</div></div>
        </div>
        <div class="done-status">${saveError || (session.persisted ? '成绩已保存，明天开始进入复习池' : '正在保存成绩…')}</div>
        ${saveError ? '<button class="btn btn-primary" id="btn-retry-save">重试保存</button>' : ''}
        <button class="btn btn-primary" id="btn-back-home">回首页</button>
      </div>`;
    $('btn-back-home').addEventListener('click', () => { location.hash = '#/'; });
    const retry = $('btn-retry-save');
    if (retry) retry.addEventListener('click', finishDay);
  }

  return { enter };
})();
