#!/usr/bin/env node
/**
 * import_manual150.js — 人工辨析题（similar）导入脚本
 *
 * 用法：
 *   node tools/import_manual150.js                # dry-run（默认）：检查数据文件、按 meta.field_mapping
 *                                                 # 解析、打印统计与样例，不写任何文件
 *   node tools/import_manual150.js --run          # 解析并写出 data/questions_similar.json
 *   node tools/import_manual150.js --run --import # 写出后立即经 Supabase REST 写入 grammar_questions
 *                                                 # （grammar_pattern → grammar.id 的匹配规则与
 *                                                 #   import_questions.js 相同：归一化全量映射，不匹配跳过并打印）
 *
 * 数据文件：`日语语法辨析题_N2核心150道.json`，放在仓库根目录（当前可能尚未提供）。
 *   脚本开头检查文件存在性，不存在则明确报错退出（exit 1）。
 *   期望结构：
 *   {
 *     "meta": { "field_mapping": { "<规范字段名或源字段名>": "..." }, ... },
 *     "questions": [ { ...每题字段... } ]        // 兼容 items / data / 顶层数组
 *   }
 *   meta.field_mapping 支持两种方向（自动识别）：
 *     a) 规范字段名 → 数据文件里的实际字段名（推荐，如 {"grammar_pattern": "语法点"}）
 *     b) 数据文件里的实际字段名 → 规范字段名
 *   规范字段名：grammar_pattern, question, question_zh, options, correct, explanation,
 *   以及保留字段 level, theme, bloom_level, difficulty（原样带进输出 JSON）。
 *
 * 输出契约（与接续/语境题相同，额外字段原样保留）：
 *   { grammar_pattern, type: "similar", question, question_zh, options, correct,
 *     explanation, source: "manual", reviewed: true, level, theme, bloom_level, difficulty }
 *   correct 兼容数字索引（0 起）或字母（"A"-"D"）。
 */
'use strict';

const fs = require('fs');
const C = require('./lib/common');
const SB = require('./lib/supabase');

const DEFAULT_FILE = '日语语法辨析题_N2核心150道.json';
const DEFAULT_OUT = 'data/questions_similar.json';
const CANON_FIELDS = ['grammar_pattern', 'question', 'question_zh', 'options', 'correct', 'explanation'];
const EXTRA_FIELDS = ['level', 'theme', 'bloom_level', 'difficulty'];

function detectMapping(fieldMapping) {
  const keys = Object.keys(fieldMapping || {});
  if (!keys.length) return null;
  if (keys.some((k) => CANON_FIELDS.includes(k))) {
    return (canon) => fieldMapping[canon] || null; // 方向 a：规范名 → 源字段名
  }
  if (keys.some((k) => CANON_FIELDS.includes(fieldMapping[k]))) {
    return (canon) => {
      const src = keys.find((k) => fieldMapping[k] === canon);
      return src || null;
    }; // 方向 b：源字段名 → 规范名
  }
  return null;
}

function toIndex(correct, nOptions) {
  if (typeof correct === 'number' && Number.isInteger(correct)) return correct;
  if (typeof correct === 'string') {
    const t = correct.trim();
    if (/^[A-Za-z]$/.test(t)) return t.toUpperCase().charCodeAt(0) - 65;
    if (/^\d+$/.test(t)) return parseInt(t, 10);
  }
  return NaN;
}

function transform(items, getSourceField) {
  const rows = [];
  const invalid = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const get = (canon) => {
      const f = getSourceField(canon);
      return f != null && it[f] !== undefined ? it[f] : it[canon];
    };
    const row = {
      grammar_pattern: get('grammar_pattern'),
      type: 'similar',
      question: get('question'),
      question_zh: get('question_zh') != null ? get('question_zh') : null,
      options: get('options'),
      correct: toIndex(get('correct'), Array.isArray(get('options')) ? get('options').length : 0),
      explanation: get('explanation'),
      source: 'manual',
      reviewed: true,
    };
    for (const f of EXTRA_FIELDS) {
      const v = get(f);
      if (v !== undefined && v !== null) row[f] = v;
    }
    const problems = [];
    if (typeof row.grammar_pattern !== 'string' || !row.grammar_pattern.trim()) problems.push('grammar_pattern 缺失');
    if (typeof row.question !== 'string' || !row.question.trim()) problems.push('question 缺失');
    if (!Array.isArray(row.options) || row.options.length !== 4) problems.push(`options 非 4 项数组（实际 ${Array.isArray(row.options) ? row.options.length : typeof row.options}）`);
    if (!(row.correct >= 0 && row.correct < (Array.isArray(row.options) ? row.options.length : 0))) problems.push(`correct 无法解析为合法索引（实际 ${JSON.stringify(get('correct'))}）`);
    if (typeof row.explanation !== 'string' || !row.explanation.trim()) problems.push('explanation 缺失');
    if (problems.length) { invalid.push({ index: i, pattern: row.grammar_pattern, problems }); continue; }
    rows.push(row);
  }
  return { rows, invalid };
}

async function main() {
  const args = C.parseArgs(process.argv.slice(2));
  const doRun = args.run === true;
  const doImport = args.import === true;
  const filePath = args.input || DEFAULT_FILE;
  const outPath = args.out || DEFAULT_OUT;

  const full = C.resolveRoot(filePath);
  if (!fs.existsSync(full)) {
    console.error(`错误：未找到数据文件：${full}`);
    console.error(`请将「${DEFAULT_FILE}」放到仓库根目录后重试（当前为 dry-run 阶段，脚本已写好、数据暂缺属预期）。`);
    process.exit(1);
  }

  const data = C.readJson(filePath);
  const items = Array.isArray(data) ? data : (data.questions || data.items || data.data);
  if (!Array.isArray(items)) throw new Error(`${filePath} 中找不到题目数组（questions/items/data）`);

  const getSourceField = detectMapping(data.meta && data.meta.field_mapping);
  if (!getSourceField) {
    console.error(`错误：${filePath} 缺少可识别的 meta.field_mapping（需含规范字段名作为键或值）。`);
    process.exit(1);
  }

  const { rows, invalid } = transform(items, getSourceField);

  // 用户裁决的别名映射（可选）：data/manual150_alias.json = { 题库pattern: 词库pattern }
  // 匹配前应用；应用后仍不匹配的才进不匹配清单（禁止猜的规则不变）
  const aliasPath = C.resolveRoot('data/manual150_alias.json');
  let aliasApplied = 0;
  if (fs.existsSync(aliasPath)) {
    const alias = JSON.parse(fs.readFileSync(aliasPath, 'utf8'));
    for (const r of rows) {
      if (alias[r.grammar_pattern]) {
        r.grammar_pattern = alias[r.grammar_pattern];
        aliasApplied++;
      }
    }
    console.log(`别名映射：命中 ${aliasApplied} 道题（data/manual150_alias.json）`);
  }

  console.log('===== 解析统计 =====');
  console.log(`  数据文件：${filePath}`);
  console.log(`  题目总数：${items.length}；可转换：${rows.length}；不合法跳过：${invalid.length}`);
  for (const inv of invalid) console.log(`  - 第 ${inv.index + 1} 题（${inv.pattern || '?'}）：${inv.problems.join('；')}`);

  if (rows.length) {
    console.log('\n样例行（第一题）：');
    console.log(JSON.stringify(rows[0], null, 2));
  }

  if (!doRun) {
    console.log('\n[dry-run] 未写出任何文件。确认无误后加 --run 生成 data/questions_similar.json（加 --import 同时写库）。');
    return;
  }

  const outFull = C.writeJson(outPath, rows);
  console.log(`\n已写出 ${rows.length} 道题 → ${outFull}`);

  if (!doImport) return;

  const cfg = SB.loadConfig();
  console.log(`\nSupabase：${cfg.url}`);
  const { map: gmap, dupPatterns } = await SB.fetchGrammarMap(cfg);
  if (dupPatterns.length) console.log(`  警告：表内归一化后重复的 pattern（只取第一条）：${dupPatterns.join('、')}`);
  const { resolved, unmatched } = SB.resolveGrammarIds(rows, gmap);
  console.log(`\n===== 不匹配清单（${unmatched.size} 个 pattern，跳过，禁止猜匹配）=====`);
  if (unmatched.size) for (const [pat, n] of [...unmatched.entries()].sort((a, b) => b[1] - a[1])) console.log(`  - ${pat}（${n} 道题）`);
  else console.log('  无（全部匹配）');
  console.log(`可写入：${resolved.length} 道；跳过：${rows.length - resolved.length} 道。`);

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
