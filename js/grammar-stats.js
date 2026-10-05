// ============================================================
// 我的数据 · 语法（#/grammar/stats）
// 镜像 js/stats.js 的卡片版式（.stat-grid / .done-item），只读语法侧事实源：
// 语法学习天数 / 已学语法数 / 已掌握数 / 薄弱语法数 / 语法库总数 / 语法考试历史最高。
// 红线：绝不查询 words / user_words 及 daily_logs 单词列，不做跨板块「总数据」汇总。
// ============================================================
window.GrammarStats = (function () {
  const $ = (id) => document.getElementById(id);

  async function enter() {
    const body = $('gh-stats-body');
    if (!body) return;
    body.innerHTML = '<div class="placeholder">正在统计…</div>';
    try {
      const [ugRows, totalGrammars, days, history] = await Promise.all([
        DB.getUserGrammarStatsRows(),   // grammar_id,status,wrong_count,weak_reason,created_at
        DB.getGrammarTotal(),           // 语法库总数
        DB.getGrammarStudyDaysTotal(),  // grammar_streak>0 天数
        DB.getGrammarExamHistory(),     // date,grammar_test_score,grammar_test_rating 倒序
      ]);

      const learned = ugRows.filter((r) => r.status !== 'unlearned').length;
      const mastered = ugRows.filter((r) => r.status === 'mastered').length;
      const weak = ugRows.filter((r) => (r.wrong_count || 0) > 0 || r.weak_reason).length;

      // 历史最高：取最高分，同分时保留已有评级
      let best = null;
      for (const h of history) {
        if (best == null || h.grammar_test_score > best.score) {
          best = { score: h.grammar_test_score, rating: h.grammar_test_rating };
        }
      }

      render({ days, learned, mastered, weak, totalGrammars, best });
    } catch (e) {
      console.error('[GrammarStats] 加载失败', e);
      body.innerHTML = '<div class="placeholder">加载失败，请检查网络后重新进入</div>';
    }
  }

  function render(d) {
    $('gh-stats-body').innerHTML = `
      <div class="stat-grid">
        <div class="done-item"><div class="done-num num">${d.days}</div><div class="done-label">语法学习天数</div></div>
        <div class="done-item"><div class="done-num num">${d.learned}</div><div class="done-label">已学语法</div></div>
        <div class="done-item"><div class="done-num num">${d.mastered}</div><div class="done-label">已掌握语法</div></div>
        <div class="done-item"><div class="done-num num">${d.weak}</div><div class="done-label">薄弱语法</div></div>
        <div class="done-item"><div class="done-num num">${d.totalGrammars}</div><div class="done-label">语法库总数</div></div>
        <div class="done-item"><div class="done-num num">${d.best ? d.best.score : '—'}</div><div class="done-label">语法考试最高${d.best && d.best.rating ? `（评级 ${d.best.rating}）` : ''}</div></div>
      </div>`;
  }

  return { enter };
})();
