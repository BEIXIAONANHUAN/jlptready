#!/usr/bin/env node
/**
 * import_grammar.js — 把 data/grammar_clean.json 导入 Supabase grammar 表
 *
 * 用法：
 *   node tools/import_grammar.js          # dry-run（默认）：只打印统计与样例，不写库
 *   node tools/import_grammar.js --run    # 批量 insert（每批 500）
 *
 * 幂等保护：grammar 表非空时拒绝导入（防重复），确需重导请先清空表再加 --force。
 * 只写 grammar 一张表，不碰任何其他表。
 */
'use strict';

const fs = require('fs');
const SB = require('./lib/supabase');

const FILE = 'data/grammar_clean.json';
const LEVELS = ['N5', 'N4', 'N3', 'N2'];
const THEME_COUNT = 16;

async function main() {
  const run = process.argv.includes('--run');
  const force = process.argv.includes('--force');

  const rows = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (!Array.isArray(rows) || !rows.length) throw new Error(`${FILE} 为空或不是数组`);

  // 落库前最后校验：11 字段契约
  const bad = [];
  const seen = new Set();
  for (const [i, g] of rows.entries()) {
    const problems = [];
    if (!g.pattern || !g.meaning) problems.push('pattern/meaning 空');
    if (!LEVELS.includes(g.level)) problems.push(`level 非法：${g.level}`);
    if (!Number.isInteger(g.theme_order) || g.theme_order < 1 || g.theme_order > THEME_COUNT) problems.push(`theme_order 非法：${g.theme_order}`);
    if (!g.pos) problems.push('pos 空');
    if (!g.example1 || !g.example1_zh) problems.push('example1/example1_zh 空');
    if (g.example2 && !g.example2_zh) problems.push('example2 缺译文');
    if (seen.has(g.pattern)) problems.push('pattern 重复');
    seen.add(g.pattern);
    if (problems.length) bad.push(`${i}: ${g.pattern} — ${problems.join('；')}`);
  }
  if (bad.length) {
    console.error(`契约校验失败 ${bad.length} 条：\n` + bad.slice(0, 20).join('\n'));
    process.exit(1);
  }

  const lv = {};
  for (const g of rows) lv[g.level] = (lv[g.level] || 0) + 1;
  console.log(`待导入 ${rows.length} 条（N5 ${lv.N5 || 0} / N4 ${lv.N4 || 0} / N3 ${lv.N3 || 0} / N2 ${lv.N2 || 0}）`);
  console.log('样例：', JSON.stringify(rows[0]));

  const cfg = SB.loadConfig();

  // 幂等保护
  const existing = await SB.req(cfg, 'GET', '/rest/v1/grammar?select=id&limit=1');
  if (existing.length && !force) {
    console.error('grammar 表非空，拒绝重复导入。确认要重导请先清空表再加 --force。');
    process.exit(1);
  }

  if (!run) {
    console.log('\n[dry-run] 未写入任何数据。确认无误后加 --run 执行。');
    return;
  }

  const payload = rows.map((g) => ({
    pattern: g.pattern,
    meaning: g.meaning,
    continuation: g.continuation || null,
    example1: g.example1,
    example1_zh: g.example1_zh,
    example2: g.example2 || null,
    example2_zh: g.example2_zh || null,
    pos: g.pos,
    level: g.level,
    theme_order: g.theme_order,
    frequency: g.frequency || 0,
  }));

  let inserted = 0;
  for (let i = 0; i < payload.length; i += 500) {
    const chunk = payload.slice(i, i + 500);
    await SB.req(cfg, 'POST', '/rest/v1/grammar', chunk);
    inserted += chunk.length;
    console.log(`已写入 ${inserted}/${payload.length}`);
  }
  console.log(`完成：grammar 表共写入 ${inserted} 行。`);
}

main().catch((e) => {
  console.error(`导入失败：${e.message}`);
  process.exit(1);
});
