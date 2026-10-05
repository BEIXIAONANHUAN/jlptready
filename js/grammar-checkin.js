// ============================================================
// 语法打卡（#/grammar/checkin）：语法月历热力图
// 镜像 js/checkin.js 的月历页，事实源全部换成 daily_logs 的语法列
// （new_grammar_count / grammar_test_score / grammar_test_rating / grammar_streak），
// is_rest 全局共用。不读写单词侧任何列。
//
// ---------- 月历四态 ----------
// 完成（grammar_streak>0，翡翠绿 cal-done）/ 周末高分
// （grammar_test_rating 为 S 或 A，cal-high）/ 休息日（is_rest，cal-rest）/
// 未学习（cal-none）。优先级：休息日 > 高分 > 完成。
//
// ---------- 渲染时序 ----------
// 先渲染月历（不被补判阻塞）→ 后台 GrammarCore.ensureTodayCheckedIn()
// 语法打卡补判 → written 则重绘月历（今天格子变绿）。补判失败不影响页面。
// ============================================================
window.GrammarCheckin = (function () {
  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let vy = 0, vm = 0; // 月历当前查看的年/月（month 0-based）

  async function enter() {
    const now = new Date();
    vy = now.getFullYear();
    vm = now.getMonth();
    const rendered = renderCalendar().catch((e) => {
      console.error('[GrammarCheckin] 月历渲染失败', e);
    });
    rendered.then(async () => {
      try {
        const result = await GrammarCore.ensureTodayCheckedIn(); // 语法打卡补判（幂等）
        if (result && result.written) await renderCalendar();
      } catch (e) {
        console.error('[GrammarCheckin] 打卡补判失败', e);
      }
    });
    await rendered;
  }

  // 某天四态：rest / high / done / none（优先级：休息 > 高分 > 完成）
  function dayState(log) {
    if (!log) return 'none';
    if (log.is_rest) return 'rest';
    if (log.grammar_test_rating === 'S' || log.grammar_test_rating === 'A') return 'high';
    if ((log.grammar_streak || 0) > 0) return 'done';
    return 'none';
  }

  async function renderCalendar() {
    const body = $('gh-checkin-body');
    if (!body) return;
    body.innerHTML = '<div class="placeholder">正在加载…</div>';
    try {
      const [logs, streak, totalDays] = await Promise.all([
        DB.getMonthLogs(vy, vm),
        DB.getGrammarStreak(),
        DB.getGrammarStudyDaysTotal(),
      ]);
      const map = {};
      for (const l of logs) map[l.date] = l;

      const now = new Date();
      const isCurrentMonth = vy === now.getFullYear() && vm === now.getMonth();
      const daysInMonth = new Date(vy, vm + 1, 0).getDate();
      const elapsed = isCurrentMonth ? now.getDate() : daysInMonth; // 已过天数

      // 本月完成率：完成天数 /（已过天数 - 休息天数），休息日不拉低完成率
      let done = 0, rest = 0;
      for (let d = 1; d <= elapsed; d++) {
        const log = map[`${vy}-${String(vm + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`];
        if (log && (log.grammar_streak || 0) > 0) done++;
        else if (log && log.is_rest) rest++;
      }
      const rate = elapsed - rest > 0 ? Math.round((done / (elapsed - rest)) * 100) : 0;

      // 月历格子（周一开头）
      const offset = (new Date(vy, vm, 1).getDay() + 6) % 7;
      let cells = '';
      for (let i = 0; i < offset; i++) cells += '<div class="cal-cell cal-blank"></div>';
      for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${vy}-${String(vm + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const isFuture = dateStr > DB.todayISO();
        const state = isFuture ? 'future' : dayState(map[dateStr]);
        const isToday = dateStr === DB.todayISO();
        cells += `<div class="cal-cell cal-${state}${isToday ? ' cal-today' : ''}" data-date="${isFuture ? '' : dateStr}">${d}</div>`;
      }

      body.innerHTML = `
        <div class="cal-stats">
          <span>当前 Streak <span class="num streak-num">${streak}</span> 天</span>
          <span class="dot">·</span>
          <span>本月完成率 <span class="num">${rate}%</span></span>
          <span class="dot">·</span>
          <span>总学习天数 <span class="num">${totalDays}</span></span>
        </div>
        <div class="cal-head">
          <button class="btn btn-ghost" id="gcal-prev">← 上月</button>
          <span class="cal-month num">${vy} 年 ${vm + 1} 月</span>
          <button class="btn btn-ghost" id="gcal-next">下月 →</button>
        </div>
        <div class="cal-week">${['一', '二', '三', '四', '五', '六', '日'].map((d) => `<span>${d}</span>`).join('')}</div>
        <div class="cal-grid">${cells}</div>
        <div class="cal-legend">
          <span><i class="sw cal-done"></i>完成</span>
          <span><i class="sw cal-high"></i>周末高分</span>
          <span><i class="sw cal-rest"></i>休息日</span>
          <span><i class="sw cal-none"></i>未学习</span>
        </div>`;

      $('gcal-prev').addEventListener('click', () => { vm--; if (vm < 0) { vm = 11; vy--; } renderCalendar(); });
      $('gcal-next').addEventListener('click', () => { vm++; if (vm > 11) { vm = 0; vy++; } renderCalendar(); });
      body.querySelectorAll('.cal-cell[data-date]').forEach((el) => {
        if (!el.dataset.date) return;
        el.addEventListener('click', () => openDay(el.dataset.date, map[el.dataset.date]));
      });
    } catch (e) {
      console.error('[GrammarCheckin] 月历加载失败', e);
      body.innerHTML = '<div class="placeholder">加载失败，请检查网络后重新进入</div>';
    }
  }

  // ---------- 当日详情弹窗（只显示语法列） ----------
  function openDay(dateStr, log) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const title = `${m}月${d}日 ${WEEKDAYS[new Date(y, m - 1, d).getDay()]}`;
    const show = (v) => (v == null ? '—' : `<span class="num">${v}</span>`);
    const examText = log && log.grammar_test_score != null
      ? `<span class="num">${log.grammar_test_score}</span> 分 / ${esc(log.grammar_test_rating || '—')}`
      : '—';

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title">${title}${log && log.is_rest ? ' <span class="rest-tag">休息日</span>' : ''}</div>
        <div class="modal-row">新语法 ${show(log && log.new_grammar_count)} 个</div>
        <div class="modal-row">语法考试 ${examText}</div>
        <div class="modal-row">Streak ${show(log && log.grammar_streak)} 天</div>
        <button class="btn btn-primary" id="gcal-modal-close">关闭</button>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#gcal-modal-close').addEventListener('click', () => overlay.remove());
  }

  return { enter };
})();
