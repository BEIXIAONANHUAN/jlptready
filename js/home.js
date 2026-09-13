// 首页：日期、Streak、任务卡片数据与交互、今日宜休
window.Home = (function () {
  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const isWeekend = () => [0, 6].includes(new Date().getDay());

  function $(id) { return document.getElementById(id); }

  // 写入 Streak 数字并触发一次跳动动画
  function setStreak(n) {
    const el = $('home-streak');
    el.textContent = n;
    el.classList.remove('pop');
    void el.offsetWidth; // 强制重排以重启动画
    el.classList.add('pop');
  }

  // 顶部日期，如「9月1日 周一」
  function renderDate() {
    const d = new Date();
    $('home-date').textContent = `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`;
  }

  // 周一至周五显示新词卡片、考试卡片置灰；周六日反之
  function renderWeekendLayout() {
    const cardNew = $('card-new');
    const cardExam = $('card-exam');
    const btnExam = $('btn-exam');

    if (isWeekend()) {
      cardNew.style.display = 'none';
      cardExam.classList.remove('is-closed');
      renderExamCard();
    } else {
      cardNew.style.display = '';
      cardExam.classList.add('is-closed');
      btnExam.disabled = true;
      btnExam.textContent = '未开放';
      $('exam-meta').textContent = '仅周六、周日开放';
    }
    $('card-review').style.display = '';
    $('card-exam').style.display = '';
  }

  // 「周末考试」卡片（仅周末显示真实状态）：待考 / 进行中 / 已完成。
  // 完成判定 daily_logs 优先（分数/评级都在这里，且跨版本最可靠）；
  // 云端断点快照兜底（兼容迁移前完成、分数行缺失等场景）。
  async function renderExamCard() {
    const meta = $('exam-meta');
    const btn = $('btn-exam');
    let log = null, s = null;
    try { log = await DB.getDailyLog(DB.todayISO()); } catch (e) { console.warn('[Home] 今日日志读取失败', e); }
    try {
      const row = await DB.getSessionProgress('exam', DB.todayISO());
      if (row && row.queue_snapshot) s = row.queue_snapshot;
    } catch (e) { console.warn('[Home] 考试断点读取失败', e); }

    // ① daily_logs 有分数 → 今日已完成（最权威）
    if (log && log.test_score != null) {
      meta.innerHTML = `今日已完成 <span class="dot">·</span> 得分 <span class="num ok">${log.test_score}</span> <span class="dot">·</span> 评级 <span class="num ok">${log.test_rating || '—'}</span>`;
      btn.textContent = '查看成绩';
      btn.disabled = false;
      return;
    }
    // ② 云端快照 done → 已完成（分数以快照为准）
    if (s && s.stage === 'done') {
      meta.innerHTML = `今日已完成 <span class="dot">·</span> 得分 <span class="num ok">${s.score != null ? s.score : '—'}</span> <span class="dot">·</span> 评级 <span class="num ok">${s.rating || '—'}</span>`;
      btn.textContent = '查看成绩';
      btn.disabled = false;
      return;
    }
    // ③ 做到一半 → 继续考试
    if (s && s.stage === 'quiz') {
      meta.innerHTML = `进行中 <span class="dot">·</span> 第 <span class="num">${(s.stats && s.stats.answered || 0) + 1}</span>/<span class="num">${s.totalQ || (s.items && s.items.length) || 120}</span> 题`;
      btn.textContent = '继续考试';
      btn.disabled = false;
      return;
    }
    // ④ 已组卷待开始
    if (s) {
      meta.innerHTML = `<span class="num">${s.totalQ || (s.items && s.items.length) || 120}</span> 题 <span class="dot">·</span> 已组卷，待开始`;
      btn.textContent = '开始考试';
      btn.disabled = false;
      return;
    }
    // ⑤ 默认
    meta.innerHTML = `<span class="num">120</span> 题 <span class="dot">·</span> 约 <span class="num">40</span> 分钟`;
    btn.textContent = '进入考试';
    btn.disabled = false;
  }

  // 「今日新词」卡片：完成状态以 Supabase 为准（跨设备一致）——
  // 今天 daily_logs.new_words_count > 0 即视为已完成，禁用按钮；
  // 未完成时才看云端断点显示 待开始 / 进行中。
  async function renderNewCard() {
    const meta = $('new-meta');
    const btn = $('btn-new');

    try {
      const log = await DB.getDailyLog(DB.todayISO());
      if (log && log.new_words_count > 0) {
        meta.innerHTML = `今日 <span class="num">${log.new_words_count}</span> 词已完成`;
        btn.textContent = '已完成';
        btn.disabled = true;
        return;
      }
    } catch (e) {
      // 网络失败时回落到本地会话状态，避免卡片整个挂掉
      console.warn('[Home] 新词状态查询失败，按本地会话显示', e);
    }

    let s = null;
    try {
      const row = await DB.getSessionProgress('new', DB.todayISO());
      if (row && row.queue_snapshot) s = row.queue_snapshot;
    } catch (e) { console.warn('[Home] 新词断点读取失败', e); }

    btn.disabled = false;
    if (s && s.stage === 'done') {
      if (s.date === DB.todayISO()) {
        // 本地显示已完成但数据库没有记录：成绩未保存成功，允许进入补保存
        const acc = s.stats && s.stats.answered ? Math.round((s.stats.correct / s.stats.answered) * 100) : 100;
        meta.innerHTML = `今日 <span class="num">${s.words.length}</span> 词已完成 <span class="dot">·</span>正确率 <span class="num ok">${acc}%</span> <span class="dot">·</span>成绩待同步`;
        btn.textContent = '同步成绩';
        return;
      }
      s = null; // 更早某天已完成的会话，不影响今天
    }
    if (s && s.stage !== 'empty') {
      const stageText = {
        preview: '尚未开始测试',
        quiz: `进行中 <span class="dot">·</span> 第 <span class="num">${s.groupIndex + 1}</span>/<span class="num">${s.groups.length}</span> 组`,
        summary: `第 <span class="num">${s.groupIndex + 1}</span>/<span class="num">${s.groups.length}</span> 组已完成`,
      }[s.stage] || '进行中';
      meta.innerHTML = `今日 <span class="num">${s.words.length}</span> 词 <span class="dot">·</span>${stageText}`;
      btn.textContent = '继续学习';
    } else {
      meta.innerHTML = `今日 <span class="num">50</span> 词 <span class="dot">·</span>约 <span class="num">${Math.round(50 * CONFIG.SECONDS_PER_NEW_WORD / 60)}</span> 分钟`;
      btn.textContent = '开始学习';
    }
  }

  // 「今日复习」卡片判定源（与复习页/结算页统一）：
  // ① daily_logs.review_count>0 → 已完成（review_count 只在结算时写入，最权威，
  //    即使有历史竞态遗留的僵尸断点行也不影响已完成判定）
  // ② 云端 in_progress 断点 → 进行中/继续复习（快照自相矛盾的僵尸行视为无效）
  // ③ 到期数 → 待复习；④ 都没有 → 暂无
  async function renderReviewCard() {
    const meta = $('review-meta');
    const btn = $('btn-review');

    // ① 已完成
    let log = null;
    try { log = await DB.getDailyLog(DB.todayISO()); } catch (e) { console.warn('[Home] 今日日志读取失败', e); }
    if (log && log.review_count > 0) {
      let extra = '';
      if (log.review_acc != null) {
        extra = ` <span class="dot">·</span>正确率 <span class="num ok">${log.review_acc}%</span>`;
        try {
          const yLog = await DB.getDailyLog(DB.datePlusDays(-1));
          if (yLog && yLog.review_acc != null) {
            const diff = log.review_acc - yLog.review_acc;
            extra += `（比昨日 <span class="num ${diff >= 0 ? 'cmp-up' : 'cmp-down'}">${diff >= 0 ? '+' : ''}${diff}%</span>）`;
          }
        } catch (e) { /* 昨日对比失败可忽略 */ }
      }
      meta.innerHTML = `今日已复习 <span class="num">${log.review_count}</span> 词${extra}`;
      btn.textContent = '已完成';
      btn.disabled = true;
      return;
    }

    // ② 进行中断点：到期词可能已随判定清零，但做题/卡片还没走完、结果尚未
    //    汇总（review_count 还没写入），不能因 due=0 挡住续作入口；
    //    status=in_progress 但快照 finished=true 的僵尸行（历史写入竞态遗留）视为无效
    try {
      const row = await DB.getSessionProgress('review', DB.todayISO());
      const snap = row && row.queue_snapshot;
      const rs = row && row.status === 'in_progress' && snap && !snap.finished ? snap : null;
      if (rs && rs.stats && rs.items) {
        meta.innerHTML = `进行中 <span class="dot">·</span>已判定 <span class="num">${rs.stats.wordsDone}</span>/<span class="num">${rs.items.length}</span> 词`;
        btn.disabled = false;
        btn.textContent = '继续复习';
        return;
      }
    } catch (e) { console.warn('[Home] 复习断点读取失败', e); }

    try {
      const [dueB, dueA] = await Promise.all([DB.getReviewDueCount(), DB.getModeADueCount()]);
      const due = dueB + dueA;
      if (due > 0) {
        const secs = dueB * CONFIG.SECONDS_PER_REVIEW + dueA * (CONFIG.SECONDS_PER_CARD || 10);
        meta.innerHTML = `待复习 <span class="num">${due}</span> 词 <span class="dot">·</span>约 <span class="num">${Math.max(1, Math.round(secs / 60))}</span> 分钟`;
        btn.disabled = false;
        btn.textContent = '开始复习';
        return;
      }
      meta.innerHTML = '今日暂无待复习词';
      btn.textContent = '无待复习';
      btn.disabled = true;
    } catch (e) {
      console.warn('[Home] 复习卡片加载失败', e);
      meta.innerHTML = '加载失败，请检查网络';
    }
  }

  // ---------- 分享今日 ----------
  // 显示口径与自动打卡一致：当天 streak>0（全部任务完成已打卡）且非休息日。
  // 次日自然重置（新的一天 streak 尚未写入，按钮自动隐藏）。
  async function renderShareButton() {
    const wrap = $('share-today-wrapper');
    if (!wrap) return;
    try {
      const log = await DB.getDailyLog(DB.todayISO());
      const done = !!(log && (log.streak || 0) > 0 && !log.is_rest);
      wrap.style.display = done ? '' : 'none';
    } catch (e) {
      wrap.style.display = 'none';
    }
  }

  // ---------- 今日宜休 / 休息模式 ----------
  async function renderRestState() {
    const resting = await CheckIn.isRestToday();
    const banner = $('rest-banner');
    if (resting) {
      ['card-new', 'card-review', 'card-exam'].forEach((id) => { $(id).style.display = 'none'; });
      banner.style.display = '';
      $('btn-rest').style.display = 'none';
    } else {
      banner.style.display = 'none';
      $('btn-rest').style.display = '';
      renderWeekendLayout(); // 恢复卡片显隐规则
    }
  }

  // 宜休确认弹窗
  function openRestConfirm() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title">确定今日休息？</div>
        <div class="modal-text">Streak 不会断，但今日不打卡。</div>
        <div class="modal-btns">
          <button class="btn btn-secondary" id="modal-no">再想想</button>
          <button class="btn btn-primary" id="modal-yes">确定休息</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#modal-no').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#modal-yes').addEventListener('click', async () => {
      overlay.remove();
      try {
        await CheckIn.setRestToday(true);
        // 清除三个模块「进行中」的断点（内存 + 云端）；已完成的存档保留
        if (window.NewWords) NewWords.discard();
        if (window.Review) Review.discard();
        if (window.Exam) Exam.discard();
        renderRestState();
      } catch (e) {
        console.error('[Home] 宜休设置失败', e);
        alert('设置失败，请检查网络后重试');
      }
    });
  }

  async function cancelRest() {
    try {
      await CheckIn.setRestToday(false);
      renderRestState();
    } catch (e) {
      console.error('[Home] 取消休息失败', e);
      alert('操作失败，请检查网络后重试');
    }
  }

  // 从数据库加载：Streak、复习卡片、休息状态
  async function loadData() {
    try {
      setStreak(await DB.getStreak());
    } catch (e) {
      console.warn('[Home] streak 加载失败', e);
    }
    renderReviewCard();
    renderRestState();
    renderShareButton();
  }

  // 连通性测试：读取 words 表总数，输出到控制台并显示在页脚
  async function testConnection() {
    try {
      const total = await DB.getWordTotal();
      console.log(`[Supabase] 连接成功，words 表共 ${total} 条`);
      $('db-status').textContent = `词库已连接 · 共 ${total} 词`;
    } catch (e) {
      console.error('[Supabase] 连接失败', e);
      $('db-status').textContent = '词库连接失败，请检查网络';
    }
  }

  function bindEvents() {
    $('btn-new').addEventListener('click', () => { location.hash = '#/new'; });
    $('btn-review').addEventListener('click', () => { location.hash = '#/review'; });
    $('btn-exam').addEventListener('click', () => { if (isWeekend()) location.hash = '#/exam'; });
    $('btn-rest').addEventListener('click', openRestConfirm);
    $('btn-cancel-rest').addEventListener('click', cancelRest);
    $('btn-share').addEventListener('click', () => { if (window.Share) Share.open(); });
  }

  function init() {
    renderDate();
    renderWeekendLayout();
    renderNewCard();
    bindEvents();
    testConnection();
    loadData();
  }

  // 路由回到首页时刷新（卡片状态可能变了）
  function onShow() {
    renderDate();
    renderWeekendLayout();
    renderNewCard();
    renderReviewCard();
    renderRestState();
    renderShareButton();
    DB.getStreak().then((s) => setStreak(s)).catch(() => {});
  }

  return { init, onShow };
})();
