// ============================================================
// 查单词（#/search）
// 顶部搜索框，汉字/假名/中文模糊搜索 words 表；点结果进详情页：
// 完整信息 + 例句（有才显示）+ 我的掌握状态（未学习则不显示额外信息）。
// ============================================================
window.Search = (function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let debounceTimer = null;
  let lastResults = [];

  function enter() {
    const body = $('search-body');
    if (!body) return;
    body.innerHTML = `
      <div class="search-bar">
        <input type="search" id="search-input" class="search-input" placeholder="输入汉字、假名或中文" autocomplete="off">
      </div>
      <div id="search-result"><div class="placeholder">输入关键词开始搜索</div></div>`;
    $('search-input').addEventListener('input', (e) => {
      clearTimeout(debounceTimer);
      const q = e.target.value.trim();
      if (!q) {
        $('search-result').innerHTML = '<div class="placeholder">输入关键词开始搜索</div>';
        return;
      }
      debounceTimer = setTimeout(() => doSearch(q), 300);
    });
    $('search-input').focus();
  }

  async function doSearch(q) {
    const box = $('search-result');
    box.innerHTML = '<div class="placeholder">搜索中…</div>';
    try {
      lastResults = await DB.searchWords(q);
      renderList(q);
    } catch (e) {
      console.error('[Search] 搜索失败', e);
      box.innerHTML = '<div class="placeholder">搜索失败，请检查网络后重试</div>';
    }
  }

  function renderList(q) {
    const box = $('search-result');
    if (!lastResults.length) {
      box.innerHTML = `<div class="placeholder">没有找到与「${esc(q)}」相关的单词</div>`;
      return;
    }
    box.innerHTML = lastResults.map((w, i) => `
      <div class="wb-row search-row" data-idx="${i}">
        <div class="wb-info">
          <div class="wb-line1">
            <span class="wb-word jp">${esc(w.word)}</span>
            <span class="wb-reading jp">${esc(w.reading)}</span>
            <span class="lv-badge">${esc(w.level || '')}</span>
          </div>
          <div class="wb-line2">${esc(w.pos || '')}${w.pos ? ' · ' : ''}${esc(w.meaning)}</div>
        </div>
      </div>`).join('');
    box.querySelectorAll('.search-row').forEach((el) => {
      el.addEventListener('click', () => renderDetail(lastResults[Number(el.dataset.idx)]));
    });
  }

  async function renderDetail(w) {
    const box = $('search-result');
    box.innerHTML = '<div class="placeholder">加载详情…</div>';

    // 我的掌握状态：未学习 / 学习中 / 已掌握 / 薄弱（weak_reason 非空即薄弱口径）
    let uw = null;
    try {
      uw = await DB.getUserWordByWordId(w.id);
    } catch (e) { console.warn('[Search] 状态加载失败', e); }

    let statusHtml = '';
    if (uw) {
      const isWeak = (uw.wrong_count || 0) > 0 || !!uw.weak_reason;
      const statusText = uw.status === 'mastered' ? '已掌握' : uw.status === 'learning' ? '学习中' : '未学习';
      statusHtml = `
        <div class="detail-status">
          我的状态：<span class="num">${statusText}</span>${isWeak ? ' <span class="status-weak">薄弱</span>' : ''}${(uw.wrong_count || 0) > 0 ? ` <span class="dot">·</span> 累计做错 <span class="num">${uw.wrong_count}</span> 次` : ''}
        </div>`;
    }

    const exampleHtml = w.example_ja
      ? `<div class="detail-block">
           <div class="detail-label">例句</div>
           <div class="detail-example jp">${esc(w.example_ja)}</div>
           ${w.example_zh ? `<div class="detail-example-zh">${esc(w.example_zh)}</div>` : ''}
         </div>`
      : '';

    box.innerHTML = `
      <div class="summary-card">
        <button class="btn btn-ghost" id="btn-back-list">← 返回结果列表</button>
        <div class="detail-word jp">${esc(w.word)}</div>
        <div class="detail-reading jp">${esc(w.reading)}</div>
        <div class="detail-tags">
          ${w.level ? `<span class="lv-badge">${esc(w.level)}</span>` : ''}
          ${w.pos ? `<span class="lv-badge">${esc(w.pos)}</span>` : ''}
        </div>
        <div class="detail-block">
          <div class="detail-label">释义</div>
          <div>${esc(w.meaning)}</div>
        </div>
        ${exampleHtml}
        ${statusHtml}
      </div>`;
    $('btn-back-list').addEventListener('click', () => renderList($('search-input').value.trim()));
  }

  return { enter };
})();
