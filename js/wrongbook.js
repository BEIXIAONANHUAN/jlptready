// ============================================================
// 错题本（薄弱词池展示页，#/wrongbook）
// - 纯信息展示，不做题。
// - 薄弱词口径与前几步一致：wrong_count>0 或 weak_reason 非空。
// - 默认按做错次数降序，可点击切换升/降序。
// - 「去强化」跳到今日复习（#/review）。
// ============================================================
window.WrongBook = (function () {
  let rows = [];       // [{uw, word}]
  let desc = true;     // 做错次数排序方向：true=降序

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function enter() {
    const body = $('wrongbook-body');
    if (!body) return;
    body.innerHTML = '<div class="placeholder">正在加载…</div>';
    try {
      const weak = await DB.getWeakRows(1000);
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
      el.addEventListener('click', () => { location.hash = '#/review'; });
    });
  }

  return { enter };
})();
