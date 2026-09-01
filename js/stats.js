// ============================================================
// 我的数据（#/stats）：学习统计 + 总进度 + 等级分布 + 成就徽章墙
// ============================================================
window.Stats = (function () {
  const LEVELS = ['N5', 'N4', 'N3', 'N2'];

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

      // 徽章评估（内部会弹新解锁的祝贺提示）
      const unlocks = Achievements.evaluate({ logs, streak, masteredTotal: mastered, levelStats });

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
      </div>`;
  }

  return { enter };
})();
