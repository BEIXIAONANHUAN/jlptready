// ============================================================
// 今日复习：模式 B 做题 + 随机抽检 + 模式 A 卡片自测（同一流程，先做题后翻卡）
//
// 流程结构：
//   开始页 → 做题环节（模式 B 到期题 + 抽检题，混排无感知）→ 翻卡环节（模式 A 到期卡片）→ 总结页
//
// ---------- 模式 B 口径（第 3 步已定） ----------
// - 到期词：status='learning' 且 mode_b_due <= 今天。每词随机抽 2 种题型各 1 题。
// - 「本次做对/做错」只看每题【首次作答】：全对=做对，任一首次答错=做错。
//   答错的题插回队列重练到对为止，但重练不影响判定、不计入统计。
// - 做对：mode_b_count+1，按 1/2/4 天阶梯设 mode_b_due；count 到 3 毕业 →
//   status='mastered'、mode_a_interval=1、mode_a_due=明天、mode_b_due 置空。
// - 做错：mode_b_count=0、mode_b_due=明天、wrong_count+1、weak_reason='复习做错'。
//
// ---------- 模式 A 卡片自测（第 4 步） ----------
// - 到期卡：status='mastered' 且 mode_a_due <= 今天。
// - 每卡随机选一种正面：汉字→背面假名+释义 / 假名→背面汉字+释义 / 释义→背面汉字+假名。
//   纯假名词（无汉字写法）只从「假名 / 释义」里选正面。
// - 「会」：mode_a_interval 升一档（1→3→7→15→30，到 30 后维持 30），due=今天+新间隔。
// - 「模糊」：留在模式 A 但降一档间隔，weak_reason='卡片模糊'（进入薄弱词池口径）。
// - 「忘记」：降级回模式 B——status='learning'、mode_b_count=0、mode_b_due=明天、
//   mode_a_due 置空、weak_reason='卡片忘记'、wrong_count+1。
//
// ---------- 随机抽检（模式 B 突袭，第 4 步） ----------
// - 每天首次打开本页时，从模式 A 池（mastered）中随机抽 5–10 个词（不足 5 个全抽），
//   排除今天已到期的卡片词（它们本来就要翻卡，避免重复）。
// - 每词随机 1 种题型的四选一，混入做题环节，用户无感知。
// - 做对：不写库、不影响 mode_a 间隔；做错：立即降级回模式 B（字段同「忘记」，
//   仅 weak_reason='抽检做错'）。
// - 抽检名单与已完成的词存 localStorage（键 n5n2_spotcheck），当天不重复出现。
//
// ---------- 写库时机 ----------
// 每个词/每张卡判定后立即更新对应 user_words 行（中途退出只损失当前项）；
// 全部完成后更新 daily_logs：review_count 累加（做题词数+卡片张数）、
// review_acc 记本次做题正确率（卡片自测不计入正确率）。
// ============================================================
window.Review = (function () {
  const INTERVALS = [1, 2, 4];            // 模式 B 艾宾浩斯阶梯（天）
  const A_LADDER = [1, 3, 7, 15, 30];     // 模式 A 间隔档位（天）
  const SPOT_KEY = 'n5n2_spotcheck';      // 抽检名单的 localStorage 键
  const MS_CORRECT = 550;
  const MS_WRONG = 1200;

  let session = null;
  let current = null;      // 当前选择题 { q, options, answerIdx }
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

  // 计时：把距上次操作的时间累进 elapsedMs；超过 60 秒的空档视为离开，不计入
  function tick() {
    if (!session) return;
    const now = Date.now();
    const gap = now - (session.lastTick || now);
    if (gap > 0 && gap < 60000) session.elapsedMs += gap;
    session.lastTick = now;
  }

  // 选择题题型：模式 B 抽 2 种，抽检抽 1 种；纯假名词只有释义题
  function pickTypes(w, n) {
    const valid = w.word === w.reading ? ['meaning'] : ['reading', 'writing', 'meaning'];
    shuffle(valid);
    const types = valid.slice(0, n);
    while (types.length < n) types.push(valid[0]);
    return types;
  }

  // 模式 A 间隔升/降一档
  function nextRung(cur, dir) {
    let i = A_LADDER.indexOf(cur);
    if (i === -1) i = 0;
    i = Math.min(A_LADDER.length - 1, Math.max(0, i + dir));
    return A_LADDER[i];
  }

  // ---------- 抽检名单（当天固定，做过的不再出现） ----------
  function loadSpotStore() {
    try {
      const s = JSON.parse(localStorage.getItem(SPOT_KEY));
      if (s && s.date === DB.todayISO()) return s;
    } catch (e) { /* 忽略损坏数据 */ }
    return { date: DB.todayISO(), ids: null, done: [] };
  }
  function saveSpotStore(s) {
    try { localStorage.setItem(SPOT_KEY, JSON.stringify(s)); } catch (e) { /* 忽略 */ }
  }

  // 返回今日待抽检的 mastered 记录（user_words 行）
  async function resolveSpotChecks(dueA) {
    const today = DB.todayISO();
    const dueAWordIds = new Set(dueA.map((r) => r.word_id)); // 今天已排卡片的词不再抽检
    const store = loadSpotStore();

    if (!store.ids) {
      // 今天首次打开：从模式 A 池抽 5–10 个（不足 5 个全抽）
      const poolAll = await DB.getMasteredPool();
      const candidates = poolAll.filter((r) => r.mode_a_due > today && !dueAWordIds.has(r.word_id));
      store.ids = shuffle(candidates.slice()).slice(0, 5 + Math.floor(Math.random() * 6)).map((r) => r.word_id);
      saveSpotStore(store);
    }

    const remaining = store.ids.filter((id) => !store.done.includes(id) && !dueAWordIds.has(id));
    if (!remaining.length) return [];
    const rows = await DB.getUserWordsByWordIds(remaining);
    // 已被降级/变成今天到期的词从名单中剔除
    return rows.filter((r) => r.status === 'mastered' && r.mode_a_due > today);
  }

  function markSpotDone(wordId) {
    const store = loadSpotStore();
    if (!store.done.includes(wordId)) {
      store.done.push(wordId);
      saveSpotStore(store);
    }
  }

  // ---------- 入口：路由进入 #/review 时调用 ----------
  async function enter() {
    const body = $('review-body');
    if (!body) return;

    // 内存中有今天未完成的会话 → 按阶段直接续上
    if (session && !session.finished && session.date === DB.todayISO()) {
      tick();
      if (session.phase === 'quiz') renderQuiz();
      else if (session.phase === 'cards') renderCard();
      else renderStart();
      return;
    }

    body.innerHTML = '<div class="placeholder">正在加载今日复习…</div>';
    try {
      const [dueB, dueA] = await Promise.all([DB.getModeBDueWords(), DB.getModeADueWords()]);
      const spot = await resolveSpotChecks(dueA);

      if (!dueB.length && !dueA.length && !spot.length) {
        session = null;
        renderEmpty();
        return;
      }

      // 统一取词条数据
      const allWordIds = [...new Set([...dueB, ...dueA, ...spot].map((r) => r.word_id))];
      const words = await DB.getWordsByIds(allWordIds);
      const byId = {};
      for (const w of words) byId[w.id] = w;

      // 做题环节：模式 B（每词 2 题）+ 抽检（每词 1 题），混排
      const items = [];
      const queue = [];
      const attempts = {};
      let idx = 0;
      for (const uw of dueB) {
        if (!byId[uw.word_id]) continue;
        items.push({ kind: 'b', uw, word: byId[uw.word_id] });
        pickTypes(byId[uw.word_id], 2).forEach((type, k) => queue.push({ i: idx, qid: idx + '-' + k, type }));
        attempts[idx] = {};
        idx++;
      }
      for (const uw of spot) {
        if (!byId[uw.word_id]) continue;
        items.push({ kind: 'spot', uw, word: byId[uw.word_id] });
        queue.push({ i: idx, qid: idx + '-0', type: pickTypes(byId[uw.word_id], 1)[0] });
        attempts[idx] = {};
        idx++;
      }
      shuffle(queue);

      // 翻卡环节：模式 A 到期卡片
      const cards = dueA.filter((uw) => byId[uw.word_id]).map((uw) => ({ uw, word: byId[uw.word_id], front: pickCardFront(byId[uw.word_id]) }));

      const pool = queue.length ? await DB.getDistractorPool() : [];

      pendingWrites = [];
      session = {
        date: DB.todayISO(),
        items, queue, attempts, cards, pool,
        decided: {},
        phase: 'start',
        cardIndex: 0,
        flipped: false,
        ratingLock: false,
        finished: false,
        acc: null,
        elapsedMs: 0, lastTick: Date.now(),
        stats: { wordsDone: 0, wordsCorrect: 0, graduated: 0, cardsDone: 0, know: 0, vague: 0, forgot: 0 },
      };
      renderStart();
    } catch (e) {
      console.error('[Review] 加载失败', e);
      body.innerHTML = '<div class="placeholder">加载失败，请检查网络后重新进入</div>';
    }
  }

  // 卡片正面：随机选 汉字 / 假名 / 释义（纯假名词没有独立汉字写法，只选 假名 / 释义）
  function pickCardFront(w) {
    const fronts = w.word === w.reading ? ['word', 'meaning'] : ['word', 'reading', 'meaning'];
    return fronts[Math.floor(Math.random() * fronts.length)];
  }

  // ---------- 开始页 ----------
  function renderStart() {
    const bCount = session.items.filter((x) => x.kind === 'b').length;
    const cCount = session.cards.length;
    const parts = [];
    if (bCount) parts.push(`做题 <span class="num">${bCount}</span> 词`);
    if (cCount) parts.push(`卡片 <span class="num">${cCount}</span> 张`);
    if (!parts.length) parts.push(`做题 <span class="num">${session.queue.length}</span> 题`); // 仅抽检词时的兜底
    $('review-body').innerHTML = `
      <div class="summary-card">
        <div class="summary-head">今日复习</div>
        <div class="summary-score">${parts.join(' <span class="dot">·</span> ')}</div>
        <div class="preview-tip">做题每词首次作答全对才算通过；卡片心里默答后翻面自评</div>
        <button class="btn btn-primary" id="btn-start-review">开始复习</button>
      </div>`;
    $('btn-start-review').addEventListener('click', () => {
      tick();
      if (session.queue.length) {
        session.phase = 'quiz';
        renderQuiz();
      } else {
        session.phase = 'cards';
        renderCard();
      }
    });
  }

  // ---------- 空态 ----------
  function renderEmpty() {
    $('review-body').innerHTML = '<div class="placeholder">今日没有待复习的词<br>去学新词，或明天再来</div>';
  }

  // ---------- 做题环节（模式 B + 抽检混排） ----------
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
    if (!q) { // 做题环节结束 → 进入翻卡或收尾
      if (session.cards.length) { session.phase = 'cards'; renderCard(); }
      else finish();
      return;
    }

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

    $('review-body').innerHTML = `
      <div class="quiz-progress">
        <span>剩余 <span class="num">${session.queue.length}</span> 题</span>
        <span>已判定 <span class="num">${session.stats.wordsDone}</span>/<span class="num">${session.items.length}</span> 词</span>
      </div>
      <div class="quiz-card" id="quiz-card">
        <div class="quiz-type">${TYPE_LABEL[q.type]} · ${hint}</div>
        ${promptHtml}
        <div class="options">${optsHtml}</div>
      </div>`;

    document.querySelectorAll('#review-body .option').forEach((el) => {
      el.addEventListener('click', () => answer(Number(el.dataset.idx)));
    });
  }

  function answer(idx) {
    if (inputLock || !current) return;
    inputLock = true;
    tick();

    const q = session.queue[0];
    const at = session.attempts[q.i];
    const firstTry = !(q.qid in at); // 重练的题不再计入判定与统计
    const correct = idx === current.answerIdx;
    if (window.Achievements) Achievements.noteAnswer(correct); // 连对计数（铜墙铁壁徽章）

    const optEls = document.querySelectorAll('#review-body .option');
    const card = $('quiz-card');

    if (correct) {
      session.queue.shift();
      optEls[idx].classList.add('correct');
      card.classList.add('pop');
    } else {
      // 错题插回剩余题目的随机位置重练（不放最前，避免紧挨着重出），直到答对
      session.queue.shift();
      const pos = session.queue.length ? 1 + Math.floor(Math.random() * session.queue.length) : 0;
      session.queue.splice(pos, 0, q);
      optEls[idx].classList.add('wrong');
      optEls[current.answerIdx].classList.add('correct');
    }

    if (firstTry) {
      at[q.qid] = correct;
      // 该词的题都已完成首次作答（模式 B 2 题、抽检 1 题）→ 判定并立即写库
      const expected = session.items[q.i].kind === 'b' ? 2 : 1;
      if (Object.keys(at).length >= expected && !session.decided[q.i]) {
        session.decided[q.i] = true;
        pendingWrites.push(
          writeOutcome(q.i).catch((e) => console.error('[Review] 写库失败 item_idx=' + q.i, e))
        );
      }
    }

    setTimeout(() => {
      inputLock = false;
      tick();
      renderQuiz();
    }, correct ? MS_CORRECT : MS_WRONG);
  }

  // 判定一个词（模式 B 或抽检），立即写库
  async function writeOutcome(i) {
    const item = session.items[i];
    const { uw } = item;
    const results = Object.values(session.attempts[i]);
    const allCorrect = results.every(Boolean);

    if (item.kind === 'spot') {
      // 抽检：做对不写库（不影响 mode_a 间隔）；做错立即降级回模式 B
      markSpotDone(uw.word_id);
      if (!allCorrect) {
        await DB.updateUserWord(uw.id, {
          status: 'learning',
          mode_b_count: 0,
          mode_b_due: DB.tomorrowISO(),
          mode_a_due: null,
          weak_reason: '抽检做错',
          wrong_count: (uw.wrong_count || 0) + 1,
        });
      }
      return;
    }

    // 模式 B 判定
    let fields;
    if (allCorrect) {
      const newCount = (uw.mode_b_count || 0) + 1;
      session.stats.wordsCorrect++;
      if (newCount >= 3) {
        // 毕业：连续 3 次复习做对 → mastered，进入模式 A 已掌握池
        fields = {
          status: 'mastered',
          mode_b_count: newCount,
          mode_b_due: null,
          mode_a_interval: 1,
          mode_a_due: DB.tomorrowISO(),
        };
        session.stats.graduated++;
      } else {
        fields = {
          mode_b_count: newCount,
          mode_b_due: DB.datePlusDays(INTERVALS[newCount - 1]),
        };
      }
    } else {
      fields = {
        mode_b_count: 0,
        mode_b_due: DB.tomorrowISO(),
        wrong_count: (uw.wrong_count || 0) + 1,
        weak_reason: '复习做错',
      };
    }
    await DB.updateUserWord(uw.id, fields);
    session.stats.wordsDone++;
  }

  // ---------- 翻卡环节（模式 A 卡片自测） ----------
  function renderCard() {
    const c = session.cards[session.cardIndex];
    if (!c) { finish(); return; }
    session.flipped = false;
    session.ratingLock = false;

    const w = c.word;
    let frontHtml, backHtml;
    if (c.front === 'word') {
      frontHtml = `<div class="card-main jp">${esc(w.word)}</div>`;
      backHtml = `<div class="card-main jp card-back-main">${esc(w.reading)}</div><div class="card-sub">${esc(w.meaning)}</div>`;
    } else if (c.front === 'reading') {
      frontHtml = `<div class="card-main jp">${esc(w.reading)}</div>`;
      backHtml = `<div class="card-main jp card-back-main">${esc(w.word)}</div><div class="card-sub">${esc(w.meaning)}</div>`;
    } else {
      frontHtml = `<div class="card-main card-zh">${esc(w.meaning)}</div>`;
      backHtml = `<div class="card-main jp card-back-main">${esc(w.word)}</div><div class="card-sub jp">${esc(w.reading)}</div>`;
    }

    $('review-body').innerHTML = `
      <div class="quiz-progress">
        <span>卡片自测</span>
        <span>剩余 <span class="num">${session.cards.length - session.cardIndex}</span> 张</span>
      </div>
      <div class="flip-card" id="flip-card">
        <div class="flip-inner">
          <div class="flip-face flip-front">
            ${frontHtml}
            <div class="card-interval">当前间隔 <span class="num">${c.uw.mode_a_interval || 1}</span> 天</div>
          </div>
          <div class="flip-face flip-back">${backHtml}</div>
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
    $('btn-know').addEventListener('click', () => rateCard('know'));
    $('btn-vague').addEventListener('click', () => rateCard('vague'));
    $('btn-forgot').addEventListener('click', () => rateCard('forgot'));
  }

  async function rateCard(rating) {
    if (!session.flipped || session.ratingLock) return; // 未翻面不能自评
    session.ratingLock = true;
    tick();

    const c = session.cards[session.cardIndex];
    const uw = c.uw;
    let fields;
    if (rating === 'know') {
      const iv = nextRung(uw.mode_a_interval || 1, +1); // 升一档：1→3→7→15→30
      fields = { mode_a_interval: iv, mode_a_due: DB.datePlusDays(iv) };
      session.stats.know++;
    } else if (rating === 'vague') {
      const iv = nextRung(uw.mode_a_interval || 1, -1); // 降一档
      fields = { mode_a_interval: iv, mode_a_due: DB.datePlusDays(iv), weak_reason: '卡片模糊' };
      session.stats.vague++;
    } else {
      // 忘记：降级回模式 B
      fields = {
        status: 'learning',
        mode_b_count: 0,
        mode_b_due: DB.tomorrowISO(),
        mode_a_due: null,
        weak_reason: '卡片忘记',
        wrong_count: (uw.wrong_count || 0) + 1,
      };
      session.stats.forgot++;
    }

    try {
      await DB.updateUserWord(uw.id, fields);
    } catch (e) {
      console.error('[Review] 卡片保存失败', e);
      alert('保存失败，请检查网络后重试');
      session.ratingLock = false;
      return;
    }

    session.stats.cardsDone++;
    session.cardIndex++;
    tick();
    renderCard(); // 无卡可翻时 renderCard 内部会调 finish()
  }

  // ---------- 收尾 ----------
  async function finish() {
    if (session.finished) return;
    session.finished = true;
    session.phase = 'done';
    session.acc = session.stats.wordsDone
      ? Math.round((session.stats.wordsCorrect / session.stats.wordsDone) * 100)
      : 100;
    renderSummary(true);
    await saveResults();
  }

  async function saveResults() {
    try {
      await Promise.all(pendingWrites); // 确保所有判定都已落库
      await DB.addReviewResult(session.date, session.stats.wordsDone + session.stats.cardsDone, session.acc);
      const yLog = await DB.getDailyLog(DB.datePlusDays(-1));
      renderSummary(false, yLog && yLog.review_acc != null ? yLog.review_acc : null);
      if (window.CheckIn) CheckIn.maybeCompleteToday(); // 复习清零 → 尝试自动打卡
    } catch (e) {
      console.error('[Review] 结果保存失败', e);
      renderSummary(false, null, '结果保存失败，请检查网络后点击重试');
    }
  }

  function renderSummary(saving, yesterdayAcc, saveError) {
    const s = session.stats;
    const mins = Math.max(1, Math.round(session.elapsedMs / 60000));

    let cardLine = '';
    if (!saving && s.cardsDone) {
      cardLine = `<div class="compare-line">卡片自测 <span class="num">${s.cardsDone}</span> 张 <span class="dot">·</span> 会 <span class="num ok">${s.know}</span> <span class="dot">·</span> 模糊 <span class="num">${s.vague}</span> <span class="dot">·</span> 忘记 <span class="num ${s.forgot ? 'cmp-down' : ''}">${s.forgot}</span></div>`;
    }

    let compareHtml = '';
    if (!saving && !saveError && yesterdayAcc != null) {
      const diff = session.acc - yesterdayAcc;
      const sign = diff >= 0 ? '+' : '';
      const cls = diff >= 0 ? 'cmp-up' : 'cmp-down';
      compareHtml = `<div class="compare-line">正确率比昨日 <span class="num ${cls}">${sign}${diff}%</span></div>`;
    }

    $('review-body').innerHTML = `
      <div class="summary-card">
        <div class="summary-head">今日复习完成</div>
        <div class="done-grid">
          <div class="done-item"><div class="done-num num">${s.wordsDone}</div><div class="done-label">复习词数</div></div>
          <div class="done-item"><div class="done-num num">${session.acc}%</div><div class="done-label">正确率</div></div>
          <div class="done-item"><div class="done-num num">${s.graduated}</div><div class="done-label">毕业词数</div></div>
          <div class="done-item"><div class="done-num num">${mins}</div><div class="done-label">用时（分钟）</div></div>
        </div>
        ${cardLine}
        ${compareHtml}
        <div class="done-status">${saveError || (saving ? '正在保存结果…' : '结果已保存')}</div>
        ${saveError ? '<button class="btn btn-primary" id="btn-retry-save">重试保存</button>' : ''}
        <button class="btn btn-primary" id="btn-back-home">回首页</button>
      </div>`;
    $('btn-back-home').addEventListener('click', () => { location.hash = '#/'; });
    const retry = $('btn-retry-save');
    if (retry) retry.addEventListener('click', saveResults);
  }

  return { enter };
})();
