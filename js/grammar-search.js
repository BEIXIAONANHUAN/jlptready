// ============================================================
// 查语法（#/grammar/search）
// 镜像 js/search.js：顶部搜索框（.search-input，300ms 防抖），条目/中文释义/
// 主题词模糊搜索（DB.searchGrammar，最多 50 条）；点结果进详情页（条目/接续/
// 释义/例句/主题/级别 + 个人轨迹）。
// 与单词侧的差异：
// - 掌握状态徽标：未学/学习中/已掌握/薄弱（薄弱 = wrong_count>0 或 weak_reason
//   非空；无 user_grammar 行即未学），用 getUserGrammarStatsRows 建
//   grammar_id→行 映射；薄弱语法额外标注「需强化」。
// - 「强化自测」（v2.0 §5.3）：从薄弱语法池随机抽 5 题（getGrammarWeakRows
//   全量 + getGrammarQuestions + GrammarCore.groupQuestions，接续/语境/辨析
//   混合、有哪种抽哪种，同一语法最多 2 题），.option 四选一、答完立即显对错
//   +解析；做完显示对错数，成绩 addGrammarQuizStats(today, correct, N)。
//   移出薄弱池口径：某语法的题首次作答全对且被抽 ≥2 题 →
//   updateUserGrammar(id, GrammarCore.clearWeakFields())；只答对 1 题或只抽到
//   1 题不移除。薄弱池为空时按钮置灰提示「暂无薄弱语法」。
// - enter() 开头检查 window.__grammarSearchPreset（错题本「去强化」分流）：
//   存在则取出并 delete，填入搜索框自动搜索。
// 本页不写 streak、不调 maybeCompleteToday。
// ============================================================
window.GrammarSearch = (function () {
  const TYPE_LABEL = { continuation: '接续题', context: '语境题', similar: '辨析题' };
  const QUIZ_SIZE = 5; // 强化自测抽题数（v2.0 §5.3）

  let debounceTimer = null;
  let lastResults = [];
  let ugMap = {}; // grammar_id → user_grammar 行（掌握状态徽标用）

  // 进行中的强化自测会话
  let quiz = null; // { items:[{q, grammar, ug}], idx, correct, wrong, firstTry:{}, locked }

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
    const body = $('gh-search-body');
    if (!body) return;
    quiz = null;

    // 错题本「去强化」分流：取出预设搜索词（取出即删，避免影响后续进入）
    let preset = null;
    if (window.__grammarSearchPreset) {
      preset = window.__grammarSearchPreset;
      delete window.__grammarSearchPreset;
    }

    body.innerHTML = `
      <div class="search-bar">
        <input type="search" id="gh-search-input" class="search-input" placeholder="输入语法条目、中文释义或主题词" autocomplete="off">
      </div>
      <div id="gh-quiz-entry"></div>
      <div id="gh-search-result"><div class="placeholder">输入关键词开始搜索</div></div>`;

    renderQuizEntry();

    $('gh-search-input').addEventListener('input', (e) => {
      clearTimeout(debounceTimer);
      const q = e.target.value.trim();
      if (!q) {
        $('gh-search-result').innerHTML = '<div class="placeholder">输入关键词开始搜索</div>';
        return;
      }
      debounceTimer = setTimeout(() => doSearch(q), 300);
    });

    if (preset) {
      $('gh-search-input').value = preset;
      doSearch(preset);
    } else {
      $('gh-search-input').focus();
    }
  }

  // ---------- 强化自测入口按钮（顶部，薄弱池为空时置灰） ----------
  async function renderQuizEntry() {
    const box = $('gh-quiz-entry');
    if (!box) return;
    let empty = true;
    try {
      const weak = await DB.getGrammarWeakRows(1); // 只探池空不空
      empty = !weak.length;
    } catch (e) {
      console.error('[GrammarSearch] 薄弱池检查失败', e);
      empty = true; // 拉不到按空处理：按钮置灰，不自作主张放开
    }
    box.innerHTML = empty
      ? `<button class="btn btn-primary" id="gh-quiz-start" disabled>强化自测</button>
         <div class="preview-tip" style="margin-top:8px;">暂无薄弱语法</div>`
      : `<button class="btn btn-primary" id="gh-quiz-start">强化自测</button>
         <div class="preview-tip" style="margin-top:8px;">从薄弱语法中随机抽 ${QUIZ_SIZE} 题，同一语法的题全对可移出薄弱池</div>`;
    const btn = $('gh-quiz-start');
    if (btn && !empty) btn.addEventListener('click', startQuiz);
  }

  // ---------- 搜索 ----------
  async function doSearch(q) {
    const box = $('gh-search-result');
    box.innerHTML = '<div class="placeholder">搜索中…</div>';
    try {
      const [results, ugRows] = await Promise.all([
        DB.searchGrammar(q),
        DB.getUserGrammarStatsRows(), // 建 grammar_id→行 映射（徽标用）
      ]);
      lastResults = results;
      ugMap = {};
      for (const r of ugRows) ugMap[r.grammar_id] = r;
      renderList(q);
    } catch (e) {
      console.error('[GrammarSearch] 搜索失败', e);
      box.innerHTML = '<div class="placeholder">搜索失败，请检查网络后重试</div>';
    }
  }

  // 掌握状态徽标：未学（无行）/ 学习中 / 已掌握 / 薄弱（覆盖前两者），薄弱标「需强化」
  function statusBadge(gid) {
    const ug = ugMap[gid];
    if (!ug) return '<span class="lv-badge">未学</span>';
    const weak = (ug.wrong_count || 0) > 0 || !!ug.weak_reason;
    if (weak) return '<span class="lv-badge">薄弱</span> <span class="status-weak">需强化</span>';
    const text = ug.status === 'mastered' ? '已掌握' : ug.status === 'learning' ? '学习中' : '未学';
    return `<span class="lv-badge">${text}</span>`;
  }

  function renderList(q) {
    const box = $('gh-search-result');
    if (!lastResults.length) {
      box.innerHTML = '<div class="placeholder">未找到相关语法，建议换用中文主题词搜索</div>';
      return;
    }
    box.innerHTML = lastResults.map((g, i) => `
      <div class="wb-row search-row" data-idx="${i}">
        <div class="wb-info">
          <div class="wb-line1">
            <span class="wb-word jp">${esc(g.pattern)}</span>
            <span class="wb-reading jp">${esc(g.continuation || '')}</span>
            <span class="lv-badge">${esc(g.pos || '')}</span>
            ${statusBadge(g.id)}
          </div>
          <div class="wb-line2">${esc(g.meaning)}</div>
        </div>
      </div>`).join('');
    box.querySelectorAll('.search-row').forEach((el) => {
      el.addEventListener('click', () => renderDetail(lastResults[Number(el.dataset.idx)]));
    });
  }

  async function renderDetail(g) {
    const box = $('gh-search-result');
    box.innerHTML = '<div class="placeholder">加载详情…</div>';

    // 个人轨迹：学过日期 created_at、错几次 wrong_count、最近错因 weak_reason
    let ug = null;
    try {
      const ugs = await DB.getUserGrammarByGrammarIds([g.id]);
      ug = ugs && ugs.length ? ugs[0] : null;
    } catch (e) { console.warn('[GrammarSearch] 个人轨迹加载失败', e); }

    let trackHtml;
    if (!ug) {
      trackHtml = '<div class="detail-status">尚未学习</div>';
    } else {
      const weak = (ug.wrong_count || 0) > 0 || !!ug.weak_reason;
      const statusText = ug.status === 'mastered' ? '已掌握' : ug.status === 'learning' ? '学习中' : '未学';
      trackHtml = `
        <div class="detail-status">
          我的状态：<span class="num">${statusText}</span>${weak ? ' <span class="status-weak">薄弱 · 需强化</span>' : ''}
        </div>
        <div class="detail-block">
          <div class="detail-label">个人轨迹</div>
          <div>学过日期 <span class="num">${esc(ug.created_at ? String(ug.created_at).slice(0, 10) : '—')}</span>
            <span class="dot">·</span> 累计做错 <span class="num">${ug.wrong_count || 0}</span> 次
            <span class="dot">·</span> 最近错因 ${esc(ug.weak_reason || '—')}</div>
        </div>`;
    }

    const exampleHtml = (ja, zh) => ja ? `
      <div class="detail-block">
        <div class="detail-label">例句</div>
        <div class="detail-example jp">${esc(ja)}</div>
        ${zh ? `<div class="detail-example-zh">${esc(zh)}</div>` : ''}
      </div>` : '';

    box.innerHTML = `
      <div class="summary-card">
        <button class="btn btn-ghost" id="gh-back-list">← 返回结果列表</button>
        <div class="detail-word jp">${esc(g.pattern)}</div>
        <div class="detail-reading jp">${esc(g.continuation || '')}</div>
        <div class="detail-tags">
          ${g.pos ? `<span class="lv-badge">${esc(g.pos)}</span>` : ''}
          ${g.level ? `<span class="lv-badge">${esc(g.level)}</span>` : ''}
        </div>
        <div class="detail-block">
          <div class="detail-label">释义</div>
          <div>${esc(g.meaning)}</div>
        </div>
        ${exampleHtml(g.example1, g.example1_zh)}
        ${exampleHtml(g.example2, g.example2_zh)}
        ${trackHtml}
      </div>`;
    $('gh-back-list').addEventListener('click', () => renderList($('gh-search-input').value.trim()));
  }

  // ---------- 强化自测 ----------
  async function startQuiz() {
    if (quiz) return; // 测验进行中不重启
    const entryBtn = $('gh-quiz-start');
    if (entryBtn) entryBtn.disabled = true;
    const box = $('gh-search-result');
    box.innerHTML = '<div class="placeholder">正在组卷…</div>';
    try {
      const weak = await DB.getGrammarWeakRows(); // 全量薄弱池
      if (!weak.length) {
        await renderQuizEntry(); // 刷新为置灰态
        box.innerHTML = '<div class="placeholder">暂无薄弱语法</div>';
        return;
      }
      const gids = weak.map((r) => r.grammar_id);
      const [questions, grammars] = await Promise.all([
        DB.getGrammarQuestions(gids),
        DB.getGrammarsByIds(gids),
      ]);
      const grouped = GrammarCore.groupQuestions(questions); // grammar_id → {continuation,context,similar}
      const gById = {};
      for (const g of grammars) gById[g.id] = g;
      const ugById = {};
      for (const r of weak) ugById[r.grammar_id] = r;

      // 抽题：薄弱语法随机顺序，接续/语境/辨析混合（有哪种抽哪种），同一语法最多 2 题
      const picked = [];
      for (const gid of shuffle(gids.slice())) {
        if (picked.length >= QUIZ_SIZE) break;
        const buckets = grouped.get(gid);
        if (!buckets) continue;
        const pool = shuffle([...buckets.continuation, ...buckets.context, ...buckets.similar]);
        for (const q of pool.slice(0, 2)) {
          if (picked.length >= QUIZ_SIZE) break;
          picked.push({ q, grammar: gById[gid], ug: ugById[gid] });
        }
      }
      if (!picked.length) {
        box.innerHTML = '<div class="placeholder">暂无可出题的薄弱语法</div>';
        return;
      }
      quiz = { items: picked, idx: 0, correct: 0, wrong: 0, firstTry: {}, locked: false };
      renderQuizQuestion();
    } catch (e) {
      console.error('[GrammarSearch] 组卷失败', e);
      box.innerHTML = '<div class="placeholder">加载失败，请检查网络后重试</div>';
    }
  }

  function renderQuizQuestion() {
    if (!quiz) return;
    const item = quiz.items[quiz.idx];
    if (!item) { finalizeQuiz(); return; }

    const { q, grammar } = item;
    const options = q.options || [];
    const hint = q.type === 'continuation' ? '请选择正确的接续'
      : q.type === 'context' ? '请选择填入空格的语法'
      : '请选择最合适的语法';

    const optsHtml = options.map((o, i) =>
      `<button class="option" data-idx="${i}"><span class="opt-main jp">${esc(o)}</span></button>`).join('');

    $('gh-search-result').innerHTML = `
      <div class="quiz-progress">
        <span>强化自测 <span class="dot">·</span> 第 <span class="num">${quiz.idx + 1}</span>/<span class="num">${quiz.items.length}</span> 题</span>
        <span>答对 <span class="num">${quiz.correct}</span></span>
      </div>
      <div class="quiz-card" id="gh-quiz-card">
        <div class="quiz-type">${TYPE_LABEL[q.type] || ''} · ${hint}</div>
        <div class="quiz-prompt jp">${esc(q.question)}</div>
        ${q.question_zh ? `<div class="quiz-prompt quiz-prompt-zh" style="color:var(--color-text-sub);margin-top:-12px;">${esc(q.question_zh)}</div>` : ''}
        <div class="options">${optsHtml}</div>
        <div class="tap-continue" id="gh-tap-continue" style="display:none">点击继续</div>
      </div>
      <div class="word-detail" id="gh-quiz-explain" style="display:none"></div>`;

    document.querySelectorAll('#gh-search-result .option').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (quiz && quiz.locked) return; // 已作答：不拦截，冒泡到题目卡触发「点击继续」
        e.stopPropagation();             // 未作答：作答，不触发卡片点击
        answerQuiz(Number(el.dataset.idx));
      });
    });
    // 作答后点击题目卡任意位置进入下一题
    $('gh-quiz-card').addEventListener('click', proceedQuiz);
  }

  function answerQuiz(idx) {
    if (!quiz || quiz.locked) return;
    quiz.locked = true;

    const item = quiz.items[quiz.idx];
    const { q, grammar } = item;
    const correct = idx === q.correct;
    quiz.firstTry[q.id] = correct; // 每题只作答一次，首次作答即本次
    if (correct) quiz.correct++; else quiz.wrong++;

    const optEls = document.querySelectorAll('#gh-search-result .option');
    const card = $('gh-quiz-card');
    if (correct) {
      optEls[idx].classList.add('correct');
      card.classList.add('pop');
    } else {
      optEls[idx].classList.add('wrong');
      optEls[q.correct].classList.add('correct');
    }

    // 解析卡：条目 + 接续 + 释义 + 本题解析
    const explain = $('gh-quiz-explain');
    explain.innerHTML = `
      <div class="wd-jp jp">${esc(grammar.pattern)}</div>
      ${grammar.continuation ? `<div class="wd-pos jp" style="margin-bottom:10px;">接续：${esc(grammar.continuation)}</div>` : ''}
      <div class="wd-meaning">${esc(grammar.meaning)}</div>
      ${q.explanation ? `<div class="wd-pos" style="text-align:left;">${esc(q.explanation)}</div>` : ''}`;
    explain.style.display = '';
    const tip = $('gh-tap-continue');
    tip.style.display = '';
    setTimeout(() => tip.classList.add('fade'), 2000);
  }

  // 点击题目卡 → 下一题（队列空时 renderQuizQuestion 内部会进 finalizeQuiz）
  function proceedQuiz() {
    if (!quiz || !quiz.locked) return; // 未作答时点击无效
    quiz.locked = false;
    quiz.idx++;
    renderQuizQuestion();
  }

  // 收尾：成绩累加进当天 quiz_grammar_*；全对且被抽 ≥2 题的语法移出薄弱池
  async function finalizeQuiz() {
    const items = quiz.items;
    const total = items.length;
    const correct = quiz.correct;

    // 按语法聚合作答结果（首次作答口径）
    const perGrammar = {};
    for (const it of items) {
      const gid = it.grammar.id;
      if (!perGrammar[gid]) perGrammar[gid] = { ug: it.ug, grammar: it.grammar, total: 0, correct: 0 };
      perGrammar[gid].total++;
      if (quiz.firstTry[it.q.id]) perGrammar[gid].correct++;
    }

    const cleared = [];
    const box = $('gh-search-result');
    box.innerHTML = '<div class="placeholder">正在保存成绩…</div>';
    try {
      for (const gid of Object.keys(perGrammar)) {
        const p = perGrammar[gid];
        if (p.total >= 2 && p.correct === p.total) {
          await DB.updateUserGrammar(p.ug.id, GrammarCore.clearWeakFields());
          cleared.push(p.grammar.pattern);
        }
      }
      await DB.addGrammarQuizStats(DB.todayISO(), correct, total);
    } catch (e) {
      console.error('[GrammarSearch] 成绩保存失败', e);
      renderQuizSummary(correct, total, cleared, '成绩保存失败，请检查网络后重试');
      return;
    }
    renderQuizSummary(correct, total, cleared, null);
  }

  function renderQuizSummary(correct, total, cleared, saveError) {
    const wrong = total - correct;
    $('gh-search-result').innerHTML = `
      <div class="summary-card">
        <div class="summary-head">强化自测完成</div>
        <div class="done-grid">
          <div class="done-item"><div class="done-num num">${total}</div><div class="done-label">总题数</div></div>
          <div class="done-item"><div class="done-num num">${correct}</div><div class="done-label">答对</div></div>
          <div class="done-item"><div class="done-num num">${wrong}</div><div class="done-label">答错</div></div>
        </div>
        <div class="done-status">
          ${cleared.length ? `已移出薄弱池：<span class="jp">${cleared.map(esc).join('</span>、<span class="jp">')}</span>` : '本次没有语法移出薄弱池'}
          ${saveError ? `<br>${esc(saveError)}` : ''}
        </div>
        <button class="btn btn-primary" id="gh-quiz-back">返回</button>
      </div>`;
    $('gh-quiz-back').addEventListener('click', async () => {
      quiz = null;
      await renderQuizEntry(); // 薄弱池可能已清空，刷新按钮置灰态
      const q = $('gh-search-input') ? $('gh-search-input').value.trim() : '';
      if (q) doSearch(q); // 回到列表并刷新徽标状态
      else $('gh-search-result').innerHTML = '<div class="placeholder">输入关键词开始搜索</div>';
    });
  }

  return { enter };
})();
