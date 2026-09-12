// ============================================================
// 今日新词（强制做题）
// 流程：新词预览 → 分组做题（5 组 × 10 词，每词 3 题）→ 组间小结 → 当日总结
//
// 持久化：当日会话断点存 Supabase 表 user_session_progress（按 date+module_type
// 一行，queue_snapshot 存完整会话）。中途退出/刷新后重进按存档原样恢复——
// 题目顺序不重新洗牌、已答统计不丢失；跨天断点作废重来（按今天日期查询）。
// 「今天是否已完成」一律以 daily_logs.new_words_count > 0 为准（跨设备一致）——
// 进入本页时先查库，已完成则丢弃本地断点，防止跨设备重复学习。
//
// 旧的 localStorage 断点由「我的数据」页的「同步本机数据到云端」按钮迁移。
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
  const MODULE = 'new';       // user_session_progress.module_type
  const DAILY_COUNT = 50;   // 每个工作日的新词数量（周末不出新词）
  const GROUP_SIZE = 10;    // 每组词数

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

  // 从云端恢复今天的断点快照（done 的也恢复——完成视图/成绩补保存依赖它）
  async function loadSession() {
    try {
      const row = await DB.getSessionProgress(MODULE, DB.todayISO());
      if (row && row.queue_snapshot) session = row.queue_snapshot;
    } catch (e) {
      console.warn('[NewWords] 云端断点读取失败，按无断点处理', e);
    }
  }

  // 断点异步落库（每答一题/阶段切换都调用）：status 跟 stage 走，
  // 题号/对错数取 stats（qAnswered 优先，兼容各模块字段名），首页卡片展示用
  function saveSession() {
    if (!session) return;
    session.lastTick = Date.now();
    const st = session.stats || {};
    const answered = st.qAnswered != null ? st.qAnswered : (st.answered || 0);
    const correct = st.qCorrect != null ? st.qCorrect : (st.correct || 0);
    DB.saveSessionProgress(MODULE, session.date, {
      status: session.stage === 'done' ? 'completed' : 'in_progress',
      queue_snapshot: session,
      current_index: answered,
      correct_count: correct,
      wrong_count: answered - correct,
    }).catch((e) => console.warn('[NewWords] 断点保存失败', e));
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
    const body = $('new-body');
    if (!body) return;

    if (isWeekend()) {
      body.innerHTML = '<div class="placeholder">周末不出新词<br>回首页参加「周末考试」吧</div>';
      return;
    }

    // 完成状态以 Supabase 为准（跨设备一致）：今天 daily_logs 已有新词记录，
    // 说明今天已完成过——以数据库为准，忽略云端断点，不再重复出题。
    try {
      const log = await DB.getDailyLog(DB.todayISO());
      if (log && log.new_words_count > 0) {
        renderAlreadyDone(log.new_words_count);
        return;
      }
    } catch (e) {
      // 查库失败无法确认今日状态：宁可挡住也不冒重复学习的风险
      console.error('[NewWords] 今日状态查询失败', e);
      body.innerHTML = '<div class="placeholder">网络异常，无法确认今日学习状态<br>请检查网络后重新进入</div>';
      return;
    }

    // 今天未完成 → 从云端取断点（按今天日期查，跨天断点天然作废）
    await loadSession();
    if (session && session.date !== DB.todayISO()) session = null; // 跨天兜底

    if (session && session.stage === 'done') {
      // 今天已完成（跨天会话已在上面作废）：若上次关闭时成绩没存上，补一次保存
      if (session.persisted) renderDone();
      else finishDay();
      return;
    }
    if (session) {
      // 断点续学：题目队列顺序、组进度、已答统计按存档原样恢复，不重新洗牌
      tick();
      render();
      return;
    } // 断点续学（preview / quiz / summary / empty）

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

  // 数据库显示今天已完成时的静态视图（此时没有本地会话可展示成绩）
  function renderAlreadyDone(count) {
    $('new-body').innerHTML = `
      <div class="summary-card">
        <div class="summary-head">今日新词已完成</div>
        <div class="summary-score">今日 <span class="num">${count}</span> 词已完成</div>
        <div class="done-status">以服务器记录为准，明天再来</div>
        <button class="btn btn-primary" id="btn-back-home">回首页</button>
      </div>`;
    $('btn-back-home').addEventListener('click', () => { location.hash = '#/'; });
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
        <div class="tap-continue" id="tap-continue" style="display:none">点击继续</div>
      </div>
      <div class="word-detail" id="word-detail" style="display:none"></div>`;

    document.querySelectorAll('#new-body .option').forEach((el) => {
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

    const g = session.groups[session.groupIndex];
    const q = g.queue[0];
    const st = g.qstates[q.w];
    const w = session.words[q.w];
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
    showDetail(w); // 显示单词详情卡，等用户点击题目卡继续（不再自动跳转）
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

  // 点击题目卡 → 下一题（本组题尽则进小结）
  function proceed() {
    if (!inputLock || !current) return; // 未作答时点击无效
    inputLock = false;
    current = null;
    tick();
    const g = session.groups[session.groupIndex];
    if (!g.queue.length) {
      session.stage = 'summary';
      saveSession();
    }
    render();
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
        // 进入新一组时重新洗牌，不复用建会话时的顺序
        shuffle(session.groups[session.groupIndex].queue);
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
    // 新词做题统计累加进当天 quiz_correct/quiz_total（分享卡片正确率用；含重练的全部作答口径）。
    // 失败（如列未建）只告警，不影响新词成绩本身。
    try {
      await DB.addQuizStats(session.date, session.stats.correct, session.stats.answered);
    } catch (e) {
      console.warn('[NewWords] 做题统计写入失败（不影响成绩保存）', e);
    }
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

  // 今日宜休时由首页调用：丢弃未完成的会话（内存 + 云端）。
  // 已完成的存档保留——done 状态承担着「成绩待同步」的补保存入口。
  function discard() {
    if (session && session.stage !== 'done') session = null;
    (async () => {
      try {
        const row = await DB.getSessionProgress(MODULE, DB.todayISO());
        if (row && row.status !== 'completed') await DB.deleteSessionProgress(MODULE, DB.todayISO());
      } catch (e) { console.warn('[NewWords] 断点清除失败', e); }
    })();
  }

  return { enter, discard };
})();
