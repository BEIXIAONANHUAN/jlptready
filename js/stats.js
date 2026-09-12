// ============================================================
// 我的数据（#/stats）：学习统计 + 总进度 + 等级分布 + 成就徽章墙
// ============================================================
window.Stats = (function () {
  const LEVELS = ['N5', 'N4', 'N3', 'N2'];
  let datesFixed = false;   // 本次页面生命周期内徽章日期已修复（修复按钮随之隐藏）

  const $ = (id) => document.getElementById(id);

  async function enter() {
    const body = $('stats-body');
    if (!body) return;
    body.innerHTML = '<div class="placeholder">正在统计…</div>';
    try {
      const [uwRows, wordLevels, logs, streak] = await Promise.all([
        DB.getUserWordStatsRows(),   // 全部学习记录（word_id/status/wrong_count/weak_reason）
        DB.getAllWordLevels(),       // 全词库 id+level
        DB.getAllLogs(),
        DB.getStreak(),
      ]);

      // 汇总
      const totalWords = wordLevels.length;
      const mastered = uwRows.filter((r) => r.status === 'mastered').length;
      const learning = uwRows.filter((r) => r.status === 'learning').length;
      const weak = uwRows.filter((r) => (r.wrong_count || 0) > 0 || r.weak_reason).length;
      const days = logs.filter((l) => (l.new_words_count || 0) > 0 || (l.review_count || 0) > 0 || l.test_score != null).length;
      const totalWrong = uwRows.reduce((n, r) => n + (r.wrong_count || 0), 0);

      // 等级分布：各级 已掌握/总词数
      const levelByWordId = {};
      const levelStats = {};
      for (const lv of LEVELS) levelStats[lv] = { total: 0, mastered: 0 };
      for (const w of wordLevels) {
        if (levelStats[w.level]) levelStats[w.level].total++;
        levelByWordId[w.id] = w.level;
      }
      for (const r of uwRows) {
        if (r.status === 'mastered' && levelStats[levelByWordId[r.word_id]]) {
          levelStats[levelByWordId[r.word_id]].mastered++;
        }
      }

      // 徽章评估（内部会弹新解锁的祝贺提示；已迁云端，跨设备一致）
      const unlocks = await Achievements.evaluate({ logs, streak, masteredTotal: mastered, levelStats });

      render({ totalWords, mastered, learning, weak, days, totalWrong, levelStats, unlocks });
    } catch (e) {
      console.error('[Stats] 加载失败', e);
      body.innerHTML = '<div class="placeholder">加载失败，请检查网络后重新进入</div>';
    }
  }

  function pct(a, b) { return b ? Math.round((a / b) * 100) : 0; }

  function render(d) {
    const badges = Achievements.DEFS.map((def) => {
      const date = d.unlocks[def.id];
      return `
        <div class="badge ${date ? 'on' : ''}">
          <div class="badge-name">${def.name}</div>
          <div class="badge-desc">${def.desc}</div>
          ${date ? `<div class="badge-date num">${date}</div>` : ''}
        </div>`;
    }).join('');

    const levelRows = LEVELS.map((lv) => {
      const s = d.levelStats[lv];
      const p = pct(s.mastered, s.total);
      return `
        <div class="lv-row">
          <span class="lv-name num">${lv}</span>
          <div class="pbar"><div class="pbar-fill" style="width:${p}%"></div></div>
          <span class="lv-text"><span class="num">${s.mastered}</span>/<span class="num">${s.total}</span> · <span class="num">${p}%</span></span>
        </div>`;
    }).join('');

    const totalPct = pct(d.mastered, d.totalWords);

    $('stats-body').innerHTML = `
      <div class="stat-grid">
        <div class="done-item"><div class="done-num num">${d.totalWords}</div><div class="done-label">总词库</div></div>
        <div class="done-item"><div class="done-num num">${d.mastered}</div><div class="done-label">已掌握</div></div>
        <div class="done-item"><div class="done-num num">${d.learning}</div><div class="done-label">学习中</div></div>
        <div class="done-item"><div class="done-num num">${d.weak}</div><div class="done-label">薄弱词</div></div>
        <div class="done-item"><div class="done-num num">${d.days}</div><div class="done-label">累计学习天数</div></div>
        <div class="done-item"><div class="done-num num">${d.totalWrong}</div><div class="done-label">累计做错次数</div></div>
      </div>

      <div class="stat-block">
        <div class="stat-title">总进度</div>
        <div class="pbar pbar-big"><div class="pbar-fill" style="width:${totalPct}%"></div></div>
        <div class="pbar-text">已掌握 <span class="num">${d.mastered}</span> / <span class="num">${d.totalWords}</span> 词 <span class="dot">·</span> <span class="num ok">${totalPct}%</span></div>
      </div>

      <div class="stat-block">
        <div class="stat-title">等级分布</div>
        ${levelRows}
      </div>

      <div class="stat-block">
        <div class="stat-title">成就徽章 <span class="stat-title-sub num">${Object.keys(d.unlocks).length}/${Achievements.DEFS.length}</span></div>
        <div class="badge-wall">${badges}</div>
      </div>

      <div class="stat-block">
        <div class="stat-title">数据工具</div>
        ${datesFixed
          ? '<div class="stat-title-sub">徽章日期已修复</div>'
          : '<button class="btn btn-secondary" id="btn-fix-dates">修复徽章日期</button>'}
        <div style="margin-top:8px;">
          <button class="btn btn-secondary" id="btn-migrate">同步本机数据到云端</button>
        </div>
        <div style="margin-top:8px;">
          <button class="btn btn-secondary" id="btn-migrate-force">强制覆盖云端（本机为准）</button>
        </div>
        <div id="migrate-tip" style="font-size:0.8rem;color:var(--color-text-sub);margin-top:8px;"></div>
      </div>`;

    // 一次性修复：徽章日期被覆盖成错误值时，按 daily_logs 反推真实解锁日期
    const fixBtn = $('btn-fix-dates');
    if (fixBtn) fixBtn.addEventListener('click', async () => {
      const tip = $('migrate-tip');
      fixBtn.disabled = true;
      tip.textContent = '正在修复…';
      try {
        const fixed = await Achievements.restoreDates();
        const names = Object.entries(fixed)
          .map(([id, d]) => `${(Achievements.DEFS.find((x) => x.id === id) || {}).name || id} ${d}`)
          .join(' · ');
        tip.textContent = names ? `已修复：${names}` : '无可推断的徽章日期';
        datesFixed = true;
        await Achievements.reload();
        enter(); // 刷新徽章墙（按钮随之消失）
      } catch (e) {
        console.error('[Stats] 修复失败', e);
        tip.textContent = '修复失败，请检查网络后重试';
        fixBtn.disabled = false;
      }
    });

    // 合并同步：徽章取并集（日期早者胜，只补云端缺的），断点仅补缺
    $('btn-migrate').addEventListener('click', async () => {
      const btn = $('btn-migrate');
      const tip = $('migrate-tip');
      btn.disabled = true;
      tip.textContent = '正在同步…';
      try {
        const report = await DB.migrateLocalData(false);
        tip.textContent = `同步完成：补徽章 ${report.badges} 枚，断点 ${report.sessions} 条`;
        await Achievements.reload();
        enter();
      } catch (e) {
        console.error('[Stats] 同步失败', e);
        tip.textContent = '同步失败，请检查网络后重试';
      } finally {
        btn.disabled = false;
      }
    });

    // 强制覆盖：本机为准，云端徽章清空重插、断点覆盖（需二次确认）
    $('btn-migrate-force').addEventListener('click', async () => {
      const btn = $('btn-migrate-force');
      const tip = $('migrate-tip');
      if (!confirm('将以本机数据覆盖云端：徽章日期和断点都会被本机内容替换，云端现有数据丢失。确定？')) return;
      btn.disabled = true;
      tip.textContent = '正在覆盖…';
      try {
        const report = await DB.migrateLocalData(true);
        tip.textContent = `覆盖完成：徽章 ${report.badges} 枚，断点 ${report.sessions} 条`;
        await Achievements.reload();
        enter();
      } catch (e) {
        console.error('[Stats] 覆盖失败', e);
        tip.textContent = '覆盖失败，请检查网络后重试';
      } finally {
        btn.disabled = false;
      }
    });
  }

  return { enter };
})();
