// ============================================================
// 打卡（#/checkin）：自动打卡判定 + Streak 连击 + 今日宜休 + 月历热力图
//
// ---------- 打卡口径 ----------
// - 每日完成全部任务 → 自动打卡：当天 daily_logs.streak 写入连击数（>0 即视为已打卡）。
//   平时（周一至周五）：新词 50 词完成（new_words_count>0）+ 系统推送复习清零；
//   周末：周末考试完成（test_score 非空）+ 复习清零。
//   判定时机：新词 / 复习 / 考试任一流程收尾时调用 maybeCompleteToday()。
// - 断签：某天既未完成任务也未点宜休 → 连击中断，显示值自动归零。
// - 休息日（is_rest=true）：不打卡、不断签、Streak 保持。
//
// ---------- Streak 显示口径 ----------
// 从今天（未达标则从昨天）往回数「streak>0 或 is_rest」的连续天数（见 DB.getStreak）。
//
// ---------- 月历四态 ----------
// 完成（streak>0，翡翠绿）/ 周末高分（test_rating 为 S 或 A，深绿）/
// 休息日（is_rest，蓝灰）/ 未学习（浅灰）。优先级：休息日 > 高分 > 完成。
// ============================================================
window.CheckIn = (function () {
  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let vy = 0, vm = 0; // 月历当前查看的年/月（month 0-based）

  // ---------- 连击计算：某天（含）往前数连续达标天数 ----------
  async function chainEndingAt(dateStr) {
    const rows = await DB.getStreakRows();
    const map = {};
    for (const r of rows) map[r.date] = r;
    const qualifies = (r) => !!r && (r.streak > 0 || r.is_rest);

    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const iso = (x) => {
      const mm = String(x.getMonth() + 1).padStart(2, '0');
      const dd = String(x.getDate()).padStart(2, '0');
      return `${x.getFullYear()}-${mm}-${dd}`;
    };
    let n = 0;
    while (qualifies(map[iso(dt)])) {
      n++;
      dt.setDate(dt.getDate() - 1);
    }
    return n;
  }

  // ---------- 自动打卡判定（由各学习流程收尾时调用，fire-and-forget） ----------
  async function maybeCompleteToday() {
    try {
      const today = DB.todayISO();
      const log = await DB.getDailyLog(today);
      if (log && log.is_rest) return;            // 休息日不打卡
      if (log && (log.streak || 0) > 0) return;  // 今天已打卡

      const isWk = [0, 6].includes(new Date().getDay());
      // 主任务：平日=新词完成；周末=考试完成
      const mainDone = isWk
        ? !!(log && log.test_score != null)
        : !!(log && (log.new_words_count || 0) > 0);
      if (!mainDone) return;

      // 复习清零：模式 B / 模式 A 都没有到期剩余
      const [dueB, dueA] = await Promise.all([DB.getReviewDueCount(), DB.getModeADueCount()]);
      if (dueB + dueA > 0) return;

      const chain = await chainEndingAt(DB.datePlusDays(-1));
      await DB.updateDailyLogFields(today, { streak: chain + 1 });
      console.log('[CheckIn] 今日打卡完成，streak =', chain + 1);
    } catch (e) {
      console.warn('[CheckIn] 打卡判定失败', e);
    }
  }

  // ---------- 今日宜休 ----------
  async function setRestToday(isRest) {
    const today = DB.todayISO();
    if (isRest) {
      // 休息日 streak 记为昨天为止的连击值（不加不减）；若今天已打卡则保留原值
      const log = await DB.getDailyLog(today);
      const chain = await chainEndingAt(DB.datePlusDays(-1));
      await DB.updateDailyLogFields(today, { is_rest: true, streak: Math.max(chain, (log && log.streak) || 0) });
    } else {
      // 取消休息：仅清除休息标记（若今天已完成任务，streak 保留）
      await DB.updateDailyLogFields(today, { is_rest: false });
    }
  }

  async function isRestToday() {
    try {
      const log = await DB.getDailyLog(DB.todayISO());
      return !!(log && log.is_rest);
    } catch (e) {
      return false;
    }
  }

  // ---------- 打卡页（月历） ----------
  async function enter() {
    const now = new Date();
    vy = now.getFullYear();
    vm = now.getMonth();
    await renderCalendar();
  }

  // 某天四态：rest / high / done / none / future
  function dayState(log) {
    if (!log) return 'none';
    if (log.is_rest) return 'rest';
    if (log.test_rating === 'S' || log.test_rating === 'A') return 'high';
    if ((log.streak || 0) > 0) return 'done';
    return 'none';
  }

  async function renderCalendar() {
    const body = $('checkin-body');
    if (!body) return;
    body.innerHTML = '<div class="placeholder">正在加载…</div>';
    try {
      const [logs, streak, totalDays] = await Promise.all([
        DB.getMonthLogs(vy, vm),
        DB.getStreak(),
        DB.getStudyDaysTotal(),
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
        if (log && (log.streak || 0) > 0) done++;
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
          <button class="btn btn-ghost" id="cal-prev">← 上月</button>
          <span class="cal-month num">${vy} 年 ${vm + 1} 月</span>
          <button class="btn btn-ghost" id="cal-next">下月 →</button>
        </div>
        <div class="cal-week">${['一', '二', '三', '四', '五', '六', '日'].map((d) => `<span>${d}</span>`).join('')}</div>
        <div class="cal-grid">${cells}</div>
        <div class="cal-legend">
          <span><i class="sw cal-done"></i>完成</span>
          <span><i class="sw cal-high"></i>周末高分</span>
          <span><i class="sw cal-rest"></i>休息日</span>
          <span><i class="sw cal-none"></i>未学习</span>
        </div>`;

      $('cal-prev').addEventListener('click', () => { vm--; if (vm < 0) { vm = 11; vy--; } renderCalendar(); });
      $('cal-next').addEventListener('click', () => { vm++; if (vm > 11) { vm = 0; vy++; } renderCalendar(); });
      body.querySelectorAll('.cal-cell[data-date]').forEach((el) => {
        if (!el.dataset.date) return;
        el.addEventListener('click', () => openDay(el.dataset.date, map[el.dataset.date]));
      });
    } catch (e) {
      console.error('[CheckIn] 月历加载失败', e);
      body.innerHTML = '<div class="placeholder">加载失败，请检查网络后重新进入</div>';
    }
  }

  // ---------- 当日详情弹窗 ----------
  function openDay(dateStr, log) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const title = `${m}月${d}日 ${WEEKDAYS[new Date(y, m - 1, d).getDay()]}`;
    const show = (v) => (v == null ? '—' : `<span class="num">${v}</span>`);
    const examText = log && log.test_score != null ? `<span class="num">${log.test_score}</span> 分 / ${esc(log.test_rating || '—')}` : '—';

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title">${title}${log && log.is_rest ? ' <span class="rest-tag">休息日</span>' : ''}</div>
        <div class="modal-row">新词 ${show(log && log.new_words_count)} 词</div>
        <div class="modal-row">复习 ${show(log && log.review_count)} 词</div>
        <div class="modal-row">测试 ${examText}</div>
        <div class="modal-row">用时 —</div>
        <div class="modal-row">Streak ${show(log && log.streak)} 天</div>
        <button class="btn btn-primary" id="modal-close">关闭</button>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#modal-close').addEventListener('click', () => overlay.remove());
  }

  return { enter, maybeCompleteToday, setRestToday, isRestToday };
})();
