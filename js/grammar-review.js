// ============================================================
// 今日复习（语法）：模式 B 做题 + 模式 A 翻卡自测（同一队列，混排无感知）
// 镜像 js/review.js，只组语法队列，不与单词穿插。
//
// 队列构成（进入时现组，到期多少收多少，不砍量）：
// - 模式 B 到期（status='learning' 且 mode_b_due<=今天）：每语法 1 题，题型按
//   接续 50% / 语境 40% / 辨析 10% 权重随机；缺某题型时在可用题型里随机
//   （groupQuestions 组内 reviewed 优先、同级随机）。
// - 模式 A 到期（status='mastered' 且 mode_a_due<=今天）：每语法 1 张翻卡
//  （正面条目，背面释义+接续，自评 会/模糊/忘记）。
// - 合并后 Fisher-Yates 打乱；空队列 → 「今日暂无待复习语法」。
//
// 判定口径：
// - 模式 B「本次对错」只看首次作答：首次答错即在该场结算时按
//   GrammarCore.reviewResultFields(ug,false) 落库（答错重排到做对后不再重复扣）。
// - 模式 A 按自评落 GrammarCore.modeAResultFields（翻卡不计入做题正确率）。
// - 判定结果先记在会话里，队列走完统一结算：逐条 updateUserGrammar →
//   addGrammarQuizStats（正确数/做题总数，含重练，翻卡不计）→
//   deleteSessionProgress → GrammarCore.maybeCompleteToday()。
//
// 断点：每题/每卡后 saveSessionProgress('grammar_review', today)（队列顺序、
// 首次作答、统计整体入快照）；中途退出/刷新按存档原样恢复，不重新洗牌；
// 队列走完统一结算并删除断点；跨天作废；「今日宜休」由语法首页调 discard() 清除。
// ============================================================
window.GrammarReview = (function () {
  const MODULE = 'grammar_review';   // user_session_progress.module_type

  let session = null;
  let current = null;      // 当前选择题 { q, answerIdx }，不持久化
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

  // ---------- 断点持久化（云端 user_session_progress，module_type 与单词侧隔离） ----------
  // 途中断点写入链：finish 必须等最后一笔断点写入落库后再 deleteSessionProgress，
  // 否则晚到的 in_progress 写入会 recreate 一行僵尸断点
  let lastSave = Promise.resolve();

  async function loadSession() {
    try {
      const row = await DB.getSessionProgress(MODULE, DB.todayISO());
      // 只恢复进行中的断点；completed 残留行视为无效（到期已清零，重查即空）
      if (row && row.status === 'in_progress' && row.queue_snapshot) session = row.queue_snapshot;
    } catch (e) {
      console.warn('[GrammarReview] 云端断点读取失败，按无断点处理', e);
    }
  }

  function saveSession() {
    if (!session || session.phase === 'done') return;
    const st = session.stats || {};
    // 快照在调用点深拷贝——防 finish 突变 session 之后才被序列化，把完成态写回云端
    const snapshot = JSON.parse(JSON.stringify(session));
    lastSave = DB.saveSessionProgress(MODULE, session.date, {
      status: 'in_progress',
      queue_snapshot: snapshot,
      current_index: st.qAnswered || 0,
      correct_count: st.qCorrect || 0,
      wrong_count: (st.qAnswered || 0) - (st.qCorrect || 0),
    }).catch((e) => console.warn('[GrammarReview] 断点保存失败', e));
  }

  // 模式 B 抽题：接续 50% / 语境 40% / 辨析 10%；缺某题型时权重只在可用题型上
  function pickBQuestion(grp) {
    const cont = (grp && grp.continuation) || [];
    const ctx = (grp && grp.context) || [];
    const sim = (grp && grp.similar) || [];
    const cands = [];
    if (cont.length) cands.push({ w: 0.5, arr: cont });
    if (ctx.length) cands.push({ w: 0.4, arr: ctx });
    if (sim.length) cands.push({ w: 0.1, arr: sim });
    if (!cands.length) return null;
    let total = 0;
    for (const c of cands) total += c.w;
    let r = Math.random() * total;
    let pick = cands[cands.length - 1];
    for (const c of cands) { r -= c.w; if (r <= 0) { pick = c; break; } }
    return pick.arr[0];
  }

  // ---------- 入口：路由进入 #/grammar/review 时调用 ----------
  async function enter() {
    const body = $('gh-review-body');
    if (!body) return;

    // 内存里的会话已跨天 → 作废（云端按今天日期查询，跨天存档天然取不到）
    if (session && session.date !== DB.todayISO()) session = null;

    // 内存为空（页面刷新过）→ 从云端恢复今天的断点：队列顺序、首次作答、统计
    // 按存档原样恢复，不重新洗牌
    if (!session) await loadSession();

    // 今天未完成的会话 → 直接续作（队列空则走结算兜底）
    if (session && session.phase !== 'done') { renderRun(); return; }
    session = null; // 已完成或没有断点 → 重新查库组队列

    body.innerHTML = '<div class="placeholder">正在加载今日复习…</div>';
    try {
      const [dueB, dueA] = await Promise.all([DB.getGrammarModeBDueRows(), DB.getGrammarModeADueRows()]);
      if (!dueB.length && !dueA.length) { renderEmpty(); return; }

      // 统一取条目与题库（FK 保证条目存在；缺失不静默丢弃，console.error + 跳过）
      const gids = [...new Set([...dueB, ...dueA].map((r) => r.grammar_id))];
      const [grammars, qRows] = await Promise.all([DB.getGrammarsByIds(gids), DB.getGrammarQuestions(gids)]);
      const byId = {};
      for (const g of grammars) byId[g.id] = g;
      const grouped = GrammarCore.groupQuestions(qRows);

      // 模式 B：每语法 1 题
      const items = [];
      for (const ug of dueB) {
        const g = byId[ug.grammar_id];
        if (!g) { console.error('[GrammarReview] 语法条目缺失，跳过出题 grammar_id=' + ug.grammar_id); continue; }
        const row = pickBQuestion(grouped.get(ug.grammar_id));
        if (!row) { console.error('[GrammarReview] 无可用题目，跳过 grammar_id=' + ug.grammar_id); continue; }
        items.push({
          kind: 'b', ug, grammar: g,
          q: {
            type: row.type,
            question: row.question,
            question_zh: row.question_zh || null,
            options: row.options,
            correct: row.correct,
            explanation: row.explanation,
          },
          outcome: null,   // 首次作答：true/false
          written: false,  // 结算是否已落库
        });
      }
      // 模式 A：每语法 1 张翻卡
      for (const ug of dueA) {
        const g = byId[ug.grammar_id];
        if (!g) { console.error('[GrammarReview] 语法条目缺失，跳过卡片 grammar_id=' + ug.grammar_id); continue; }
        items.push({ kind: 'a', ug, grammar: g, outcome: null, written: false });
      }
      if (!items.length) { renderEmpty(); return; }

      // 合并后 Fisher-Yates 打乱（做题与翻卡混排，用户无感知）
      session = {
        date: DB.todayISO(),
        phase: 'run',
        items,
        queue: shuffle(items.map((_, i) => i)),
        stats: { qAnswered: 0, qCorrect: 0 },
        acc: null,
        quizLogged: false,
        resultsSaved: false,
        flipped: false, ratingLock: false,
      };
      saveSession(); // 建队即存档：之后每答一题/每评一卡都会更新断点
      renderRun();
    } catch (e) {
      console.error('[GrammarReview] 加载失败', e);
      body.innerHTML = '<div class="placeholder">加载失败，请检查网络后重新进入</div>';
    }
  }

  function renderEmpty() {
    session = null;
    $('gh-review-body').innerHTML = '<div class="placeholder">今日暂无待复习语法<br>去学新语法，或明天再来</div>';
  }

  // ---------- 队列推进：队首是做题就出题，是卡片就翻卡 ----------
  function renderRun() {
    if (!session || !session.queue.length) { finish(); return; }
    const it = session.items[session.queue[0]];
    if (it.kind === 'b') renderQuiz();
    else renderCard();
  }

  // ---------- 做题环节（模式 B） ----------
  const TYPE_LABEL = { continuation: '接续题', context: '语境题', similar: '辨析题' };
  const TYPE_HINT = { continuation: '请选择正确的接续', context: '请选择正确的句型', similar: '请选择最恰当的选项' };

  function renderQuiz() {
    const it = session.items[session.queue[0]];
    const q = it.q;
    current = { q, answerIdx: q.correct };
    inputLock = false;

    const promptHtml = `<div class="quiz-prompt jp">${esc(q.question)}</div>`;
    const zhHtml = q.question_zh ? `<div class="opt-sub">${esc(q.question_zh)}</div>` : '';
    const optsHtml = q.options.map((o, i) =>
      `<button class="option" data-idx="${i}"><span class="opt-main jp">${esc(o)}</span></button>`
    ).join('');

    $('gh-review-body').innerHTML = `
      <div class="quiz-progress">
        <span>剩余 <span class="num">${session.queue.length}</span> 项</span>
        <span>语法复习</span>
      </div>
      <div class="quiz-card" id="quiz-card">
        <div class="quiz-type">${TYPE_LABEL[q.type] || ''} · ${TYPE_HINT[q.type] || ''}</div>
        ${promptHtml}
        ${zhHtml}
        <div class="options">${optsHtml}</div>
        <div class="tap-continue" id="tap-continue" style="display:none">点击继续</div>
      </div>
      <div class="word-detail" id="word-detail" style="display:none"></div>`;

    document.querySelectorAll('#gh-review-body .option').forEach((el) => {
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

    const qi = session.queue[0];
    const it = session.items[qi];
    const correct = idx === current.answerIdx;
    // 全量作答统计（含重练）：累加进当天 quiz_grammar_correct/quiz_grammar_total
    session.stats.qAnswered++;
    if (correct) session.stats.qCorrect++;

    const optEls = document.querySelectorAll('#gh-review-body .option');
    const card = $('quiz-card');

    if (correct) {
      session.queue.shift();
      optEls[idx].classList.add('correct');
      card.classList.add('pop');
    } else {
      // 错题插回剩余队列的随机位置重练（不放最前，避免紧挨着重出），直到答对
      session.queue.shift();
      const pos = session.queue.length ? 1 + Math.floor(Math.random() * session.queue.length) : 0;
      session.queue.splice(pos, 0, qi);
      optEls[idx].classList.add('wrong');
      optEls[current.answerIdx].classList.add('correct');
    }

    // 首次作答定判定（重练不再改）：结算时 reviewResultFields(ug, 首次对错)
    if (it.outcome == null) it.outcome = correct;

    saveSession(); // 每答一题都存断点（队列顺序/首次作答/统计），随时退出都能原样续上
    showDetail(it.grammar, !correct, it.q);
  }

  // 作答后：题目卡下方显示语法详情卡 + 「点击继续」提示（2 秒后淡出，仅提示，点击始终有效）
  function showDetail(g, showExplanation, q) {
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
      ${showExplanation ? `<div class="detail-block" style="text-align:left"><div class="detail-label">解析</div><div class="detail-example">${esc(q.explanation)}</div></div>` : ''}`;
    $('word-detail').style.display = '';
  }

  // 点击题目卡 → 下一项（队列空时 renderRun 内部进结算）
  function proceed() {
    if (!inputLock || !current) return; // 未作答时点击无效
    inputLock = false;
    current = null;
    renderRun();
  }

  // ---------- 翻卡环节（模式 A 卡片自测） ----------
  function renderCard() {
    const it = session.items[session.queue[0]];
    if (!it) { finish(); return; }
    session.flipped = false;
    session.ratingLock = false;

    const g = it.grammar;
    $('gh-review-body').innerHTML = `
      <div class="quiz-progress">
        <span>卡片自测</span>
        <span class="quiz-progress-right">剩余 <span class="num">${session.queue.length}</span> 项</span>
      </div>
      <div class="flip-card" id="flip-card">
        <div class="flip-inner">
          <div class="flip-face flip-front">
            <div class="card-main jp">${esc(g.pattern)}</div>
            <div class="card-interval">当前间隔 <span class="num">${it.ug.mode_a_interval || 1}</span> 天</div>
          </div>
          <div class="flip-face flip-back">
            <div class="card-main card-zh">${esc(g.meaning)}</div>
            ${g.continuation ? `<div class="card-sub jp">接续：${esc(g.continuation)}</div>` : ''}
          </div>
        </div>
      </div>
      <div class="flip-hint" id="flip-hint">心里默答，点击卡片翻面</div>
      <div class="card-btns" id="card-btns">
        <button class="btn btn-secondary" id="btn-forgot">忘记</button>
        <button class="btn btn-secondary" id="btn-vague">模糊</button>
        <button class="btn btn-primary" id="btn-know">会</button>
      </div>`;

    $('flip-card').addEventListener('click', () => {
      if (session.flipped) return;
      session.flipped = true;
      $('flip-card').classList.add('flipped');
      $('flip-hint').textContent = '对照背面，诚实自评';
      $('card-btns').classList.add('revealed');
    });
    $('btn-know').addEventListener('click', () => rate('know'));
    $('btn-vague').addEventListener('click', () => rate('vague'));
    $('btn-forgot').addEventListener('click', () => rate('forget'));
  }

  function rate(rating) {
    if (!session.flipped || session.ratingLock) return; // 未翻面不能自评
    session.ratingLock = true;

    const it = session.items[session.queue[0]];
    it.outcome = rating; // 结算时统一 modeAResultFields 落库
    session.queue.shift();
    saveSession();       // 卡片进度也入断点
    renderRun();         // 无项可走时 renderRun 内部调 finish()
  }

  // ---------- 收尾：队列走完 → 统一结算 ----------
  async function finish() {
    if (!session || session.phase === 'done') return;
    session.phase = 'done';
    // 先等途中的断点写入落库，再删除断点——避免 in_progress 写入晚到、
    // 把已删除的断点行复活成僵尸行
    await lastSave.catch(() => {});
    renderSummary(true); // 先渲染"正在保存结果…"
    await saveResults();
  }

  // 结算（幂等，可重试）：逐条 updateUserGrammar（written 标记防重复），
  // 做题统计只累加一次（quizLogged），成功后删除断点
  async function saveResults() {
    try {
      let failCount = 0;
      for (const it of session.items) {
        if (it.written || it.outcome == null) continue;
        const fields = it.kind === 'b'
          ? GrammarCore.reviewResultFields(it.ug, it.outcome === true)
          : GrammarCore.modeAResultFields(it.ug, it.outcome);
        try {
          await DB.updateUserGrammar(it.ug.id, fields);
          it.written = true;
        } catch (e) {
          failCount++;
          console.error('[GrammarReview] 判定写库失败 ug_id=' + it.ug.id, e);
        }
      }

      // 正确率只统计模式 B 做题（翻卡不计入）
      const bItems = session.items.filter((x) => x.kind === 'b');
      const bDone = bItems.filter((x) => x.outcome != null).length;
      const bCorrect = bItems.filter((x) => x.outcome === true).length;
      session.acc = bDone ? Math.round((bCorrect / bDone) * 100) : null;

      // 做题统计累加进当天 quiz_grammar_correct/quiz_grammar_total（quizLogged 防重试重复累加）
      if (!session.quizLogged && (session.stats.qAnswered || 0) > 0) {
        try {
          await DB.addGrammarQuizStats(session.date, session.stats.qCorrect, session.stats.qAnswered);
          session.quizLogged = true;
        } catch (e) {
          console.warn('[GrammarReview] 做题统计写入失败（不影响复习结果保存）', e);
        }
      }

      await DB.deleteSessionProgress(MODULE, session.date);
      session.resultsSaved = true;
      renderSummary(false, failCount);
      await GrammarCore.maybeCompleteToday(); // 复习清零 → 尝试语法自动打卡（await 防丢失）
    } catch (e) {
      console.error('[GrammarReview] 结果保存失败', e);
      renderSummary(false, null, '结果保存失败，请检查网络后点击重试');
    }
  }

  function renderSummary(saving, failCount, saveError) {
    const bItems = session.items.filter((x) => x.kind === 'b');
    const bDone = bItems.filter((x) => x.outcome != null).length;
    const bCorrect = bItems.filter((x) => x.outcome === true).length;
    const acc = bDone ? Math.round((bCorrect / bDone) * 100) : null;
    const cards = session.items.filter((x) => x.kind === 'a' && x.outcome);

    let cardLine = '';
    if (cards.length) {
      const k = cards.filter((x) => x.outcome === 'know').length;
      const v = cards.filter((x) => x.outcome === 'vague').length;
      const f = cards.filter((x) => x.outcome === 'forget').length;
      cardLine = `<div class="compare-line">卡片自测 <span class="num">${cards.length}</span> 张 <span class="dot">·</span> 会 <span class="num ok">${k}</span> <span class="dot">·</span> 模糊 <span class="num">${v}</span> <span class="dot">·</span> 忘记 <span class="num ${f ? 'cmp-down' : ''}">${f}</span></div>`;
    }

    const status = saveError
      ? esc(saveError)
      : saving ? '正在保存结果…' : (failCount ? `结果已保存 <span class="dot">·</span> ${failCount} 条写入失败` : '结果已保存');

    $('gh-review-body').innerHTML = `
      <div class="summary-card">
        <div class="summary-head">今日复习完成（语法）</div>
        <div class="summary-score">做题 <span class="num">${bDone}</span> 题 <span class="dot">·</span> 正确率 <span class="num">${acc == null ? '—' : acc + '%'}</span> <span class="dot">·</span> 卡片 <span class="num">${cards.length}</span> 张</div>
        ${cardLine}
        <div class="done-status">${status}</div>
        ${saveError ? '<button class="btn btn-primary" id="btn-retry-save">重试保存</button>' : ''}
        <button class="btn btn-primary" id="btn-back-home">回首页</button>
      </div>`;
    $('btn-back-home').addEventListener('click', () => { location.hash = '#/grammar'; });
    const retry = $('btn-retry-save');
    if (retry) retry.addEventListener('click', saveResults);
  }

  // 今日宜休时由语法首页调用：丢弃未完成的会话（内存 + 云端）
  function discard() {
    if (session && session.phase !== 'done') session = null;
    DB.deleteSessionProgress(MODULE, DB.todayISO()).catch((e) => console.warn('[GrammarReview] 断点清除失败', e));
  }

  return { enter, discard };
})();
