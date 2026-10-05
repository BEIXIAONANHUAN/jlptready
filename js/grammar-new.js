// ============================================================
// 今日新语法（强制做题，镜像 js/newwords.js）
// 流程：预览 6 个语法 → 18 题测试（每语法 接续×2 + 语境×1，similar 不进新学）
//      → 日小结 → 结算写库
//
// 持久化：当日会话断点存 Supabase user_session_progress（module_type='grammar_new'，
// 按 date 一行，queue_snapshot 存完整会话）。中途退出/刷新后重进按存档原样恢复——
// 题目顺序不重新洗牌、已答统计不丢失；跨天断点作废重来（按今天日期查询）。
// 「今天是否已完成」一律以 daily_logs.new_grammar_count > 0 为准（跨设备一致）——
// 进入本页先查库，已完成则丢弃本地断点，防止跨设备重复学习；查询失败宁可挡住。
//
// 数据口径：
// - 一个语法「通过」= 它的题全部答对过（答错的题重新插回剩余队列随机位置，
//   直到答对才出队）；passedCount = 已通过语法数（首页卡片读它）。
// - 「一次通过」= 该语法所有题从未在首次作答时答错（重练答对不算）。
// - 完成时写 user_grammar：已有行 updateUserGrammar（newPassFields，
//   首次答错过再叠加 newWrongFields 记薄弱）；无行 insertUserGrammar
//   （wrong_count=首次答错次数、weak_reason='新学答错'）。
// - 结算再累加 daily_logs：new_grammar_count（+6）、quiz_grammar_correct/total
//   （含重练的全部作答口径，失败只告警）。
// ============================================================
window.GrammarNew = (function () {
  const MODULE = 'grammar_new';   // user_session_progress.module_type

  let session = null;   // 当日会话（与云端断点同步）
  let current = null;   // 当前题 { q, answerIdx }，不持久化，重进时按队首重建
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

  const isWeekend = () => [0, 6].includes(new Date().getDay());

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
      console.warn('[GrammarNew] 云端断点读取失败，按无断点处理', e);
    }
  }

  // 断点异步落库（每答一题/阶段切换都调用）：status 跟 stage 走，
  // 题号/对错数取 stats（首页卡片展示用）
  function saveSession() {
    if (!session) return;
    session.lastTick = Date.now();
    const st = session.stats || {};
    // 调用点深拷贝：防 stage 突变后被晚到的 fire-and-forget 写入序列化旧引用
    const snapshot = JSON.parse(JSON.stringify(session));
    DB.saveSessionProgress(MODULE, session.date, {
      status: session.stage === 'done' ? 'completed' : 'in_progress',
      queue_snapshot: snapshot,
      current_index: st.answered || 0,
      correct_count: st.correct || 0,
      wrong_count: (st.answered || 0) - (st.correct || 0),
    }).catch((e) => console.warn('[GrammarNew] 断点保存失败', e));
  }

  // 组一个语法的 3 道题：接续 2 + 语境 1；语境不足 1 道时用第 3 道接续补；
  // similar（辨析）禁止进新学。groupQuestions 组内已 reviewed 优先、同级随机。
  function pickQuestionsFor(grp) {
    const cont = (grp && grp.continuation) || [];
    const ctx = (grp && grp.context) || [];
    const picks = [];
    if (cont[0]) picks.push(cont[0]);
    if (ctx[0]) picks.push(ctx[0]);
    if (cont[1]) picks.push(cont[1]);
    if (picks.length < 3 && cont[2]) picks.push(cont[2]);
    return picks.slice(0, 3);
  }

  // 建测试队列：全部题混在一起 Fisher-Yates 打乱，同一语法的题不连续相邻
  function buildQueue(questions) {
    const idxs = questions.map((_, i) => i);
    for (let attempt = 0; attempt < 50; attempt++) {
      shuffle(idxs);
      let ok = true;
      for (let i = 1; i < idxs.length; i++) {
        if (questions[idxs[i]].gi === questions[idxs[i - 1]].gi) { ok = false; break; }
      }
      if (ok) return idxs;
    }
    // 兜底：确定性修复——相邻同语法时与后面最近的异语法题交换
    for (let i = 1; i < idxs.length; i++) {
      if (questions[idxs[i]].gi !== questions[idxs[i - 1]].gi) continue;
      for (let j = i + 1; j < idxs.length; j++) {
        if (questions[idxs[j]].gi === questions[idxs[i - 1]].gi) continue;
        const t = idxs[i]; idxs[i] = idxs[j]; idxs[j] = t;
        break;
      }
    }
    return idxs;
  }

  // ---------- 建会话 ----------
  async function createSession() {
    const items = await DB.getUnlearnedGrammars(GrammarCore.NEW_PER_DAY);
    if (!items.length) {
      session = { date: DB.todayISO(), stage: 'empty', items: [], questions: [], queue: [], qstates: {}, stats: { answered: 0, correct: 0 }, passedCount: 0, persisted: true, elapsedMs: 0, lastTick: Date.now() };
      return;
    }

    const ids = items.map((g) => g.id);
    const rows = await DB.getGrammarQuestions(ids);
    const grouped = GrammarCore.groupQuestions(rows);

    const questions = [];
    const qstates = {};
    let passedCount = 0;
    items.forEach((g, gi) => {
      const picks = pickQuestionsFor(grouped.get(g.id));
      qstates[gi] = { passed: 0, wrong: 0, total: picks.length, done: false };
      if (!picks.length) {
        // 该语法没有可用题（数据异常）：不算阻塞，直接视为通过
        qstates[gi].done = true;
        passedCount++;
        console.error('[GrammarNew] 语法无可用题目（数据异常），跳过出题 grammar_id=' + g.id);
      }
      picks.forEach((row, k) => {
        questions.push({
          qid: gi + '-' + k,
          gi,
          grammar_id: row.grammar_id,
          type: row.type,                     // continuation / context
          question: row.question,
          question_zh: row.question_zh || null,
          options: row.options,               // 4 个选项（jsonb 数组）
          correct: row.correct,               // 正确答案索引 0-3
          explanation: row.explanation,
          missed: false,                      // 首次作答是否答错（重练答错不再计数）
        });
      });
    });

    session = {
      date: DB.todayISO(),
      stage: 'preview',
      items,                       // 6 个语法完整行（pattern/meaning/continuation/example/pos/level…）
      questions,                   // 18 题（含 grammar_id、题型、题干、选项、correct、explanation）
      queue: buildQueue(questions), // 题目在 questions 里的下标队列，答对才出队
      qstates,                     // 每语法：已做对的题数 / 首次答错计数 / 总题数 / 是否通过
      stats: { answered: 0, correct: 0 },
      passedCount,
      persisted: false,
      elapsedMs: 0, lastTick: Date.now(),
    };
  }

  // ---------- 入口：路由进入 #/grammar/new 时调用 ----------
  async function enter() {
    const body = $('gh-new-body');
    if (!body) return;

    if (isWeekend()) {
      body.innerHTML = '<div class="placeholder">周末不出新语法<br>回首页参加周末考试吧</div>';
      return;
    }

    // 完成状态以 Supabase 为准（跨设备一致）：今天 daily_logs 已有新语法记录，
    // 说明今天已完成过——以数据库为准，忽略云端断点，不再重复出题。
    try {
      const log = await DB.getDailyLog(DB.todayISO());
      if (log && log.new_grammar_count > 0) {
        renderAlreadyDone(log.new_grammar_count);
        return;
      }
    } catch (e) {
      // 查库失败无法确认今日状态：宁可挡住也不冒重复学习的风险
      console.error('[GrammarNew] 今日状态查询失败', e);
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
      // 断点续学：题目队列顺序、已答统计、重排位置按存档原样恢复，不重新洗牌
      tick();
      render();
      return;
    }

    body.innerHTML = '<div class="placeholder">正在准备今日新语法…</div>';
    try {
      await createSession();
      saveSession();
      render();
    } catch (e) {
      console.error('[GrammarNew] 建会话失败', e);
      body.innerHTML = '<div class="placeholder">语法库加载失败，请检查网络后重新进入</div>';
    }
  }

  // 数据库显示今天已完成时的静态视图（此时没有本地会话可展示成绩）
  function renderAlreadyDone(count) {
    $('gh-new-body').innerHTML = `
      <div class="summary-card">
        <div class="summary-head">今日新语法已完成</div>
        <div class="summary-score">今日 <span class="num">${count}</span> 个语法已完成</div>
        <div class="done-status">以服务器记录为准，明天再来</div>
        <button class="btn btn-primary" id="btn-back-home">回首页</button>
      </div>`;
    $('btn-back-home').addEventListener('click', () => { location.hash = '#/grammar'; });
  }

  function render() {
    tick();
    switch (session.stage) {
      case 'preview': renderPreview(); break;
      case 'quiz': renderQuiz(); break;
      case 'summary': renderSummary(session.persisted ? 'saved' : undefined); if (!session.persisted) settle(); break;
      case 'done': renderDone(); break;
      default: $('gh-new-body').innerHTML = '<div class="placeholder">语法已全部学完</div>';
    }
  }

  // ---------- 步骤 1：新语法预览 ----------
  function renderPreview() {
    const rows = session.items.map((g) => `
      <div class="wrow">
        <span class="wrow-word jp">${esc(g.pattern)}</span>
        <span class="wrow-reading jp">${esc(g.continuation || '')}</span>
        <span class="wrow-pos">${esc(g.pos || '')}</span>
        <div class="wrow-meaning">${esc(g.meaning)}
          ${g.example1 ? `<div class="detail-example jp">${esc(g.example1)}</div>` : ''}
          ${g.example1_zh ? `<div class="detail-example-zh">${esc(g.example1_zh)}</div>` : ''}
        </div>
      </div>`).join('');
    $('gh-new-body').innerHTML = `
      <div class="preview-tip">今日 <span class="num">${session.items.length}</span> 个新语法，先浏览一遍</div>
      <div class="wtable">${rows}</div>
      <div class="cta-bar"><div class="cta-inner">
        <div class="preview-tip">测试共 <span class="num">${session.questions.length}</span> 题，答错的题会重新出现，直到做对</div>
        <button class="btn btn-danger" id="btn-start-test">开始测试</button>
      </div></div>`;
    $('btn-start-test').addEventListener('click', () => {
      session.stage = 'quiz';
      saveSession();
      render();
    });
  }

  // ---------- 步骤 2：做题 ----------
  const TYPE_LABEL = { continuation: '接续题', context: '语境题', similar: '辨析题' };
  const TYPE_HINT = { continuation: '请选择正确的接续', context: '请选择正确的句型', similar: '请选择最恰当的选项' };

  function renderQuiz() {
    if (!session.queue.length) { session.stage = 'summary'; saveSession(); render(); return; }

    const q = session.questions[session.queue[0]];
    current = { q, answerIdx: q.correct };
    inputLock = false;

    const promptHtml = `<div class="quiz-prompt jp">${esc(q.question)}</div>`;
    const zhHtml = q.question_zh ? `<div class="opt-sub">${esc(q.question_zh)}</div>` : '';

    const optsHtml = q.options.map((o, i) =>
      `<button class="option" data-idx="${i}"><span class="opt-main jp">${esc(o)}</span></button>`
    ).join('');

    $('gh-new-body').innerHTML = `
      <div class="quiz-progress">
        <span>剩余 <span class="num">${session.queue.length}</span> 题</span>
        <span>已通过 <span class="num">${session.passedCount}</span>/<span class="num">${session.items.length}</span> 个语法</span>
      </div>
      <div class="quiz-card" id="quiz-card">
        <div class="quiz-type">${TYPE_LABEL[q.type] || ''} · ${TYPE_HINT[q.type] || ''}</div>
        ${promptHtml}
        ${zhHtml}
        <div class="options">${optsHtml}</div>
        <div class="tap-continue" id="tap-continue" style="display:none">点击继续</div>
      </div>
      <div class="word-detail" id="word-detail" style="display:none"></div>`;

    document.querySelectorAll('#gh-new-body .option').forEach((el) => {
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

    const qi = session.queue[0];
    const q = session.questions[qi];
    const st = session.qstates[q.gi];
    const g = session.items[q.gi];
    const correct = idx === current.answerIdx;

    session.stats.answered++;
    const optEls = document.querySelectorAll('#gh-new-body .option');
    const card = $('quiz-card');

    if (correct) {
      session.stats.correct++;
      st.passed++;
      session.queue.shift();
      optEls[idx].classList.add('correct');
      card.classList.add('pop'); // 卡片轻微上浮 + 绿色边框
      if (!st.done && st.passed >= st.total) {
        st.done = true;          // 该语法全部题做对过 = 通过
        session.passedCount++;
      }
    } else {
      // 首次作答答错才计数（重练答错不重复计）；错题重排直到做对
      if (!q.missed) { q.missed = true; st.wrong++; }
      session.queue.shift();
      const pos = session.queue.length ? 1 + Math.floor(Math.random() * session.queue.length) : 0;
      session.queue.splice(pos, 0, qi);
      optEls[idx].classList.add('wrong');
      optEls[current.answerIdx].classList.add('correct'); // 同时标出正确答案
    }
    saveSession(); // 每答一题都存档，随时退出都能续上
    showDetail(g, !correct); // 详情卡：释义 → 接续 → 例句+译文 →（答错时）解析
  }

  // 作答后：题目卡下方显示语法详情卡 + 「点击继续」提示（2 秒后淡出，仅提示，点击始终有效）
  function showDetail(g, showExplanation) {
    const card = $('quiz-card');
    card.classList.add('awaiting');
    const tip = $('tap-continue');
    tip.style.display = '';
    setTimeout(() => tip.classList.add('fade'), 2000);

    $('word-detail').innerHTML = `
      <div class="wd-meaning">${esc(g.meaning)}</div>
      <div class="wd-jp jp">${esc(g.pattern)}</div>
      ${g.continuation ? `<div class="wd-pos jp">接续：${esc(g.continuation)}</div>` : ''}
      <div class="detail-block">
        ${g.example1 ? `<div class="detail-example jp">${esc(g.example1)}</div>` : ''}
        ${g.example1_zh ? `<div class="detail-example-zh">${esc(g.example1_zh)}</div>` : ''}
      </div>
      ${showExplanation ? `<div class="detail-block" style="text-align:left"><div class="detail-label">解析</div><div class="detail-example">${esc(current.q.explanation)}</div></div>` : ''}`;
    $('word-detail').style.display = '';
  }

  // 点击题目卡 → 下一题（队列空时 renderQuiz 内部进日小结）
  function proceed() {
    if (!inputLock || !current) return; // 未作答时点击无效
    inputLock = false;
    current = null;
    tick();
    renderQuiz();
  }

  // ---------- 步骤 3：日小结（18 题全过即到此，结算在后台随即执行） ----------
  let settling = false;

  function renderSummary(saveState) {
    const clean = [], weak = [];
    session.items.forEach((g, gi) => {
      const st = session.qstates[gi] || { wrong: 0 };
      (st.wrong > 0 ? weak : clean).push({ g, wrong: st.wrong });
    });

    const weakHtml = weak.length
      ? `<div class="weak-title">薄弱语法（答错过，已记入薄弱池）</div>
         <div class="wtable">${weak.map(({ g, wrong }) => `
           <div class="wrow">
             <span class="wrow-word jp">${esc(g.pattern)}</span>
             <span class="wrow-reading jp">${esc(g.continuation || '')}</span>
             <span class="wrow-pos">${esc(g.pos || '')}</span>
             <div class="wrow-meaning">${esc(g.meaning)}<span class="wb-count">答错 ${wrong} 题</span></div>
           </div>`).join('')}</div>`
      : '<div class="weak-title">全部一次通过，没有薄弱语法</div>';

    const statusHtml = saveState === 'saved'
      ? '<div class="done-status">成绩已保存，明天开始进入复习池</div>'
      : saveState === 'saving'
        ? '<div class="done-status">正在保存成绩…</div>'
        : saveState
          ? `<div class="done-status">${esc(saveState)}</div><button class="btn btn-primary" id="btn-retry-save">重试保存</button>`
          : '';

    $('gh-new-body').innerHTML = `
      <div class="summary-card">
        <div class="summary-head">今日新语法小结</div>
        <div class="summary-score">一次通过 <span class="num score-em">${clean.length}</span>/<span class="num">${session.items.length}</span></div>
        ${weakHtml}
        ${statusHtml}
        <div class="summary-btns">
          <button class="btn btn-secondary" id="btn-rest5">休息 5 分钟</button>
          <button class="btn btn-primary" id="btn-go-review">去复习</button>
        </div>
      </div>`;

    $('btn-rest5').addEventListener('click', () => {
      saveSession(); // 进度已存，回首页；成绩后台继续保存（以 daily_logs 为准）
      location.hash = '#/grammar';
    });
    $('btn-go-review').addEventListener('click', () => { location.hash = '#/grammar/review'; });
    const retry = $('btn-retry-save');
    if (retry) retry.addEventListener('click', settle);
  }

  // 结算（幂等，可重试）：写 user_grammar + daily_logs → 删除断点 → 语法打卡判定。
  // 18 题全过进入小结页时自动执行一次；失败保留断点（persisted=false），重进可续。
  async function settle() {
    if (!session || session.persisted || settling) return;
    settling = true;
    renderSummary('saving');
    try {
      await finalize();
      saveSession(); // persisted=true 的完成态快照，防「删行后旧写入复活」期间状态丢失
      await DB.deleteSessionProgress(MODULE, session.date);
      renderSummary('saved');
    } catch (e) {
      console.error('[GrammarNew] 成绩保存失败', e);
      renderSummary('成绩保存失败，请检查网络后点击重试');
    } finally {
      settling = false;
    }
  }

  // ---------- 步骤 4：完成态（stage='done' 存档的补保存入口，规格 §3） ----------
  async function finishDay() {
    session.stage = 'done';
    saveSession();
    renderDone(); // 先渲染"正在保存成绩…"
    try {
      await finalize();
      saveSession();
      await DB.deleteSessionProgress(MODULE, session.date);
      renderDone();
    } catch (e) {
      console.error('[GrammarNew] 成绩保存失败', e);
      renderDone('成绩保存失败，请检查网络后点击重试');
    }
  }

  // 完成时唯一一次数据库写入（persisted 标记防止刷新后重复写）
  async function finalize() {
    if (session.persisted) return;

    const ids = session.items.map((g) => g.id);
    const [existingIds, existingRows] = await Promise.all([
      DB.getExistingUserGrammarIds(ids),
      DB.getUserGrammarByGrammarIds(ids),
    ]);
    const existing = new Set(existingIds);
    const byGid = {};
    for (const r of existingRows) byGid[r.grammar_id] = r;

    // 逐语法 upsert：已有行 update（newPassFields + 首次答错过叠加 newWrongFields），
    // 无行 insert（wrong_count=首次答错次数、weak_reason='新学答错'）
    for (let gi = 0; gi < session.items.length; gi++) {
      const g = session.items[gi];
      const st = session.qstates[gi] || { wrong: 0 };
      const hadWrong = st.wrong > 0;
      const pass = GrammarCore.newPassFields();
      if (existing.has(g.id)) {
        const row = byGid[g.id];
        const fields = { ...pass };
        if (hadWrong) Object.assign(fields, GrammarCore.newWrongFields(row || { wrong_count: 0 }));
        await DB.updateUserGrammar(row.id, fields);
      } else {
        await DB.insertUserGrammar([{
          grammar_id: g.id,
          ...pass,
          mode_a_due: null,
          wrong_count: hadWrong ? st.wrong : 0,
          weak_reason: hadWrong ? '新学答错' : null,
        }]);
      }
    }
    await DB.upsertDailyLogNewGrammar(session.date, session.items.length);
    // 做题统计累加进当天 quiz_grammar_correct/quiz_grammar_total（含重练的全部作答口径）。
    // 失败（如列未建）只告警，不影响新学成绩本身。
    try {
      await DB.addGrammarQuizStats(session.date, session.stats.correct, session.stats.answered);
    } catch (e) {
      console.warn('[GrammarNew] 做题统计写入失败（不影响成绩保存）', e);
    }
    session.persisted = true;
    await GrammarCore.maybeCompleteToday(); // 新学完成 → 尝试语法自动打卡（await 防丢失）
  }

  function renderDone(saveError) {
    const total = session.items.length;
    const weakTotal = session.items.filter((_, gi) => (session.qstates[gi] || { wrong: 0 }).wrong > 0).length;
    const acc = session.stats.answered ? Math.round((session.stats.correct / session.stats.answered) * 100) : 100;
    const mins = Math.max(1, Math.round(session.elapsedMs / 60000));

    $('gh-new-body').innerHTML = `
      <div class="summary-card">
        <div class="summary-head">今日新语法完成</div>
        <div class="done-grid">
          <div class="done-item"><div class="done-num num">${total}</div><div class="done-label">通过语法数</div></div>
          <div class="done-item"><div class="done-num num">${acc}%</div><div class="done-label">今日正确率</div></div>
          <div class="done-item"><div class="done-num num">${mins}</div><div class="done-label">用时（分钟）</div></div>
          <div class="done-item"><div class="done-num num">${weakTotal}</div><div class="done-label">薄弱语法</div></div>
        </div>
        <div class="done-status">${saveError || (session.persisted ? '成绩已保存，明天开始进入复习池' : '正在保存成绩…')}</div>
        ${saveError ? '<button class="btn btn-primary" id="btn-retry-save">重试保存</button>' : ''}
        <button class="btn btn-primary" id="btn-back-home">回首页</button>
      </div>`;
    $('btn-back-home').addEventListener('click', () => { location.hash = '#/grammar'; });
    const retry = $('btn-retry-save');
    if (retry) retry.addEventListener('click', finishDay);
  }

  // 今日宜休时由语法首页调用：丢弃未完成的会话（内存 + 云端）。
  // 已完成的存档保留——done 状态承担着「成绩待同步」的补保存入口。
  function discard() {
    if (session && session.stage !== 'done') session = null;
    DB.deleteSessionProgress(MODULE, DB.todayISO()).catch((e) => console.warn('[GrammarNew] 断点清除失败', e));
  }

  return { enter, discard };
})();
