// ============================================================
// 分享今日：当日任务全部完成后，首页出现「分享今日」按钮，
// 点击弹出 Canvas 实时生成的打卡报告卡片（1080×1080 PNG），可保存到相册。
//
// 图片完全在前端内存生成（Data URL），不上传、不写库、不占 Supabase 存储，
// 每次点击重新生成，页面刷新即消失。
//
// 卡片数据口径：
// - 平日四行：今日新词 / 今日复习 / 正确率 / 累计学习天数；
// - 周末没有新词，第一行固定换成「周末测试」（琥珀色标签），数值为当天
//   考试评级 S/A/B/C（daily_logs.test_rating），未参加显示 —。
// - 词库进度：mastered 词数 / 词库总数。
// ============================================================
window.Share = (function () {
  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const FONT = '-apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- 数据收集 ----------
  async function collectData() {
    const now = new Date();
    const isWeekend = [0, 6].includes(now.getDay());
    const [log, streak, totalDays, mastered, total] = await Promise.all([
      DB.getDailyLog(DB.todayISO()),
      DB.getStreak(),
      DB.getStudyDaysTotal(),
      DB.getMasteredCount(),
      DB.getWordTotal(),
    ]);

    const rows = [];
    if (isWeekend) {
      // 周末不出新词：第一行固定为「周末测试」，显示当天考试评级（未参加显示 —）
      rows.push({ label: '周末测试', value: (log && log.test_rating) || '—', labelColor: '#F59E0B' });
    } else {
      rows.push({ label: '今日新词', value: `${(log && log.new_words_count) || 0} 词` });
    }
    rows.push({ label: '今日复习', value: `${(log && log.review_count) || 0} 词` });
    // 当天综合正确率：全部模块作答的 quiz_correct/quiz_total 加权，无数据则 —
    const accText = log && (log.quiz_total || 0) > 0
      ? `${Math.round((100 * log.quiz_correct) / log.quiz_total)}%`
      : '—';
    rows.push({ label: '正确率', value: accText });
    rows.push({ label: '累计学习', value: `${totalDays || 0} 天` });

    return {
      date: `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`,
      dateShort: DB.todayISO(),
      weekday: WEEKDAYS[now.getDay()],
      streak,
      rows,
      learnedCount: mastered || 0,
      totalCount: total || 0,
    };
  }

  // ---------- Canvas 绘制（1080×1080） ----------
  // 圆角矩形路径（不依赖原生 roundRect，兼容老版 Safari）
  function roundedRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function hline(ctx, y) {
    ctx.strokeStyle = '#E5E7EB';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(120, y);
    ctx.lineTo(960, y);
    ctx.stroke();
  }

  function generateShareCard(d) {
    const canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 1080;
    const ctx = canvas.getContext('2d');

    // 白底
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, 1080, 1080);
    ctx.textBaseline = 'alphabetic';

    // 顶部日期
    ctx.fillStyle = '#6B7280';
    ctx.font = `400 36px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(`${d.date} ${d.weekday}`, 540, 170);

    // 连续打卡（🔥 由系统 emoji 字体渲染）
    ctx.fillStyle = '#1A1A1A';
    ctx.font = `700 64px ${FONT}`;
    ctx.fillText(`🔥 连续打卡 ${d.streak} 天`, 540, 292);

    hline(ctx, 360);

    // 数据行：左标签右数值，行高 90；标签默认灰，可用 row.labelColor 覆盖（如周末测试的琥珀色）
    let y = 460;
    for (const row of d.rows) {
      ctx.font = `400 48px ${FONT}`;
      ctx.fillStyle = row.labelColor || '#6B7280';
      ctx.textAlign = 'left';
      ctx.fillText(row.label, 120, y);
      ctx.font = `700 48px ${FONT}`;
      ctx.fillStyle = '#1A1A1A';
      ctx.textAlign = 'right';
      ctx.fillText(String(row.value), 960, y);
      y += 90;
    }

    // 词库进度
    ctx.textAlign = 'center';
    ctx.font = `400 36px ${FONT}`;
    ctx.fillStyle = '#6B7280';
    ctx.fillText('词库进度', 540, y + 10);

    const barY = y + 45;
    const pct = d.totalCount ? Math.min(1, d.learnedCount / d.totalCount) : 0;
    ctx.fillStyle = '#F3F4F6';
    roundedRect(ctx, 120, barY, 840, 24, 16);
    ctx.fill();
    if (pct > 0) {
      ctx.fillStyle = '#10B981';
      roundedRect(ctx, 120, barY, Math.max(24, 840 * pct), 24, 16);
      ctx.fill();
    }

    ctx.font = `400 32px ${FONT}`;
    ctx.fillStyle = '#6B7280';
    ctx.fillText(
      `${d.learnedCount.toLocaleString('en-US')} / ${d.totalCount.toLocaleString('en-US')} 词 · ${Math.round(pct * 100)}%`,
      540, barY + 85
    );

    hline(ctx, barY + 130);

    // 底部落款
    ctx.font = `400 32px ${FONT}`;
    ctx.fillStyle = '#9CA3AF';
    ctx.fillText('日语备考 · JLPT N5-N2', 540, barY + 185);

    return canvas.toDataURL('image/png');
  }

  // ---------- 弹窗 ----------
  function showShareModal(dataUrl, dateShort) {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title">今日打卡报告</div>
        <img class="share-img" src="${dataUrl}" alt="今日打卡报告">
        ${isIOS ? '<div class="share-tip">iOS 请长按图片保存到相册</div>' : ''}
        <div class="modal-btns">
          <button class="btn btn-secondary" id="share-close">关闭</button>
          <button class="btn btn-primary" id="share-save">保存图片</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#share-close').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#share-save').addEventListener('click', () => saveShareImage(dataUrl, dateShort));
  }

  function saveShareImage(dataUrl, dateShort) {
    const link = document.createElement('a');
    link.download = `JLPT打卡_${dateShort}.png`;
    link.href = dataUrl;
    link.click();
  }

  // ---------- 入口（首页按钮点击） ----------
  async function open() {
    try {
      const data = await collectData();
      showShareModal(generateShareCard(data), data.dateShort);
    } catch (e) {
      console.error('[Share] 生成失败', e);
      alert('生成失败，请检查网络后重试');
    }
  }

  return { open };
})();
