// ============================================================
// 语法错题本（薄弱语法池展示页，#/grammar/wrongbook）
// 镜像 js/wrongbook.js，事实源换成 grammar 三表：
// - 薄弱口径与单词侧一致：wrong_count>0 或 weak_reason 非空。
// - getGrammarWeakRows() 不传 limit = 分页拉全量（无 1000 条静默截断），
//   再按 grammar_id 关联 getGrammarsByIds 取条目详情。
// - 每行显示：语法条目(jp)、接续(jp)、释义、进入薄弱池原因 weak_reason、
//   做错次数 wrong_count；默认降序，复用 wrongbook.js 的排序切换模式。
// - 「去强化」：该语法今日到期（在 getGrammarModeBDueRows / getGrammarModeADueRows
//   结果里）→ 跳 #/grammar/review；未到期 → 弹确认 modal，确认后分流到
//   查语法页做强化自测（window.__grammarSearchPreset 预填该条目 pattern）。
// ============================================================
window.GrammarWrongbook = (function () {
  let rows = [];          // [{ug, grammar}]
  let desc = true;        // 做错次数排序方向：true=降序
  let dueIds = new Set(); // 今日到期的 grammar_id（模式 B + 模式 A 并集）

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function enter() {
    const body = $('gh-wrongbook-body');
    if (!body) return;
    body.innerHTML = '<div class="placeholder">正在加载…</div>';
    try {
      const [weak, dueB, dueA] = await Promise.all([
        DB.getGrammarWeakRows(),      // 分页拉全量，无 1000 条静默截断
        DB.getGrammarModeBDueRows(),  // 今日到期（模式 B）
        DB.getGrammarModeADueRows(),  // 今日到期（模式 A）
      ]);
      dueIds = new Set([...dueB, ...dueA].map((r) => r.grammar_id));
      if (!weak.length) {
        rows = [];
        render();
        return;
      }
      const grammars = await DB.getGrammarsByIds(weak.map((r) => r.grammar_id));
      const byId = {};
      for (const g of grammars) byId[g.id] = g;
      rows = weak.map((ug) => ({ ug, grammar: byId[ug.grammar_id] })).filter((x) => x.grammar);
      render();
    } catch (e) {
      console.error('[GrammarWrongbook] 加载失败', e);
      body.innerHTML = '<div class="placeholder">加载失败，请检查网络后重新进入</div>';
    }
  }

  function render() {
    const body = $('gh-wrongbook-body');
    if (!rows.length) {
      body.innerHTML = '<div class="placeholder">暂无薄弱语法</div>';
      return;
    }

    const sorted = rows.slice().sort((a, b) =>
      desc ? b.ug.wrong_count - a.ug.wrong_count : a.ug.wrong_count - b.ug.wrong_count
    );

    const listHtml = sorted.map(({ ug, grammar }) => `
      <div class="wb-row">
        <div class="wb-info">
          <div class="wb-line1">
            <span class="wb-word jp">${esc(grammar.pattern)}</span>
            <span class="wb-reading jp">${esc(grammar.continuation || '')}</span>
            <span class="wb-count num">错 <span class="num">${ug.wrong_count}</span> 次</span>
          </div>
          <div class="wb-line2">${esc(grammar.meaning)} <span class="dot">·</span> ${esc(ug.weak_reason || '—')}</div>
        </div>
        <button class="btn btn-ghost wb-go" data-gid="${grammar.id}">去强化</button>
      </div>`).join('');

    body.innerHTML = `
      <div class="wb-head">
        <span>共 <span class="num">${rows.length}</span> 个薄弱语法</span>
        <button class="btn btn-ghost" id="gwb-sort">做错次数 ${desc ? '↓' : '↑'}</button>
      </div>
      ${listHtml}`;

    $('gwb-sort').addEventListener('click', () => {
      desc = !desc;
      render();
    });
    body.querySelectorAll('.wb-go').forEach((el) => {
      el.addEventListener('click', () => goReinforce(Number(el.dataset.gid)));
    });
  }

  // 去强化：今日到期 → 跳复习页；未到期 → 确认后分流查语法页做强化自测
  function goReinforce(gid) {
    const item = rows.find((x) => x.grammar.id === gid);
    if (!item) return;
    if (dueIds.has(gid)) {
      location.hash = '#/grammar/review';
      return;
    }
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title">该语法今日未到期</div>
        <div class="modal-text">去查语法页做强化自测？</div>
        <div class="modal-btns">
          <button class="btn btn-secondary" id="gwb-modal-no">取消</button>
          <button class="btn btn-primary" id="gwb-modal-yes">去强化自测</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#gwb-modal-no').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#gwb-modal-yes').addEventListener('click', () => {
      overlay.remove();
      window.__grammarSearchPreset = item.grammar.pattern;
      location.hash = '#/grammar/search';
    });
  }

  return { enter };
})();
