#!/usr/bin/env node
/**
 * import_questions.js — 题库导入脚本（Supabase REST，零依赖，Node 18+）
 *
 * 用法：
 *   node tools/import_questions.js            # dry-run（默认）：解析文件、拉取 grammar 表建映射、
 *                                             # 打印统计与「不匹配清单」，不写库
 *   node tools/import_questions.js --run      # 真正批量插入 grammar_questions（每批 500）
 *   node tools/import_questions.js --data-dir <dir>  # 题库 JSON 所在目录（默认 data，自测用）
 *
 * 读取（存在的才读，全缺则退出）：
 *   data/questions_continuation.json  （type=continuation）
 *   data/questions_context.json       （type=context）
 *   data/questions_similar.json       （type=similar，由 import_manual150.js 生成，可选）
 *
 * 要点：
 *   - Supabase 连接信息从 js/config.js 正则提取 SUPABASE_URL / SUPABASE_ANON_KEY。
 *   - grammar_pattern → grammar.id：REST 全量拉取 grammar 表（分页 1000）建归一化映射
 *     （去开头〜 + 全半角统一，规则与生成脚本相同）。匹配不上的一律进「不匹配清单」打印，
 *     对应题目跳过，绝不猜匹配。
 *   - grammar_questions 表有 grammar_id/type/question/question_zh/options/correct/
 *     explanation/source/reviewed/level/theme/bloom_level/difficulty 列；
 *     JSON 里带了的扩展字段一并入库，没带的写 null。
 */
'use strict';

const fs = require('fs');
const C = require('./lib/common');
const SB = require('./lib/supabase');

const FILES = [
  ['continuation', 'questions_continuation.json'],
  ['context', 'questions_context.json'],
  ['similar', 'questions_similar.json'],
];

function loadRows(dataDir) {
  const rows = [];
  const fileStats = [];
  for (const [type, name] of FILES) {
    const p = `${dataDir.replace(/\/+$/, '')}/${name}`;
    const full = C.resolveRoot(p);
    if (!fs.existsSync(full)) {
      fileStats.push({ type, path: p, count: 0, note: '文件不存在，跳过' });
      continue;
    }
    const arr = C.readJson(p);
    if (!Array.isArray(arr)) throw new Error(`${p} 必须是数组`);
    let bad = 0;
    for (const q of arr) {
      if (!q || typeof q.grammar_pattern !== 'string' || !Array.isArray(q.options)) { bad++; continue; }
      rows.push({ ...q, type: q.type || type });
    }
    fileStats.push({ type, path: p, count: arr.length, note: bad ? `其中 ${bad} 条结构不合法已忽略` : '' });
  }
  return { rows, fileStats };
}

function printUnmatched(unmatched) {
  if (!unmatched.size) { console.log('  无（全部匹配）'); return; }
  const entries = [...unmatched.entries()].sort((a, b) => b[1] - a[1]);
  for (const [pat, n] of entries) console.log(`  - ${pat}（${n} 道题）`);
}

async function main() {
  const args = C.parseArgs(process.argv.slice(2));
  const run = args.run === true;
  const dataDir = typeof args['data-dir'] === 'string' ? args['data-dir'] : 'data';
  const { rows, fileStats } = loadRows(dataDir);
  if (!rows.length) {
    console.log('三个题库 JSON 都不存在或为空。请先运行 gen_continuation.js / gen_context.js / import_manual150.js --run。');
    return;
  }

  console.log('===== 文件统计 =====');
  for (const f of fileStats) console.log(`  ${f.path}：${f.count} 道 ${f.note}`);
  console.log(`  合计待导入：${rows.length} 道`);

  const cfg = SB.loadConfig();
  console.log(`\nSupabase：${cfg.url}`);
  console.log('正在拉取 grammar 表建 pattern → id 映射…');
  const { map: gmap, dupPatterns } = await SB.fetchGrammarMap(cfg);
  console.log(`  grammar 表共 ${gmap.size} 个归一化 pattern。`);
  if (dupPatterns.length) console.log(`  警告：表内归一化后重复的 pattern（只取第一条）：${dupPatterns.join('、')}`);

  const { resolved, unmatched } = SB.resolveGrammarIds(rows, gmap);
  console.log(`\n===== 不匹配清单（${unmatched.size} 个 pattern，对应题目将跳过，禁止猜匹配）=====`);
  printUnmatched(unmatched);
  console.log(`\n可写入：${resolved.length} 道；因不匹配跳过：${rows.length - resolved.length} 道。`);

  if (resolved.length) {
    console.log('\n样例行（第一题）：');
    console.log(JSON.stringify(resolved[0], null, 2));
  }
  console.log('\n说明：JSON 中的 level/theme/bloom_level/difficulty 随题一并入库（表内已有对应列）。');

  if (!run) {
    console.log('\n[dry-run] 未写入任何数据。确认无误后加 --run 执行批量插入（每批 500）。');
    return;
  }

  console.log('\n开始写入…');
  const { batches, inserted } = await SB.batchInsert(cfg, resolved, 500, (b, n, total) => {
    console.log(`  批次 ${b}：${n} 行（累计 ${Math.min(b * 500, total)}/${total}）`);
  });
  console.log(`完成：${batches} 批，共 ${inserted} 行写入 grammar_questions。`);
}

main().catch((e) => {
  console.error(`导入失败：${e.message}`);
  process.exit(1);
});
