// ============================================================
// 语法板块首页（#/grammar）：对仗 js/home.js，门户设计 §3 的 8 项
// 事实源：daily_logs 的语法列（new_grammar_count / grammar_test_score / grammar_streak）
//        + user_grammar 到期查询 + user_session_progress('grammar_new'/'grammar_exam')。
// 休息日 is_rest 全局共用（两板块同时休息），复用 CheckIn 的读写（不修改单词侧代码）。
// ============================================================
window.GrammarHome = (function () {
  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const isWeekend = () => [0, 6].includes(new Date().getDay());

  function $(id) { return document.getElementById(id); }

  // 写入语法 Streak 数字并触发一次跳动动画
  function setStreak(n) {
    const el = $('gh-streak');
    el.textContent = n;
    el.classList.remove('pop');
    void el.offsetWidth; // 强制重排以重启动画
    el.classList.add('pop');
  }

  function renderDate() {
    const d = new Date();
    $('gh-date').textContent = `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`;
  }

  // 周一至周五显示新语法卡、考试卡置灰；周六日反之（与单词首页同款规则）
  function renderWeekendLayout() {
    const cardNew = $('gh-card-new');
    const cardExam = $('gh-card-exam');
    const btnExam = $('gh-btn-exam');

    if (isWeekend()) {
      cardNew.style.display = 'none';
      cardExam.classList.remove('is-closed');
      renderExamCard();
    } else {
      cardNew.style.display = '';
      cardExam.classList.add('is-closed');
      btnExam.disabled = true;
      btnExam.textContent = '未开放';
      $('gh-exam-meta').textContent = '仅周六、周日开放';
    }
    $('gh-card-review').style.display = '';
    cardExam.style.display = '';
  }

  // 「周末考试（语法）」卡片：完成判定 daily_logs.grammar_test_score 优先，
  // 云端断点快照兜底（与 home.js renderExamCard 同构）
  async function renderExamCard() {
    const meta = $('gh-exam-meta');
    const btn = $('gh-btn-exam');
    let log = null, s = null;
    try { log = await DB.getDailyLog(DB.todayISO()); } catch (e) { console.warn('[GrammarHome] 今日日志读取失败', e); }
    try {
      const row = await DB.getSessionProgress('grammar_exam', DB.todayISO());
      if (row && row.queue_snapshot) s = row.queue_snapshot;
    } catch (e) { console.warn('[GrammarHome] 考试断点读取失败', e); }

    if (log && log.grammar_test_score != null) {
      meta.innerHTML = `今日已完成 <span class="dot">·</span> 得分 <span class="num ok">${log.grammar_test_score}</span> <span class="dot">·</span> 评级 <span class="num ok">${log.grammar_test_rating || '—'}</span>`;
      btn.textContent = '查看成绩';
      btn.disabled = false;
      return;
    }
    if (s && s.stage === 'done') {
      meta.innerHTML = `今日已完成 <span class="dot">·</span> 得分 <span class="num ok">${s.score != null ? s.score : '—'}</span> <span class="dot">·</span> 评级 <span class="num ok">${s.rating || '—'}</span>`;
      btn.textContent = '查看成绩';
      btn.disabled = false;
      return;
    }
    if (s && s.stage === 'quiz') {
      meta.innerHTML = `进行中 <span class="dot">·</span> 第 <span class="num">${(s.stats && s.stats.answered || 0) + 1}</span>/<span class="num">${s.totalQ || (s.items && s.items.length) || 40}</span> 题`;
      btn.textContent = '继续考试';
      btn.disabled = false;
      return;
    }
    if (s) {
      meta.innerHTML = `<span class="num">${s.totalQ || (s.items && s.items.length) || 40}</span> 题 <span class="dot">·</span> 已组卷，待开始`;
      btn.textContent = '开始考试';
      btn.disabled = false;
      return;
    }
    meta.innerHTML = `<span class="num">40</span> 题 <span class="dot">·</span> 约 <span class="num">${Math.round(40 * CONFIG.SECONDS_PER_GRAMMAR_REVIEW / 60)}</span> 分钟`;
    btn.textContent = '进入考试';
    btn.disabled = false;
  }

  // 「今日语法」卡片三态（与 home.js renderNewCard 同构，daily_logs.new_grammar_count 同源）：
  // 已完成（日志有记录，禁用）/ 进行中（断点快照）/ 默认（6 个新语法 · 约 10 分钟）；
  // 语法库全部学完后显示「全部学完」置灰。
  async function renderNewCard() {
    const meta = $('gh-new-meta');
    const btn = $('gh-btn-new');

    try {
      const log = await DB.getDailyLog(DB.todayISO());
      if (log && log.new_grammar_count > 0) {
        meta.innerHTML = `今日 <span class="num">${log.new_grammar_count}</span> 个语法已完成`;
        btn.textContent = '已完成';
        btn.disabled = true;
        return;
      }
    } catch (e) {
      console.warn('[GrammarHome] 新语法状态查询失败，按本地会话显示', e);
    }

    let s = null;
    try {
      const row = await DB.getSessionProgress('grammar_new', DB.todayISO());
      if (row && row.queue_snapshot) s = row.queue_snapshot;
    } catch (e) { console.warn('[GrammarHome] 新语法断点读取失败', e); }

    btn.disabled = false;
    if (s && s.stage === 'done') {
      if (s.date === DB.todayISO()) {
        // 本地显示已完成但数据库没有记录：成绩未保存成功，允许进入补保存
        meta.innerHTML = `今日 <span class="num">${(s.items && s.items.length) || GrammarCore.NEW_PER_DAY}</span> 个语法已完成 <span class="dot">·</span>成绩待同步`;
        btn.textContent = '同步成绩';
        return;
      }
      s = null; // 更早某天已完成的会话，不影响今天
    }
    if (s && s.stage !== 'empty') {
      const total = (s.items && s.items.length) || (s.words && s.words.length) || GrammarCore.NEW_PER_DAY;
      let done = s.passedCount;
      if (done == null && s.groups && s.groups.length) {
        done = Math.min(total, Math.round((s.groupIndex || 0) * total / s.groups.length));
      }
      const stageText = {
        preview: '尚未开始测试',
        quiz: `进行中 <span class="dot">·</span> 已完成 <span class="num">${done || 0}</span>/<span class="num">${total}</span>`,
        summary: `已完成 <span class="num">${done || 0}</span>/<span class="num">${total}</span>`,
      }[s.stage] || '进行中';
      meta.innerHTML = `今日 <span class="num">${total}</span> 个新语法 <span class="dot">·</span>${stageText}`;
      btn.textContent = '继续学习';
      return;
    }

    // 默认态（含「全部学完」判定：每个语法都有进度行且无 unlearned）
    try {
      const [total, newLeft, rowCount] = await Promise.all([
        DB.getGrammarTotal(), DB.getGrammarNewCount(), DB.getUserGrammarRowCount(),
      ]);
      if (total > 0 && rowCount >= total && newLeft === 0) {
        meta.textContent = `${total} 条语法全部学完`;
        btn.textContent = '已学完';
        btn.disabled = true;
        return;
      }
    } catch (e) { /* 判定失败落默认显示 */ }

    meta.innerHTML = `今日 <span class="num">${GrammarCore.NEW_PER_DAY}</span> 个新语法 <span class="dot">·</span>约 <span class="num">${Math.round(GrammarCore.NEW_PER_DAY * CONFIG.SECONDS_PER_NEW_GRAMMAR / 60)}</span> 分钟`;
    btn.textContent = '开始学习';
  }

  // 「今日复习（语法）」卡片：user_grammar 模式 B + 模式 A 到期数
  async function renderReviewCard() {
    const meta = $('gh-review-meta');
    const btn = $('gh-btn-review');
    try {
      const [dueB, dueA] = await Promise.all([DB.getGrammarReviewDueCount(), DB.getGrammarModeADueCount()]);
      const due = dueB + dueA;
      if (due > 0) {
        const secs = dueB * CONFIG.SECONDS_PER_GRAMMAR_REVIEW + dueA * (CONFIG.SECONDS_PER_CARD || 10);
        meta.innerHTML = `待复习 <span class="num">${due}</span> 个 <span class="dot">·</span>约 <span class="num">${Math.max(1, Math.round(secs / 60))}</span> 分钟`;
        btn.disabled = false;
        btn.textContent = '开始复习';
        return;
      }
      meta.innerHTML = '今日暂无待复习语法';
      btn.textContent = '无待复习';
      btn.disabled = true;
    } catch (e) {
      console.warn('[GrammarHome] 复习卡片加载失败', e);
      meta.innerHTML = '加载失败，请检查网络';
    }
  }

  // ---------- 今日宜休 / 休息模式（全局 is_rest，与单词首页共用横幅样式） ----------
  async function renderRestState() {
    const resting = await CheckIn.isRestToday();
    const banner = $('gh-rest-banner');
    if (resting) {
      ['gh-card-new', 'gh-card-review', 'gh-card-exam'].forEach((id) => { $(id).style.display = 'none'; });
      banner.style.display = '';
      $('gh-btn-rest').style.display = 'none';
    } else {
      banner.style.display = 'none';
      $('gh-btn-rest').style.display = '';
      renderWeekendLayout();
    }
  }

  // 宜休确认弹窗（文案与单词首页一致；休息日两板块同时休息）
  function openRestConfirm() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title">确定今日休息？</div>
        <div class="modal-text">Streak 不会断，但今日不打卡。</div>
        <div class="modal-btns">
          <button class="btn btn-secondary" id="gh-modal-no">再想想</button>
          <button class="btn btn-primary" id="gh-modal-yes">确定休息</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#gh-modal-no').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#gh-modal-yes').addEventListener('click', async () => {
      overlay.remove();
      try {
        await CheckIn.setRestToday(true);
        // 清除语法侧「进行中」断点（内存 + 云端）；已完成的存档保留
        if (window.GrammarNew) GrammarNew.discard();
        if (window.GrammarReview) GrammarReview.discard();
        if (window.GrammarExam) GrammarExam.discard();
        renderRestState();
      } catch (e) {
        console.error('[GrammarHome] 宜休设置失败', e);
        alert('设置失败，请检查网络后重试');
      }
    });
  }

  async function cancelRest() {
    try {
      await CheckIn.setRestToday(false);
      renderRestState();
    } catch (e) {
      console.error('[GrammarHome] 取消休息失败', e);
      alert('操作失败，请检查网络后重试');
    }
  }

  async function loadData() {
    try {
      const s = await DB.getGrammarStreak();
      if (!ensureCheckedInDone) setStreak(s);
    } catch (e) {
      console.warn('[GrammarHome] 语法 streak 加载失败', e);
    }
    renderReviewCard();
    renderRestState();
  }

  // 后台补判语法打卡：不阻塞渲染；成功写入后只增量刷新顶栏连击
  let ensureCheckedInDone = false;
  async function backgroundEnsureCheckIn() {
    try {
      const result = await GrammarCore.ensureTodayCheckedIn();
      if (result && result.written && result.streak != null) {
        ensureCheckedInDone = true;
        setStreak(result.streak);
      }
    } catch (e) {
      console.error('[GrammarHome] 语法打卡补判失败', e);
    }
  }

  // 连通性测试：读 grammar 表总数，输出到控制台并显示在页脚
  async function testConnection() {
    try {
      const total = await DB.getGrammarTotal();
      console.log(`[Supabase] grammar 表共 ${total} 条`);
      $('gh-db-status').textContent = `语法库已连接 · 共 ${total} 条语法`;
    } catch (e) {
      console.error('[Supabase] 语法库连接失败', e);
      $('gh-db-status').textContent = '语法库连接失败，请检查网络';
    }
  }

  function bindEvents() {
    $('gh-btn-new').addEventListener('click', () => { location.hash = '#/grammar/new'; });
    $('gh-btn-review').addEventListener('click', () => { location.hash = '#/grammar/review'; });
    $('gh-btn-exam').addEventListener('click', () => { if (isWeekend()) location.hash = '#/grammar/exam'; });
    $('gh-btn-rest').addEventListener('click', openRestConfirm);
    $('gh-btn-cancel-rest').addEventListener('click', cancelRest);
  }

  function init() {
    renderDate();
    renderWeekendLayout();
    renderNewCard();
    bindEvents();
    testConnection();
    loadData();
    // 补判放后台：先完整渲染首页，绝不因补判超时/失败阻断渲染
    backgroundEnsureCheckIn();
  }

  // 路由回到语法首页时刷新（卡片状态可能变了）
  function onShow() {
    renderDate();
    renderWeekendLayout();
    renderNewCard();
    renderReviewCard();
    renderRestState();
    DB.getGrammarStreak().then((s) => setStreak(s)).catch(() => {});
  }

  return { init, onShow };
})();
