#!/usr/bin/env node
/**
 * gen_continuation.js — 接续选择题生成
 *
 * 用法：
 *   node tools/gen_continuation.js                       # 读 data/grammar_clean.json，写 data/questions_continuation.json
 *   node tools/gen_continuation.js --input <json>        # 指定输入（自测用 fixture）
 *   node tools/gen_continuation.js --out <json>          # 指定输出（自测时不污染正式产物）
 *   node tools/gen_continuation.js --report <md>         # 指定报告路径（默认 data/questions_report.md）
 *   node tools/gen_continuation.js --seed 12345          # 随机种子（默认 20261005，同输入同种子输出可复现）
 *
 * 数据源契约：data/grammar_clean.json 为数组，每项字段：
 *   pattern, meaning, continuation, example1, example1_zh, example2, example2_zh,
 *   level(N5/N4/N3/N2), pos(16 主题中文名), theme_order(1-16), frequency
 *
 * 出题规则（每语法点 3 道，硬约束）：
 *   1. 正确项 = 该条目的 continuation 原文。
 *   2. 重组模式（continuation 含「＋」）：干扰项 = 别的语法接续左部 + 本题接续右部，
 *      如正确项「名詞＋ばかりか」→「動詞辞書形＋ばかりか」。
 *      continuation 以第一个「＋/+」分割取左部。
 *   3. 整串模式（有 continuation 但无「＋」，如「動詞て形」「ない形」）：正确项 = continuation 整串，
 *      干扰项 = 其他语法 continuation 整串；同样本级优先、相邻级别补充、归一化两两不同。
 *      准入闸：continuation 必须是「选项样」短接续式（≤30 字符、不含空格/括号/说明标点）；
 *      说明性文字（如「[前の 文]. それから [現在の 文]」）不进此模式，进缺题清单等数据侧改写。
 *   4. 无 continuation 字段的条目不出题、不编数据，进缺题清单（原因：需数据侧补 continuation）。
 *   5. 干扰源先取同级别其他语法，同级别凑不齐 3 个不同选项时按 N5↔N4↔N3↔N2 距离向相邻级别扩展；
 *      四选项（归一化后）必须两两不同（全半角、＋空格、波浪号统一，见 tools/lib/common.js）。
 *   6. 兜底：全库都凑不出 3 个不同选项时，改用「接续（pattern）」整体对比表述凑齐，
 *      该题 reviewed=false（进人工抽查队列），报告单列数量（预期 <3%）。
 *   所有自动题 reviewed=false（与输出契约一致）；只有第 6 条兜底题额外在报告单列。
 */
'use strict';

const C = require('./lib/common');

const args = C.parseArgs(process.argv.slice(2));
const INPUT = args.input || 'data/grammar_clean.json';
const OUT = args.out || 'data/questions_continuation.json';
const REPORT = args.report || 'data/questions_report.md';
const SEED = Number(args.seed || 20261005);

const LEVELS = ['N5', 'N4', 'N3', 'N2'];

// 干扰源级别扩展顺序：本级 → 相邻（距离 1）→ 距离 2 → 距离 3
function levelOrder(level) {
  const i = LEVELS.indexOf(level);
  if (i < 0) return LEVELS.slice();
  return LEVELS.slice().sort((a, b) => {
    if (a === level) return -1;
    if (b === level) return 1;
    return Math.abs(LEVELS.indexOf(a) - i) - Math.abs(LEVELS.indexOf(b) - i);
  });
}

// continuation 以第一个 ＋/+ 分割：左部作干扰来源，右部保留本题部分。
// 返回 null 表示无有效左部（整条没有 ＋，或 ＋ 在最开头）。
function splitContinuation(cont) {
  const m = cont.match(/[＋+]/);
  if (!m || m.index === 0) return null;
  return { sep: m[0], left: cont.slice(0, m.index).trim(), right: cont.slice(m.index + 1) };
}

// 重组模式（有「＋」）：干扰项 = 别的语法左部 + 本题右部；按级别顺序扩展，归一化去重。
function recombCandidates(target, parts, eligiblePlus, stats) {
  const contNorm = C.normalizeOption(target.continuation.trim());
  const seen = new Set([contNorm]);
  const out = [];
  for (const lv of levelOrder(target.level)) {
    for (const e of eligiblePlus) {
      if (e.it === target || e.it.level !== lv) continue;
      const text = `${e.parts.left}${parts.sep}${parts.right}`;
      const norm = C.normalizeOption(text);
      if (norm === contNorm) { stats.sameLeftExcluded++; continue; } // 左部相同 → 与正确项字面重复
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push({ text, level: lv });
    }
    if (out.length >= 3) break;
  }
  return out;
}

// 整串模式（无「＋」）：干扰项 = 其他语法 continuation 整串；按级别顺序扩展，归一化去重。
function wholeCandidates(target, poolAll, stats) {
  const contNorm = C.normalizeOption(target.continuation.trim());
  const seen = new Set([contNorm]);
  const out = [];
  for (const lv of levelOrder(target.level)) {
    for (const e of poolAll) {
      if (e.it === target || e.it.level !== lv) continue;
      const text = String(e.it.continuation).trim();
      if (!text) continue;
      const norm = C.normalizeOption(text);
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push({ text, level: lv });
    }
    if (out.length >= 3) break;
  }
  return out;
}

// 整串模式准入：continuation 必须是「选项样」的短接续式（如「動詞て形」「ない形」），
// 不能是说明性文字（含空格/括号/说明标点/超长），否则出题质量不可接受 → 退回缺题清单等数据侧改写。
function isWholeModeEligible(cont) {
  const t = String(cont || '').trim();
  if (!t || t.length > 30) return false;
  return !/[\s\[\]【】（）()：:；;。、，,→｜|/／・]/.test(t);
}

// 兜底：「接续（pattern）」整体对比表述，从全库任取，只要选项两两不同。不足 3 个返回 null。
function compositeFallback(target, poolAll) {
  const corr = `${target.continuation.trim()}（${target.pattern}）`;
  const seen = new Set([C.normalizeOption(corr)]);
  const fb = [];
  for (const e of poolAll) {
    if (e.it === target) continue;
    const srcCont = String(e.it.continuation || '').trim();
    if (!srcCont) continue;
    const text = `${srcCont}（${e.it.pattern}）`;
    const norm = C.normalizeOption(text);
    if (seen.has(norm)) continue;
    seen.add(norm);
    fb.push(text);
    if (fb.length >= 3) break;
  }
  return fb.length >= 3 ? { options: [corr, ...fb] } : null;
}

function buildOne(mode, it, parts, eligiblePlus, poolAll, rng, stats) {
  let chosen = null;
  if (mode === 'recomb') chosen = recombCandidates(it, parts, eligiblePlus, stats);
  else chosen = wholeCandidates(it, poolAll, stats);

  let options;
  let correctText;
  let fallback = false;

  if (chosen.length >= 3) {
    const picked = C.sample(chosen, 3, rng);
    if (picked.some((c) => c.level !== it.level)) stats.crossLevel++;
    correctText = it.continuation.trim();
    options = C.shuffle([correctText, picked[0].text, picked[1].text, picked[2].text], rng);
  } else {
    const fb = compositeFallback(it, poolAll);
    if (!fb) return null; // 全库干扰项不足，放弃本题
    fallback = true;
    correctText = fb.options[0];
    options = C.shuffle(fb.options, rng);
  }

  const correct = options.indexOf(correctText);
  if (fallback) stats.fallback++;
  else if (mode === 'whole') stats.wholeMode++;
  return {
    grammar_pattern: it.pattern,
    type: 'continuation',
    question: `「${it.pattern}」的正确接续是？`,
    question_zh: null,
    options,
    correct,
    explanation: `${it.pattern} 的接续是「${correctText}」。`,
    source: 'auto',
    reviewed: false,
    level: it.level != null ? it.level : null,
    theme: it.pos != null ? it.pos : null,
  };
}

function renderReport(o) {
  const L = [];
  L.push('## 接续选择题（continuation）');
  L.push('');
  L.push(`- 生成时间：${o.time}`);
  L.push(`- 数据源：\`${o.input}\`（语法条目 ${o.totalItems} 条；可出接续题 ${o.eligible} 条：重组模式 ${o.plusCount} 条 + 整串模式 ${o.wholeCount} 条；continuation 为说明性文字待数据侧改写 ${o.dirtyCount} 条）`);
  L.push(`- 产出题数：**${o.questions} 道**（每语法点 3 道）`);
  L.push(`- 四选项重复率：**${o.dupRate}**（重复题 ${o.dupCount} 道，应为 0）${o.dupCount === 0 ? '✅' : '❌'}`);
  L.push(`- 整串模式题（continuation 无「＋」，如「動詞て形」）：${o.wholeMode} 道`);
  L.push(`- 兜底题（「接续（pattern）」整体表述，reviewed=false 进人工抽查）：${o.fallback} 道（${o.fallbackRate}）`);
  L.push(`- 用了相邻级别干扰源的题：${o.crossLevel} 道；重组模式左部与正确项相同被排除：${o.sameLeftExcluded} 次`);
  L.push('');
  L.push('### 题量分布');
  L.push('');
  L.push(`0 道：${o.hist[0]} 条语法；1 道：${o.hist[1]} 条；2 道：${o.hist[2]} 条；3 道：${o.hist[3]} 条。`);
  L.push('');
  L.push('| 语法 | 级别 | 主题 | 题数 |');
  L.push('| --- | --- | --- | --- |');
  for (const row of o.perGrammar) L.push(`| ${row.pattern} | ${row.level} | ${row.pos} | ${row.count} |`);
  L.push('');
  L.push('### 缺题清单（题数 < 2，必须清零；剩余项均属「必须改数据才能解决」）');
  L.push('');
  if (!o.missing.length) L.push('无 ✅');
  else {
    L.push('| 语法 | 级别 | 题数 | 原因 |');
    L.push('| --- | --- | --- | --- |');
    for (const m of o.missing) L.push(`| ${m.pattern} | ${m.level} | ${m.count} | ${m.reason} |`);
  }
  L.push('');
  L.push('### 跳过/模式记录（原始明细）');
  L.push('');
  L.push(`- 无 continuation 字段（需数据侧补，已计入上方缺题清单）：${o.skippedNoCont.length ? o.skippedNoCont.map((x) => x.pattern).join('、') : '无'}`);
  return L.join('\n');
}

function main() {
  const items = C.readJson(INPUT);
  if (!Array.isArray(items)) throw new Error(`输入必须是数组：${INPUT}`);

  const rng = C.mulberry32(SEED);
  const skippedNoCont = [];
  const skippedDirty = []; // 有 continuation 但无「＋」且为说明性文字 → 需数据侧改写
  const eligiblePlus = [];
  const eligibleWhole = [];

  for (const it of items) {
    if (!it || typeof it.pattern !== 'string' || !it.pattern.trim()) continue;
    if (typeof it.continuation !== 'string' || !it.continuation.trim()) { skippedNoCont.push(it); continue; }
    const parts = splitContinuation(it.continuation.trim());
    if (parts) eligiblePlus.push({ it, parts });
    else if (isWholeModeEligible(it.continuation)) eligibleWhole.push({ it });
    else skippedDirty.push(it);
  }
  const poolAll = [...eligiblePlus, ...eligibleWhole]; // 整串/兜底模式的干扰源池（凡有 continuation 者皆可）

  const stats = { fallback: 0, wholeMode: 0, sameLeftExcluded: 0, crossLevel: 0 };
  const questions = [];
  const perCount = new Map();
  const shortage = [];

  for (const e of eligiblePlus) {
    let made = 0;
    for (let q = 0; q < 3; q++) {
      const qu = buildOne('recomb', e.it, e.parts, eligiblePlus, poolAll, rng, stats);
      if (qu) { questions.push(qu); made++; }
    }
    perCount.set(e.it.pattern, made);
    if (made < 3) shortage.push({ pattern: e.it.pattern, level: e.it.level, made });
  }
  for (const e of eligibleWhole) {
    let made = 0;
    for (let q = 0; q < 3; q++) {
      const qu = buildOne('whole', e.it, null, eligiblePlus, poolAll, rng, stats);
      if (qu) { questions.push(qu); made++; }
    }
    perCount.set(e.it.pattern, made);
    if (made < 3) shortage.push({ pattern: e.it.pattern, level: e.it.level, made });
  }

  // 防御性复查：四选项归一化后必须两两不同（最后一道闸）
  let dupCount = 0;
  const dupList = [];
  for (const q of questions) {
    const norms = q.options.map(C.normalizeOption);
    if (new Set(norms).size !== norms.length) { dupCount++; dupList.push(q.grammar_pattern); }
  }
  if (dupCount > 0) {
    console.error(`警告：${dupCount} 道题四选项归一化后仍有重复：${dupList.join('、')}`);
  }

  const outFull = C.writeJson(OUT, questions);

  const hist = [0, 0, 0, 0];
  const perGrammar = items
    .filter((it) => it && typeof it.pattern === 'string' && it.pattern.trim())
    .map((it) => {
      const n = perCount.get(it.pattern) || 0;
      hist[Math.min(n, 3)]++;
      return { pattern: it.pattern, level: it.level || '', pos: it.pos || '', count: n };
    });
  perGrammar.sort((a, b) => a.count - b.count || a.pattern.localeCompare(b.pattern, 'zh-Hans-CN'));

  const missing = [
    ...skippedNoCont.map((it) => ({ pattern: it.pattern, level: it.level || '', count: 0, reason: '源数据无 continuation 字段，需数据侧补' })),
    ...skippedDirty.map((it) => ({ pattern: it.pattern, level: it.level || '', count: 0, reason: 'continuation 无「＋」且为说明性文字（非选项式接续），需数据侧改写成「左部＋右部」式接续' })),
    ...shortage.map((s) => ({ pattern: s.pattern, level: s.level || '', count: s.made, reason: '全库干扰项不足 3 个不同接续（含兜底），需数据侧扩充' })),
  ];

  const report = renderReport({
    time: C.nowStr(),
    input: INPUT,
    totalItems: items.length,
    eligible: poolAll.length,
    plusCount: eligiblePlus.length,
    wholeCount: eligibleWhole.length,
    questions: questions.length,
    dupCount,
    dupRate: C.pct(dupCount, questions.length),
    wholeMode: stats.wholeMode,
    fallback: stats.fallback,
    fallbackRate: C.pct(stats.fallback, questions.length),
    crossLevel: stats.crossLevel,
    sameLeftExcluded: stats.sameLeftExcluded,
    hist,
    perGrammar,
    missing,
    skippedNoCont,
    dirtyCount: skippedDirty.length,
  });
  const reportFull = C.upsertReportSection(REPORT, 'continuation', report);

  console.log(report);
  console.log(`\n已写出 ${questions.length} 道题 → ${outFull}`);
  console.log(`报告已更新 → ${reportFull}`);
  console.log(`[summary] {"type":"continuation","total":${questions.length},"fallback":${stats.fallback},"dup":${dupCount},"blacklist":0,"whole":${stats.wholeMode}}`);
}

try {
  main();
} catch (e) {
  console.error(`生成失败：${e.message}`);
  process.exit(1);
}
