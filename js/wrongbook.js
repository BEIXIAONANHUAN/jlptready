// ============================================================
// 错题本（薄弱词池展示页，#/wrongbook）
// - 薄弱词口径与前几步一致：wrong_count>0 或 weak_reason 非空。
// - 默认按做错次数降序，可点击切换升/降序。
// - 「去强化」直接在本页对这一个词出 2 道题（界面与判定复用模式 B 复习的
//   做题交互：四选一、答完即判对错、只看【首次作答】、答错的题插回重练到对为止）。
//   作答后题目卡下方显示详情卡（释义/日汉字+假名/词性），点击题目卡继续。
//   · 两题首次全对 → 移出薄弱池：weak_reason 置空、wrong_count 清零
//     （口径含 wrong_count>0，只置空 weak_reason 词仍会留在池里，故一并清零）、
//     mode_b_due 顺延一天（learning 词明天照常到期复习；对 mastered 词该字段无影响）。
//   · 任一首次答错 → 维持 weak_reason，wrong_count+1，仍留在薄弱池。
//   强化结果立即写库，完成后返回错题本并重新查库刷新列表。
// ============================================================
window.WrongBook = (function () {
  const TYPE_LABEL = { reading: '读音题', writing: '写法题', meaning: '释义题' };

  let rows = [];       // [{uw, word}]
  let desc = true;     // 做错次数排序方向：true=降序
  let drillPool = null; // 干扰项池（首次强化时懒加载）
  let drill = null;    // 进行中的强化会话 { item, queue, attempts, current, inputLock }

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  async function enter() {
    const body = $('wrongbook-body');
    if (!body) return;
    drill = null;
    body.innerHTML = '<div class="placeholder">正在加载…</div>';
    try {
      const weak = await DB.getWeakRows(); // 分页拉全量，无 1000 条静默截断
      if (!weak.length) {
        rows = [];
        render();
        return;
      }
      const words = await DB.getWordsByIds(weak.map((r) => r.word_id));
      const byId = {};
      for (const w of words) byId[w.id] = w;
      rows = weak.map((uw) => ({ uw, word: byId[uw.word_id] })).filter((x) => x.word);
      render();
    } catch (e) {
      console.error('[WrongBook] 加载失败', e);
      body.innerHTML = '<div class="placeholder">加载失败，请检查网络后重新进入</div>';
    }
  }

  function render() {
    const body = $('wrongbook-body');
    if (!rows.length) {
      body.innerHTML = '<div class="placeholder">暂无薄弱词，保持住</div>';
      return;
    }

    const sorted = rows.slice().sort((a, b) =>
      desc ? b.uw.wrong_count - a.uw.wrong_count : a.uw.wrong_count - b.uw.wrong_count
    );

    const listHtml = sorted.map(({ uw, word }) => `
      <div class="wb-row">
        <div class="wb-info">
          <div class="wb-line1">
            <span class="wb-word jp">${esc(word.word)}</span>
            <span class="wb-reading jp">${esc(word.reading)}</span>
            <span class="wb-count num">错 <span class="num">${uw.wrong_count}</span> 次</span>
          </div>
          <div class="wb-line2">${esc(word.meaning)} <span class="dot">·</span> ${esc(uw.weak_reason || '—')}</div>
        </div>
        <button class="btn btn-ghost wb-go" data-id="${uw.id}">去强化</button>
      </div>`).join('');

    body.innerHTML = `
      <div class="wb-head">
        <span>共 <span class="num">${rows.length}</span> 个薄弱词</span>
        <button class="btn btn-ghost" id="wb-sort">做错次数 ${desc ? '↓' : '↑'}</button>
      </div>
      ${listHtml}`;

    $('wb-sort').addEventListener('click', () => {
      desc = !desc;
      render();
    });
    body.querySelectorAll('.wb-go').forEach((el) => {
      el.addEventListener('click', () => startDrill(el.dataset.id));
    });
  }

  // ---------- 去强化（本页做题） ----------

  // 题型抽取与模式 B 复习一致：纯假名词只有释义题（出 2 道），其余 3 种里随机抽 2 种
  function pickTypes(w) {
    const valid = w.word === w.reading ? ['meaning'] : ['reading', 'writing', 'meaning'];
    shuffle(valid);
    const types = valid.slice(0, 2);
    while (types.length < 2) types.push(valid[0]);
    return types;
  }

  async function startDrill(uwId) {
    const item = rows.find((x) => String(x.uw.id) === String(uwId));
    if (!item) return;
    try {
      if (!drillPool) drillPool = await DB.getDistractorPool();
    } catch (e) {
      console.error('[WrongBook] 干扰项池加载失败', e);
      alert('加载失败，请检查网络后重试');
      return;
    }
    const queue = pickTypes(item.word).map((type, k) => ({ qid: 'q' + k, type }));
    shuffle(queue);
    drill = { item, queue, attempts: {}, current: null, inputLock: false };
    renderDrill();
  }

  // 四选一选项：与复习同规则——干扰项优先同 level、同词性，互不重复；
  // 读音题/写法题排除 reading 不含假名的词（防止英文罗马字混入选项）。
  function buildOptions(word, type) {
    const field = type === 'reading' ? 'reading' : 'word';
    const seen = new Set([word[field]]);
    const picks = [];
    const tiers = [
      drillPool.filter((p) => p.level === word.level && p.pos === word.pos),
      drillPool.filter((p) => p.level === word.level),
      drillPool,
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

  function renderDrill() {
    if (!drill) return;
    const q = drill.queue[0];
    if (!q) { finalizeDrill(); return; }

    const w = drill.item.word;
    const options = buildOptions(w, q.type);
    drill.current = { q, options, answerIdx: options.findIndex((o) => o.id === w.id) };
    drill.inputLock = false;

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

    $('wrongbook-body').innerHTML = `
      <div class="quiz-progress">
        <span>去强化 · <span class="jp">${esc(w.word)}</span></span>
        <span>剩余 <span class="num">${drill.queue.length}</span> 题</span>
      </div>
      <div class="quiz-card" id="quiz-card">
        <div class="quiz-type">${TYPE_LABEL[q.type]} · ${hint}</div>
        ${promptHtml}
        <div class="options">${optsHtml}</div>
        <div class="tap-continue" id="tap-continue" style="display:none">点击继续</div>
      </div>
      <div class="word-detail" id="word-detail" style="display:none"></div>`;

    document.querySelectorAll('#wrongbook-body .option').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (drill.inputLock) return; // 已作答：不拦截，冒泡到题目卡触发「点击继续」
        e.stopPropagation();         // 未作答：作答，不触发卡片点击
        drillAnswer(Number(el.dataset.idx));
      });
    });
    // 作答后点击题目卡任意位置进入下一题
    $('quiz-card').addEventListener('click', drillProceed);
  }

  function drillAnswer(idx) {
    if (drill.inputLock || !drill.current) return;
    drill.inputLock = true;

    const q = drill.queue[0];
    const w = drill.item.word;
    const correct = idx === drill.current.answerIdx;
    const firstTry = !(q.qid in drill.attempts); // 重练的题不再计入判定
    const optEls = document.querySelectorAll('#wrongbook-body .option');
    const card = $('quiz-card');

    if (correct) {
      drill.queue.shift();
      optEls[idx].classList.add('correct');
      card.classList.add('pop'); // 卡片轻微上浮 + 绿色边框
    } else {
      // 错题插回剩余题目的随机位置重练（不放最前），直到答对
      drill.queue.shift();
      const pos = drill.queue.length ? 1 + Math.floor(Math.random() * drill.queue.length) : 0;
      drill.queue.splice(pos, 0, q);
      optEls[idx].classList.add('wrong');
      optEls[drill.current.answerIdx].classList.add('correct');
    }
    if (firstTry) drill.attempts[q.qid] = correct;

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

  // 点击题目卡 → 下一题（队列空时 renderDrill 内部会进 finalizeDrill）
  function drillProceed() {
    if (!drill || !drill.inputLock || !drill.current) return; // 未作答时点击无效
    drill.inputLock = false;
    drill.current = null;
    renderDrill();
  }

  // 两题都完成首次作答 → 按首次作答结果判定并写库
  async function finalizeDrill() {
    const { uw, word } = drill.item;
    const results = Object.values(drill.attempts);
    const allCorrect = results.length === 2 && results.every(Boolean);
    const body = $('wrongbook-body');
    body.innerHTML = '<div class="placeholder">正在保存强化结果…</div>';
    try {
      if (allCorrect) {
        await DB.updateUserWord(uw.id, {
          weak_reason: null,
          wrong_count: 0, // 一并清零，否则按口径（wrong_count>0）词仍留在薄弱池
          mode_b_due: DB.tomorrowISO(),
        });
      } else {
        await DB.updateUserWord(uw.id, { wrong_count: (uw.wrong_count || 0) + 1 });
      }
    } catch (e) {
      console.error('[WrongBook] 强化结果保存失败', e);
      body.innerHTML = `
        <div class="summary-card">
          <div class="summary-head">强化完成</div>
          <div class="done-status">结果保存失败，请检查网络后重试</div>
          <div class="summary-btns">
            <button class="btn btn-secondary" id="wb-back">返回错题本</button>
            <button class="btn btn-primary" id="wb-retry">重试保存</button>
          </div>
        </div>`;
      $('wb-retry').addEventListener('click', finalizeDrill);
      $('wb-back').addEventListener('click', () => { drill = null; enter(); });
      return;
    }

    drill = null;
    body.innerHTML = `
      <div class="summary-card">
        <div class="summary-head">强化完成</div>
        <div class="summary-score"><span class="jp">${esc(word.word)}</span> <span class="dot">·</span> ${esc(word.meaning)}</div>
        <div class="done-status">${allCorrect ? '两题全对，已移出薄弱词池' : '仍有首次答错，保留在薄弱词池（做错次数 +1）'}</div>
        <button class="btn btn-primary" id="wb-back">返回错题本</button>
      </div>`;
    $('wb-back').addEventListener('click', enter); // 重新查库刷新列表
  }

  return { enter };
})();
