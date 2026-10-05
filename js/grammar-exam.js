// ============================================================
// 语法周末考试（仅周六、周日开放，镜像 js/exam.js 的交互与 UI 结构）
//
// 规则：
// - 每天 20 个语法，每语法抽 2 道不同类型的题（continuation/context/similar
//   中随机两种，有哪种抽哪种），共 40 题，四选一。
// - 选语法构成：15 个薄弱语法（wrong_count>0 或 weak_reason 非空，已按
//   wrong_count 降序）+ 5 个已掌握语法（mastered，随机）。薄弱不足 15 时用
//   learning 语法补足，再不足用 mastered 补足；mastered 不足 5 个时用薄弱语法
//   （再拼 learning）补齐差额。
//   注意：DB.getGrammarMasteredPool() 实际返回全量 user_grammar（未按 status
//   过滤，db.js 注释与实现不符），本模块客户端按 status==='mastered' 过滤后再用。
// - 已学语法总数（薄弱+learning+mastered 去重）< 20 时「有什么算什么」：考全部
//   已学语法的 2 题，开考前的过渡页和结算页显式标注「本次语法测试 N 题
//   （词库积累中）」，不硬凑 40 题。
// - 某语法只有 1 道题时，第 2 题从同主题（grammar.pos 相同）的其他已学语法
//   的题里借，并在会话快照的组卷记录（picked）与题目队列项（borrowed）里标注，
//   防止同一道题重复出现；借来的题归被借语法所有（做错写库、详情展示都按
//   被借语法算）。
// - 全部题目 Fisher-Yates 洗牌，同一语法的 2 题不相邻（洗牌后相邻检测修正）。
// - 考试没有重练：每题一次作答机会，答错显示正确选项与语法详情卡，点击题目卡继续。
// - 写库口径：答错的语法（有 user_grammar 行的）wrong_count+1、
//   weak_reason='考试做错'（GrammarCore.examWrongFields）；答对不写库；
//   没有 user_grammar 行的语法跳过，不为考试造行。
// - 评分：score = Math.round(100 × 答对 / 总题数)，评级 GrammarCore.ratingOf
//   （S≥95 / A≥85 / B≥70 / C<70），写入 daily_logs 当天的
//   grammar_test_score / grammar_test_rating；做题统计累加 quiz_grammar_correct/
//   quiz_grammar_total（失败只告警）。
// - 「今天是否已考」的唯一事实来源是 daily_logs.grammar_test_score（语法首页
//   卡片同源）：有分数 → 成绩视图；查库失败显示「加载失败，请检查网络后重新
//   进入」，不冒进。会话存云端 user_session_progress（module_type='grammar_exam'）：
//   中途退出可续考——题目队列与已答统计按存档原样恢复，不重新组卷；跨天作废
//   （只按今天日期查询）；快照 stage='done' 但日志缺分数时补写 setGrammarExamResult。
// - 完成后 await GrammarCore.maybeCompleteToday()：周末语法打卡主任务 =
//   grammar_test_score 非空，判定由 GrammarCore 完成。
// - 本模块所有 DOM id 均带 gex- 前缀：单词考试页（#exam-body）与本页
//   （#gh-exam-body）同时存在于文档中，id 冲突会让 getElementById 串页。
// ============================================================
window.GrammarExam = (function () {
  const WEAK_TARGET = 15;        // 薄弱语法目标数
  const MASTERED_TARGET = 5;     // 已掌握语法目标数
  const GRAMMAR_TARGET = 20;     // 每天考语法数（15+5）
  const Q_PER_GRAMMAR = 2;       // 每语法 2 题
  const STANDARD_TOTAL = 40;     // 标准总题数（历史重建数据用）
  const RATING_ORDER = { S: 4, A: 3, B: 2, C: 1 };
  const QTYPES = ['continuation', 'context', 'similar'];
  const TYPE_LABEL = { continuation: '接续题', context: '语境题', similar: '辨析题' };
  const TYPE_HINT = {
    continuation: '请选择正确的接续方式',
    context: '请选择填入空白处最恰当的语法',
    similar: '请选择最恰当的语法',
  };

  let session = null;
  let current = null;    // 当前题（队列项 e）
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

  // 分批按 id 取语法条目（getGrammarsByIds 单批 id 过多时 URL 过长）
  async function getGrammarsByIdsBatched(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 100) {
      out.push(...await DB.getGrammarsByIds(ids.slice(i, i + 100)));
    }
    return out;
  }

  // ---------- 断点落库 ----------
  // 每题存档；status 跟 stage 走；答错语法的待写字段在快照的 wronged 里，
  // 恢复时幂等补写（绝对值字段，重复写无副作用）
  function saveSession() {
    if (!session) return;
    session.lastTick = Date.now();
    const st = session.stats || {};
    // 调用点深拷贝：防 stage 突变后被晚到的 fire-and-forget 写入序列化旧引用
    const snapshot = JSON.parse(JSON.stringify(session));
    DB.saveSessionProgress('grammar_exam', session.date, {
      status: session.stage === 'done' ? 'completed' : 'in_progress',
      queue_snapshot: snapshot,
      current_index: st.answered || 0,
      correct_count: st.correct || 0,
      wrong_count: (st.answered || 0) - (st.correct || 0),
    }).catch((e) => console.warn('[GrammarExam] 断点保存失败', e));
  }

  // ---------- 组卷 ----------
  async function createSession() {
    const [weak, learning, masteredAll] = await Promise.all([
      DB.getGrammarWeakRows(WEAK_TARGET),  // 已按 wrong_count 降序
      DB.getGrammarLearningRows(),
      DB.getGrammarMasteredPool(),         // 实为全量 user_grammar，客户端过滤 mastered
    ]);
    const mastered = masteredAll.filter((r) => r.status === 'mastered');

    const pickedIds = new Set();
    const rec = new Map();   // grammar_id → { side, fill }，组卷记录用
    const weakSide = [];     // 15 题侧：薄弱 → learning 补 → mastered 补
    const masteredSide = []; // 5 题侧：mastered → 薄弱补 → learning 补

    // 从 arr 随机取至多 n 个未选语法，记入 side/fill
    const take = (arr, side, fill, n) => {
      const out = [];
      for (const r of shuffle(arr.filter((x) => !pickedIds.has(x.grammar_id)))) {
        if (out.length >= n) break;
        out.push(r);
        pickedIds.add(r.grammar_id);
        rec.set(r.grammar_id, { side, fill });
      }
      return out;
    };

    // ① 薄弱语法优先 wrong_count 高的，取 15
    for (const r of weak.slice(0, WEAK_TARGET)) {
      weakSide.push(r);
      pickedIds.add(r.grammar_id);
      rec.set(r.grammar_id, { side: 'weak', fill: 'weak' });
    }

    // ② 已掌握语法随机 5（排除已选的，避免重复出题；不足 5 个全用）
    masteredSide.push(...take(mastered, 'mastered', 'mastered', MASTERED_TARGET));

    // ③ 薄弱不足 15 → 用 learning 语法随机补足
    if (weakSide.length < WEAK_TARGET) {
      weakSide.push(...take(learning, 'weak', 'learning', WEAK_TARGET - weakSide.length));
    }

    // ④ 仍不足 → 用剩余 mastered 语法补足（补进 15 题侧，保持总数 20）
    if (weakSide.length < WEAK_TARGET) {
      weakSide.push(...take(mastered, 'weak', 'mastered', WEAK_TARGET - weakSide.length));
    }

    // ⑤ 已掌握侧不足 5 → 用薄弱语法（再拼 learning）补齐差额。
    // 极端情况：已学语法去重后不足 20 时只能全用（见下方 partial 分支）。
    if (masteredSide.length < MASTERED_TARGET) {
      masteredSide.push(...take(weak, 'mastered', 'weak', MASTERED_TARGET - masteredSide.length));
    }
    if (masteredSide.length < MASTERED_TARGET) {
      masteredSide.push(...take(learning, 'mastered', 'learning', MASTERED_TARGET - masteredSide.length));
    }

    // 已学语法总数（三池去重）：< 20 → 「有什么算什么」，考全部已学语法
    const learnedMap = new Map();
    for (const r of weak) if (!learnedMap.has(r.grammar_id)) learnedMap.set(r.grammar_id, r);
    for (const r of learning) if (!learnedMap.has(r.grammar_id)) learnedMap.set(r.grammar_id, r);
    for (const r of mastered) if (!learnedMap.has(r.grammar_id)) learnedMap.set(r.grammar_id, r);

    if (!learnedMap.size) {
      session = {
        date: DB.todayISO(), stage: 'empty', queue: [], picked: [], ugMap: {},
        totalQ: 0, partial: false,
        stats: { answered: 0, correct: 0 }, wronged: {}, wrongList: [],
        elapsedMs: 0, lastTick: Date.now(), persisted: true,
        score: null, rating: null,
      };
      return;
    }

    const partial = learnedMap.size < GRAMMAR_TARGET;
    const rows = partial
      ? [...learnedMap.values()].map((r) => ({ r, side: 'all', fill: 'all' }))
      : [...weakSide, ...masteredSide].map((r) => {
        const m = rec.get(r.grammar_id) || { side: 'weak', fill: 'weak' };
        return { r, side: m.side, fill: m.fill };
      });

    const gids = rows.map((x) => x.r.grammar_id);
    const learnedIds = [...learnedMap.keys()];
    // 借题需要全部已学语法的 pos 信息（partial 模式下与 gids 相同）
    const [qRows, gRows] = await Promise.all([
      DB.getGrammarQuestions(gids),
      getGrammarsByIdsBatched(partial ? gids : learnedIds),
    ]);

    const gInfo = new Map(gRows.map((g) => [g.id, g]));
    const groups = GrammarCore.groupQuestions(qRows); // grammar_id → {continuation[],context[],similar[]}，reviewed 优先
    const ugMap = {};
    for (const r of learnedMap.values()) ugMap[r.grammar_id] = r;

    // 每个语法抽 2 道不同类型的题；只有 1 道时向同主题其他已学语法借 1 道
    const usedQids = new Set();
    const queue = [];
    const picked = [];
    for (const x of rows) {
      const gid = x.r.grammar_id;
      const g = groups.get(gid);
      const types = shuffle(QTYPES.filter((t) => g && g[t].length));
      const chosen = [];
      for (const t of types) {
        if (chosen.length >= Q_PER_GRAMMAR) break;
        // 该题可能已被先处理的同主题语法借走，跳过已用的题
        const q = (g[t] || []).find((x) => !usedQids.has(x.id));
        if (!q) continue;
        chosen.push({ type: t, q, borrowed: null });
      }
      if (chosen.length < Q_PER_GRAMMAR) {
        const pos = (gInfo.get(gid) || {}).pos;
        const cands = shuffle(learnedIds.filter((id) => id !== gid
          && (gInfo.get(id) || {}).pos === pos && groups.has(id)));
        for (const cid of cands) {
          const g2 = groups.get(cid);
          const t2s = shuffle(QTYPES.filter((t) => g2[t].length));
          let found = null;
          for (const t2 of t2s) {
            const q2 = g2[t2].find((x) => !usedQids.has(x.id)); // 防同一道题重复出现
            if (q2) { found = { type: t2, q: q2 }; break; }
          }
          if (!found) continue;
          chosen.push({ type: found.type, q: found.q, borrowed: cid });
          break;
        }
      }
      const info = gInfo.get(gid) || {};
      picked.push({
        grammar_id: gid,
        side: x.side,
        fill: x.fill,
        ug_id: x.r.id || null,
        questions: chosen.map((c) => ({ qid: c.q.id, type: c.type, borrowed: c.borrowed || false })),
      });
      for (const c of chosen) {
        usedQids.add(c.q.id);
        const ci = c.borrowed ? (gInfo.get(c.borrowed) || {}) : info;
        queue.push({
          gid: c.borrowed || gid,     // 题目归属语法（借来的题归被借语法）
          type: c.type,
          qid: c.q.id,
          q: c.q.question,
          qzh: c.q.question_zh || '',
          options: Array.isArray(c.q.options) ? c.q.options : [],
          correct: c.q.correct,
          expl: c.q.explanation || '',
          pattern: ci.pattern || '',
          meaning: ci.meaning || '',
          pos: ci.pos || '',
          level: ci.level || '',
          borrowed: !!c.borrowed,
        });
      }
    }

    shuffleNoAdjacent(queue); // Fisher-Yates + 同一语法的题不相邻

    pendingWrites = [];
    session = {
      date: DB.todayISO(),
      stage: 'start',
      queue, picked, ugMap,
      totalQ: queue.length,
      partial,
      stats: { answered: 0, correct: 0 },
      wronged: {},    // 已答错语法的待写库字段（断点恢复时幂等补写用）
      wrongList: [],  // 错题明细（结算页错题列表用）
      elapsedMs: 0, lastTick: Date.now(),
      persisted: false,
      score: null, rating: null,
    };
  }

  // Fisher-Yates 洗牌后修正：同一语法的题不相邻。
  // 与相邻元素同语法的项，向后找一个换过去仍不产生相邻的位置；找不到则挪到队尾。
  function shuffleNoAdjacent(queue) {
    const key = (e) => e.gid;
    shuffle(queue);
    for (let pass = 0; pass < 200; pass++) {
      let bad = -1;
      for (let i = 1; i < queue.length; i++) {
        if (key(queue[i]) === key(queue[i - 1])) { bad = i; break; }
      }
      if (bad === -1) return;
      const i = bad;
      let swapped = false;
      for (let j = i + 1; j < queue.length; j++) {
        if (key(queue[j]) === key(queue[i - 1])) continue;           // 换过去仍与前者同语法
        if (i + 1 < queue.length && key(queue[j]) === key(queue[i + 1])) continue;
        if (key(queue[i]) === key(queue[j - 1])) continue;           // j=i+1 的相邻互换无意义，必中此条
        if (j + 1 < queue.length && key(queue[i]) === key(queue[j + 1])) continue;
        const t = queue[i]; queue[i] = queue[j]; queue[j] = t;
        swapped = true;
        break;
      }
      if (!swapped) queue.push(queue.splice(i, 1)[0]); // 挪到队尾下一轮再检查
    }
  }

  // ---------- 入口 ----------
  async function enter() {
    const body = $('gh-exam-body');
    if (!body) return;

    if (!isWeekend()) {
      body.innerHTML = '<div class="placeholder">语法考试仅周六、周日开放</div>';
      return;
    }

    // 断点与今日成绩一起查：查库失败不冒进（不组卷、不补写），页面内提示
    let log = null;
    try {
      const row = await DB.getSessionProgress('grammar_exam', DB.todayISO());
      session = row && row.queue_snapshot ? row.queue_snapshot : null;
      log = await DB.getDailyLog(DB.todayISO());
    } catch (e) {
      console.error('[GrammarExam] 初始化查询失败', e);
      session = null;
      body.innerHTML = '<div class="placeholder">加载失败，请检查网络后重新进入</div>';
      return;
    }

    // 幂等补写（任何已恢复的会话都做）：上次关闭页面时答错语法的薄弱池写库
    // 可能未落地（绝对值字段，重复写无副作用）
    if (session && session.wronged) {
      pendingWrites = Object.entries(session.wronged).map(([ugId, fields]) =>
        DB.updateUserGrammar(ugId, fields).catch((e) => console.error('[GrammarExam] 断点补写失败 user_grammar_id=' + ugId, e))
      );
    }

    // 「今天是否已考」的唯一事实来源：daily_logs.grammar_test_score（与首页卡片同源）。
    // 有分数 → 成绩视图；快照缺失的历史考试按标准 40 题重建结算数据
    // （quiz_grammar 统计是当天全模块累计，绝不能当本次考试题数）。
    if (log && log.grammar_test_score != null) {
      if (!session || session.stage !== 'done') {
        const totalQ = STANDARD_TOTAL;
        const correct = Math.round(((log.grammar_test_score || 0) * totalQ) / 100);
        session = {
          date: DB.todayISO(), stage: 'done', persisted: true, queue: [], picked: [], ugMap: {},
          partial: false,
          score: log.grammar_test_score, rating: log.grammar_test_rating,
          totalQ,
          stats: { answered: totalQ, correct },
          wronged: {}, wrongList: [],
          elapsedMs: null, // 历史重建数据，无时长记录
        };
      }
      let history = null;
      try { history = await DB.getGrammarExamHistory(); } catch (e) { console.warn('[GrammarExam] 历史成绩查询失败', e); }
      renderDone(false, null, history);
      return;
    }

    // 快照 done 但 daily_logs 缺分数（上次成绩保存失败）：补写分数后再进结算页，
    // 保证首页卡片与本页状态一致
    if (session && session.stage === 'done') {
      DB.setGrammarExamResult(session.date, session.score, session.rating)
        .catch((e) => console.warn('[GrammarExam] 成绩补写失败', e));
      let history = null;
      try { history = await DB.getGrammarExamHistory(); } catch (e) { console.warn('[GrammarExam] 历史成绩查询失败', e); }
      renderDone(false, null, history);
      return;
    }

    // 断点续考：题目顺序与已答状态按存档原样恢复，不重新组卷；跨天快照查询不到即作废
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
      console.error('[GrammarExam] 组卷失败', e);
      body.innerHTML = '<div class="placeholder">加载失败，请检查网络后重新进入</div>';
    }
  }

  function render() {
    tick();
    switch (session.stage) {
      case 'start': renderStart(); break;
      case 'quiz': renderQuiz(); break;
      case 'done': renderDone(); break;
      default: $('gh-exam-body').innerHTML = '<div class="placeholder">还没有可考的语法<br>先在工作日学几天语法吧</div>';
    }
  }

  // ---------- 考前过渡页 ----------
  function renderStart() {
    const totalQ = session.totalQ || 0;
    const tip = session.partial
      ? '全部已学语法各 2 题随机穿插，每题只有一次作答机会'
      : '15 个薄弱语法 + 5 个已掌握语法，每语法 2 题随机穿插，每题只有一次作答机会';
    const partialTip = session.partial
      ? `<div class="preview-tip">本次语法测试 <span class="num">${totalQ}</span> 题（词库积累中）</div>`
      : '';
    $('gh-exam-body').innerHTML = `
      <div class="summary-card">
        <div class="summary-head">周末考试（语法）</div>
        <div class="summary-score"><span class="num">${totalQ}</span> 题</div>
        <div class="preview-tip">${tip}</div>
        ${partialTip}
        <button class="btn btn-primary" id="gex-start">开始考试</button>
      </div>`;
    $('gex-start').addEventListener('click', () => {
      session.stage = 'quiz';
      saveSession();
      renderQuiz();
    });
  }

  // ---------- 考试做题 ----------
  function renderQuiz() {
    const e = session.queue[0];
    if (!e) { finish(); return; }

    current = { e };
    inputLock = false;

    const optsHtml = e.options.map((o, i) =>
      `<button class="option" data-idx="${i}"><span class="opt-main jp">${esc(o)}</span></button>`).join('');

    $('gh-exam-body').innerHTML = `
      <div class="quiz-progress">
        <span>第 <span class="num">${session.stats.answered + 1}</span>/<span class="num">${session.totalQ}</span> 题</span>
        <span>答对 <span class="num">${session.stats.correct}</span></span>
      </div>
      <div class="quiz-card" id="gex-card">
        <div class="quiz-type">${TYPE_LABEL[e.type] || esc(e.type)} · ${TYPE_HINT[e.type] || '请选择正确答案'}</div>
        <div class="quiz-prompt jp">${esc(e.q)}</div>
        ${e.qzh ? `<div class="quiz-prompt quiz-prompt-zh">${esc(e.qzh)}</div>` : ''}
        <div class="options">${optsHtml}</div>
        <div class="tap-continue" id="gex-tap-continue" style="display:none">点击继续</div>
      </div>
      <div class="word-detail" id="gex-detail" style="display:none"></div>`;

    document.querySelectorAll('#gh-exam-body .option').forEach((el) => {
      el.addEventListener('click', (ev) => {
        if (inputLock) return;   // 已作答：不拦截，冒泡到题目卡触发「点击继续」
        ev.stopPropagation();    // 未作答：作答，不触发卡片点击
        answer(Number(el.dataset.idx));
      });
    });
    // 作答后点击题目卡任意位置进入下一题
    $('gex-card').addEventListener('click', proceed);
  }

  function answer(idx) {
    if (inputLock || !current) return;
    inputLock = true;
    tick();

    const e = session.queue[0];
    const correct = idx === e.correct;

    session.stats.answered++;
    if (correct) session.stats.correct++;

    const optEls = document.querySelectorAll('#gh-exam-body .option');
    const card = $('gex-card');
    if (correct) {
      optEls[idx].classList.add('correct');
      card.classList.add('pop');
    } else {
      optEls[idx].classList.add('wrong');
      if (optEls[e.correct]) optEls[e.correct].classList.add('correct');
      // 答错的语法进薄弱池口径（有 user_grammar 行才写，不为考试造行）：
      // weak_reason='考试做错'、wrong_count+1（GrammarCore.examWrongFields）。
      // 字段入存档，断点恢复时幂等补写。
      const ug = session.ugMap && session.ugMap[e.gid];
      if (ug && ug.id) {
        session.wronged[ug.id] = GrammarCore.examWrongFields(ug);
        pendingWrites.push(
          DB.updateUserGrammar(ug.id, session.wronged[ug.id])
            .catch((err) => console.error('[GrammarExam] 写库失败 grammar_id=' + e.gid, err))
        );
      }
      session.wrongList.push({ ...e, chosen: idx });
    }
    session.queue.shift();
    saveSession(); // 每题存档，中途退出可续考

    showDetail(e); // 显示语法详情卡，等用户点击题目卡继续（不再自动跳转）
  }

  // 作答后：题目卡下方显示语法详情卡 + 「点击继续」提示（2 秒后淡出，仅提示，点击始终有效）
  function showDetail(e) {
    const card = $('gex-card');
    card.classList.add('awaiting');
    const tip = $('gex-tap-continue');
    tip.style.display = '';
    setTimeout(() => tip.classList.add('fade'), 2000);

    $('gex-detail').innerHTML = `
      <div class="wd-meaning">${esc(e.meaning)}</div>
      <div class="wd-jp jp">${esc(e.pattern)}</div>
      <div class="wd-pos">${esc(e.pos)}${e.level ? `<span class="dot">·</span>${esc(e.level)}` : ''}</div>`;
    $('gex-detail').style.display = '';
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
  async function finish() {
    session.stage = 'done';
    session.score = session.stats.answered ? Math.round((session.stats.correct / session.stats.answered) * 100) : 0;
    session.rating = GrammarCore.ratingOf(session.score);
    saveSession();
    renderDone(true);
    await saveResult();
  }

  async function saveResult() {
    try {
      await Promise.all(pendingWrites);
      await DB.setGrammarExamResult(session.date, session.score, session.rating);
      // 考试做题统计累加进当天 quiz_grammar_correct/quiz_grammar_total
      // （quizLogged 防重试重复累加；失败只告警，不影响考试成绩保存）
      if (!session.quizLogged) {
        try {
          await DB.addGrammarQuizStats(session.date, session.stats.correct, session.stats.answered);
          session.quizLogged = true;
        } catch (e) {
          console.warn('[GrammarExam] 做题统计写入失败（不影响成绩保存）', e);
        }
      }
      let history = null;
      try { history = await DB.getGrammarExamHistory(); } catch (e) { console.warn('[GrammarExam] 历史成绩查询失败', e); }
      session.persisted = true;
      saveSession();
      renderDone(false, null, history);
      // 考试完成 → 尝试语法自动打卡（await 防丢失；周末主任务 = grammar_test_score 非空）
      if (window.GrammarCore) await GrammarCore.maybeCompleteToday();
    } catch (e) {
      console.error('[GrammarExam] 成绩保存失败', e);
      renderDone(false, '成绩保存失败，请检查网络后点击重试');
    }
  }

  // ---------- 结算页 ----------
  function renderDone(saving, saveError, history) {
    const total = session.totalQ || 0;
    const wrong = session.stats.answered - session.stats.correct;
    // 历史数据（daily_logs 重建）没有用时记录 → 显示 —
    const mins = session.elapsedMs == null ? null : Math.max(1, Math.round(session.elapsedMs / 60000));

    // 历史最高（含今天）
    let bestHtml = '';
    if (!saving && !saveError && history && history.length) {
      let bestScore = -1, bestRating = null;
      for (const h of history) {
        if (h.grammar_test_score > bestScore) bestScore = h.grammar_test_score;
        if (h.grammar_test_rating && (!bestRating || RATING_ORDER[h.grammar_test_rating] > RATING_ORDER[bestRating])) bestRating = h.grammar_test_rating;
      }
      if (bestScore >= 0) {
        bestHtml = `<div class="compare-line">历史最高分 <span class="num">${bestScore}</span> <span class="dot">·</span> 历史最高评级 <span class="num">${bestRating}</span></div>`;
      }
    }

    // 「词库积累中」场次：结算页显式标注实际题数
    const partialHtml = session.partial
      ? `<div class="compare-line">本次语法测试 <span class="num">${total}</span> 题（词库积累中）</div>`
      : '';

    // 错题列表：题干 + 四选项（标出正确项与你的选择）+ 解析
    const wrongList = session.wrongList || [];
    const wrongHtml = wrongList.length ? `
      <div class="weak-title">错题回顾（<span class="num">${wrongList.length}</span>）</div>
      ${wrongList.map((w) => `
        <div class="word-detail">
          <div class="wb-line1">
            <span class="wb-word jp">${esc(w.pattern)}</span>
            <span class="wb-reading">${TYPE_LABEL[w.type] || esc(w.type)}</span>
            <span class="wb-count">你的答案：${w.options[w.chosen] != null ? esc(w.options[w.chosen]) : '—'}</span>
          </div>
          ${w.qzh ? `<div class="wd-pos">${esc(w.qzh)}</div>` : ''}
          <div class="wd-meaning jp">${esc(w.q)}</div>
          <div class="options">
            ${w.options.map((o, i) => `<div class="option${i === w.correct ? ' correct' : ''}${i === w.chosen ? ' wrong' : ''}"><span class="opt-main jp">${esc(o)}</span></div>`).join('')}
          </div>
          <div class="wd-pos jp">${esc(w.expl)}</div>
        </div>`).join('')}` : '';

    $('gh-exam-body').innerHTML = `
      <div class="summary-card">
        <div class="summary-head">周末考试（语法）完成</div>
        <div class="exam-result">
          <div class="exam-score num">${session.score != null ? session.score : '—'}</div>
          <div class="rating-badge rating-${session.rating}">${session.rating || '—'}</div>
        </div>
        <div class="done-grid">
          <div class="done-item"><div class="done-num num">${total}</div><div class="done-label">总题数</div></div>
          <div class="done-item"><div class="done-num num">${session.stats.correct}</div><div class="done-label">答对</div></div>
          <div class="done-item"><div class="done-num num">${wrong}</div><div class="done-label">答错（已入薄弱池）</div></div>
          <div class="done-item"><div class="done-num num">${mins == null ? '—' : mins}</div><div class="done-label">${mins == null ? '用时（历史重建数据，无时长记录）' : '用时（分钟）'}</div></div>
        </div>
        ${partialHtml}
        ${bestHtml}
        ${wrongHtml}
        <div class="done-status">${saveError || (saving ? '正在保存成绩…' : '成绩已保存')}</div>
        ${saveError ? '<button class="btn btn-primary" id="gex-retry-save">重试保存</button>' : ''}
        <button class="btn btn-primary" id="gex-back-home">返回首页</button>
      </div>`;
    $('gex-back-home').addEventListener('click', () => { location.hash = '#/grammar'; });
    const retry = $('gex-retry-save');
    if (retry) retry.addEventListener('click', saveResult);
  }

  // 今日宜休时由语法首页调用：丢弃今日会话（内存 + 云端 'grammar_exam' 快照）。
  // 与 Exam.discard 不同：按规格直接删除今日快照——完成判定以 daily_logs
  // 的 grammar_test_score 为准，成绩页可从日志重建，不依赖存档。
  function discard() {
    session = null;
    current = null;
    (async () => {
      try {
        await DB.deleteSessionProgress('grammar_exam', DB.todayISO());
      } catch (e) { console.warn('[GrammarExam] 断点清除失败', e); }
    })();
  }

  return { enter, discard };
})();
