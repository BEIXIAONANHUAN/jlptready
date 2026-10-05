// ============================================================
// 门户页（#/）：单词 / 语法两张入口卡片的进度小字
// 表里如一：卡片状态与对应板块首页同一事实源——
//   完成判定读 daily_logs，到期数读 user_words / user_grammar，断点读 user_session_progress。
// 状态机（门户设计 v1.0 §1.3，两卡各七态）：
//   有任务 / 进行中 / 今日完成 / 休息日（置灰仍可点）/ 全部学完 /
//   加载失败（点击重试，不静默）/ grammar 表为空（「数据准备中」置灰不可点，仅语法卡）
// ============================================================
window.Landing = (function () {
  const $ = (id) => document.getElementById(id);
  const NEW_WORDS_PER_DAY = 50;   // 与 home.js 今日新词卡片口径一致
  const NEW_GRAMMAR_PER_DAY = 6;  // 语法每日新学 6 个（v2.0 §3.2）

  // grammar 表还没建（部署中间态）：视同「空库」，显示数据准备中而非加载失败
  function isTableMissing(e) {
    return !!e && (e.code === '42P01' || /does not exist/i.test(e.message || ''));
  }

  function setDisabled(btn, on) {
    btn.classList.toggle('is-disabled', on);
    btn.setAttribute('aria-disabled', on ? 'true' : 'false');
  }

  // 加载失败态：点击按钮改为重试（拦截跳转），成功后恢复
  function fail(meta, btn, retry, e) {
    console.warn('[Landing] 卡片数据加载失败', e);
    meta.textContent = '加载失败 · 点击重试';
    btn.onclick = (ev) => {
      ev.preventDefault();
      btn.onclick = null;
      meta.textContent = '加载中…';
      retry();
    };
  }

  function resetCard(card, btn) {
    card.classList.remove('is-closed');
    setDisabled(btn, false);
    btn.onclick = null;
    btn.textContent = '进入学习 ›';
  }

  // ---------- 单词卡（事实源与 words 首页/home.js 相同） ----------
  async function renderWordsCard() {
    const card = $('landing-card-words'), meta = $('landing-words-meta'), btn = $('landing-btn-words');
    if (!card) return;
    resetCard(card, btn);

    let log, dueB, dueA, newLeft, rowCount, total;
    try {
      [log, dueB, dueA, newLeft, rowCount, total] = await Promise.all([
        DB.getDailyLog(DB.todayISO()),
        DB.getReviewDueCount(),
        DB.getModeADueCount(),
        DB.getNewWordCount(),
        DB.getUserWordsRowCount(),
        DB.getWordTotal(),
      ]);
    } catch (e) {
      fail(meta, btn, renderWordsCard, e);
      return;
    }
    const due = dueB + dueA;

    if (log && log.is_rest) {
      meta.textContent = '今日宜休';
      card.classList.add('is-closed');
      return;
    }
    // 全部学完：每词都有学习记录且没有 unlearned 行且今日无到期
    // （不能只看 unlearned=0——未排入队列的词根本没有 user_words 行）
    if (rowCount >= total && newLeft === 0 && due === 0) {
      meta.textContent = `${total} 词全部学完`;
      return;
    }
    if (log && (log.new_words_count || 0) > 0 && due === 0) {
      meta.textContent = '今日任务已完成';
      return;
    }
    // 进行中：断点存在且未结束（与 home.js renderNewCard 的进行中判定同源）
    try {
      const row = await DB.getSessionProgress('new', DB.todayISO());
      const s = row && row.queue_snapshot;
      if (s && s.stage !== 'done' && s.stage !== 'empty' && s.words && s.groups && s.groups.length) {
        const done = Math.min(s.words.length, Math.round((s.groupIndex || 0) * s.words.length / s.groups.length));
        meta.textContent = `今日新词已完成 ${done}/${s.words.length}`;
        return;
      }
    } catch (e) { /* 断点读取失败不挡卡片，落默认态 */ }

    meta.textContent = `今日 ${NEW_WORDS_PER_DAY} 词 · 待复习 ${due} 词`;
  }

  // ---------- 语法卡（事实源：daily_logs.new_grammar_count + user_grammar 到期） ----------
  async function renderGrammarCard() {
    const card = $('landing-card-grammar'), meta = $('landing-grammar-meta'), btn = $('landing-btn-grammar');
    if (!card) return;
    resetCard(card, btn);

    let log, total, newLeft, dueB, dueA, rowCount;
    try {
      [log, total, newLeft, dueB, dueA, rowCount] = await Promise.all([
        DB.getDailyLog(DB.todayISO()),
        DB.getGrammarTotal(),
        DB.getGrammarNewCount(),
        DB.getGrammarReviewDueCount(),
        DB.getGrammarModeADueCount(),
        DB.getUserGrammarRowCount(),
      ]);
    } catch (e) {
      if (isTableMissing(e)) {
        meta.textContent = '数据准备中';
        card.classList.add('is-closed');
        setDisabled(btn, true);
      } else {
        fail(meta, btn, renderGrammarCard, e);
      }
      return;
    }

    // grammar 表为空（数据未导入）：置灰不可点
    if (!total) {
      meta.textContent = '数据准备中';
      card.classList.add('is-closed');
      setDisabled(btn, true);
      return;
    }

    const due = dueB + dueA;
    if (log && log.is_rest) {
      meta.textContent = '今日宜休';
      card.classList.add('is-closed');
      return;
    }
    // 全部学完（判定口径同单词卡：每个语法都有进度行且无 unlearned）
    if (rowCount >= total && newLeft === 0 && due === 0) {
      meta.textContent = `${total} 条语法全部学完`;
      return;
    }
    if (log && (log.new_grammar_count || 0) > 0) {
      meta.textContent = due > 0 ? `今日新语法已完成 · 待复习 ${due} 个` : '今日任务已完成';
      return;
    }
    // 进行中：'grammar_new' 断点（第 3 阶段 grammarnew.js 写入，快照含 passedCount；
    // 没有 passedCount 时按组进度估算，与单词卡同法）
    try {
      const row = await DB.getSessionProgress('grammar_new', DB.todayISO());
      const s = row && row.queue_snapshot;
      if (s && s.stage !== 'done' && s.stage !== 'empty') {
        const total6 = (s.items && s.items.length) || (s.words && s.words.length) || NEW_GRAMMAR_PER_DAY;
        let done = s.passedCount;
        if (done == null && s.groups && s.groups.length) {
          done = Math.min(total6, Math.round((s.groupIndex || 0) * total6 / s.groups.length));
        }
        meta.textContent = `今日新语法已完成 ${done || 0}/${total6}`;
        return;
      }
    } catch (e) { /* 断点读取失败不挡卡片，落默认态 */ }

    meta.textContent = `今日 ${NEW_GRAMMAR_PER_DAY} 个新语法 · 待复习 ${due} 个`;
  }

  function init() {
    renderWordsCard();
    renderGrammarCard();
  }

  return { init, onShow: init };
})();
