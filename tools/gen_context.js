#!/usr/bin/env node
/**
 * gen_context.js — 语境填空题生成
 *
 * 用法：
 *   node tools/gen_context.js                       # 读 data/grammar_clean.json，写 data/questions_context.json
 *   node tools/gen_context.js --input <json>        # 指定输入（自测用 fixture）
 *   node tools/gen_context.js --out <json>          # 指定输出（自测时不污染正式产物）
 *   node tools/gen_context.js --report <md>         # 指定报告路径（默认 data/questions_report.md）
 *   node tools/gen_context.js --seed 12345          # 随机种子（默认 20261005）
 *
 * 数据源契约同 gen_continuation.js。
 *
 * 出题规则（每语法点至少 1 道、最多 2 道，example1 不行试 example2，硬约束）：
 *   1. 挖空定位（四级递进）：
 *      a. pattern 按「／」「/」（括号外）拆候选形（如「〜において / 〜における」→ において／における）；
 *      b. 每个候选形剥开头「〜/～」、去空白；可选括号段做笛卡尔展开——先保留括号内容
 *         （ならでは（の）→ ならではの；中（ちゅう／じゅう）→ 中ちゅう／中じゅう），
 *         再整段删除（→ ならでは／中），全半角括号都算；
 *      c. 依次在 example1/example2 中定位，任一命中即挖空（只挖命中的那段文本），四级顺序：
 *         ① 候选形直接 indexOf → ② 形态交替扩展（例句为敬体/活用形时为候选形派生
 *            ます/ました/た/って 等交替面，如 ている→ています、終わる→終わりました、予定だ→予定です）
 *         → ③ 助词宽松匹配（候选形结尾后缀 ≥3 字符）→ ④ 槽位片段直接匹配
 *            （「もう＋動詞た形」「〜ば〜ほど」类内部槽位 pattern 拆出的 ≥2 字符片段）；
 *      d. 四级都不命中才记缺题，原因附候选形清单与例句原文，供数据侧修复。
 *   2. 3 个干扰项的 pos 必须与正确项 pos 不同（功能异类，消除歧义）。
 *   3. 歧义黑名单：正确项与干扰项命中已知可互换对（见下 BLACKLIST_PAIRS）时换干扰项，
 *      命中次数进报告。
 *   4. 四选项（pattern）归一化后两两不同。
 *   5. 挖空后题干长度 <6 字符跳过。question_zh = 该例句中文译文（必填）。
 */
'use strict';

const C = require('./lib/common');

const args = C.parseArgs(process.argv.slice(2));
const INPUT = args.input || 'data/grammar_clean.json';
const OUT = args.out || 'data/questions_context.json';
const REPORT = args.report || 'data/questions_report.md';
const SEED = Number(args.seed || 20261005);

// 歧义黑名单：已知在语境题中可互换/易造成双正确答案的条目对。
// 命中即拒绝该干扰项（即使 pos 不同）。归一化（去开头〜 + 全半角统一）后做无序匹配。
// 可随教研补充：往 BLACKLIST_PAIRS 里加 [条目A, 条目B] 即可。
const BLACKLIST_PAIRS = [
  // 原因・理由
  ['ので', 'から'], ['だから', 'ので'], ['だから', 'から'], ['それで', 'ので'], ['それで', 'から'], ['だから', 'それで'],
  // 条件（ば/たら/なら/と 家族）
  ['ば', 'たら'], ['ば', 'なら'], ['ば', 'と'], ['たら', 'なら'], ['たら', 'と'], ['なら', 'と'],
  // 递进・并列
  ['だけでなく', 'のみならず'], ['だけでなく', 'ばかりか'], ['のみならず', 'ばかりか'], ['し', 'だけでなく'],
  // 目的
  ['ように', 'ために'], ['ために', 'ためには'], ['ように', 'ようには'],
  // 时间界限
  ['までに', 'まで'], ['うちに', 'あいだ'], ['うちに', '間に'], ['あいだ', '間に'], ['うちに', 'あいだに'], ['あいだ', 'あいだに'],
  // 逆接
  ['ても', 'でも'], ['ても', 'たって'], ['ても', 'としても'], ['でも', 'たって'],
  ['のに', 'くせに'], ['のに', 'ものの'], ['くせに', 'ものの'],
  ['が', 'けれど'], ['が', 'けど'], ['が', 'しかし'], ['が', 'けれども'], ['けれど', 'けど'],
  ['けれど', 'しかし'], ['けど', 'しかし'], ['けれども', 'けれど'],
  ['ながら', 'つつ'], ['ながら', 'ものの'], ['つつ', 'ものの'],
  // 程度・比况・样态传闻
  ['ほど', 'くらい'], ['ほど', 'ぐらい'], ['くらい', 'ぐらい'],
  ['ようだ', 'みたいだ'], ['ようだ', 'らしい'], ['そうだ', 'ようだ'], ['そうだ', 'らしい'], ['みたいだ', 'らしい'],
  // 强调・极端举例
  ['さえ', 'でも'], ['さえ', 'まで'], ['でも', 'まで'], ['こそ', 'さえ'], ['こそ', 'でも'],
  // 传闻・引用
  ['によると', 'によれば'], ['という', 'によると'],
  // 其他常见易混
  ['たびに', 'ごとに'], ['おきに', 'ごとに'], ['について', 'に関して'],
  ['ぜひ', 'きっと'], ['かもしれない', 'はずだ'],
  ['べきだ', 'なければならない'], ['なければならない', 'なければいけない'], ['てもいい', 'てもかまわない'],
];

const BL_SET = new Set(BLACKLIST_PAIRS.map(([a, b]) => [C.normPat(a), C.normPat(b)].sort().join('|')));

function isBlacklisted(a, b) {
  return BL_SET.has([C.normPat(a), C.normPat(b)].sort().join('|'));
}

// 干扰项：pos 与正确项不同 + 黑名单排除 + 归一化去重，取 3 个。
// 返回 3 个 pattern 数组或 null（凑不齐）。黑名单命中计数写入 stats。
function pickDistractors(target, items, rng, stats) {
  const seen = new Set([C.normPat(target.pattern)]);
  const uniq = [];
  let evaluated = 0;
  for (const o of items) {
    if (!o || o === target) continue;
    if (typeof o.pattern !== 'string' || !o.pattern.trim()) continue;
    if (o.pos === target.pos) continue; // 约束 2：功能异类
    evaluated++;
    if (isBlacklisted(target.pattern, o.pattern)) { stats.blacklistHits++; continue; } // 约束 3
    const n = C.normPat(o.pattern);
    if (seen.has(n)) continue; // 约束 4
    seen.add(n);
    uniq.push(o.pattern);
  }
  stats.poolEvaluated += evaluated;
  if (uniq.length < 3) return null;
  // 带兄弟抑制的贪心选取（打乱后顺序遍历）；凑不齐 3 个则放宽抑制，保证题量
  const shuffled = C.shuffle(uniq, rng);
  const chosen = [];
  for (const p of shuffled) {
    if (chosen.every((c) => !isSiblingPattern(c, p))) chosen.push(p);
    if (chosen.length >= 3) break;
  }
  if (chosen.length >= 3) return chosen;
  return C.sample(uniq, 3, rng);
}

// 兄弟条目噪声抑制：同一语法点的 ／ 变体拆成多条入库时（如「〜に基づいて」「〜に基づく」），
// 归一化后公共前缀 ≥ 较短者长度-1 视为兄弟，不作为同一题的多个干扰项。
// 仅作软约束：池子被抑制到凑不齐 3 个时自动放宽，绝不因此增加缺题。
function isSiblingPattern(a, b) {
  const x = C.normPat(a);
  const y = C.normPat(b);
  const min = Math.min(x.length, y.length);
  if (min < 3) return false;
  let p = 0;
  while (p < min && x[p] === y[p]) p++;
  return p >= min - 1;
}

// 挖空定位（四级）：
//   ① 候选形直接 indexOf → ② 形态交替扩展（敬体/活用形）→ ③ 助词宽松匹配（结尾后缀≥3）
//   → ④ 槽位片段（内部 〜/＋ 拆出的 ≥2 字符片段）
// 返回 { idx, len, mode, matched } 或 null。
function locateBlank(candidates, fragments, sentence) {
  for (const cand of candidates) {
    const idx = sentence.indexOf(cand);
    if (idx >= 0) return { idx, len: cand.length, mode: 'direct', matched: cand };
  }
  for (const cand of candidates) {
    for (const alt of C.surfaceAlternants(cand)) {
      const idx = sentence.indexOf(alt);
      if (idx >= 0) return { idx, len: alt.length, mode: 'morph', matched: alt };
    }
  }
  for (const cand of candidates) {
    const frag = C.looseMatchSegment(cand, sentence);
    if (frag) {
      const idx = sentence.indexOf(frag);
      if (idx >= 0) return { idx, len: frag.length, mode: 'loose', matched: frag };
    }
  }
  for (const frag of fragments) {
    const idx = sentence.indexOf(frag);
    if (idx >= 0) return { idx, len: frag.length, mode: 'fragment', matched: frag };
  }
  return null;
}

function renderReport(o) {
  const L = [];
  L.push('## 语境填空题（context）');
  L.push('');
  L.push(`- 生成时间：${o.time}`);
  L.push(`- 数据源：\`${o.input}\`（语法条目 ${o.totalItems} 条）`);
  L.push(`- 产出题数：**${o.questions} 道**（每语法点 1–2 道，两个例句各一）`);
  L.push(`- 四选项重复率：**${o.dupRate}**（重复题 ${o.dupCount} 道，应为 0）${o.dupCount === 0 ? '✅' : '❌'}`);
  L.push(`- 挖空定位：直接命中 ${o.directHits} 次；形态交替（敬体/活用）${o.morphHits} 次；助词宽松匹配 ${o.looseHits} 次；槽位片段 ${o.fragmentHits} 次`);
  L.push(`- 黑名单拦截：${o.blacklistHits} 次（命中率 ${o.blacklistRate}，拦截的候选干扰项不计入选项）`);
  L.push(`- 例句跳过统计：译文/例句缺失 ${o.exSkip.noSentence} 次；四级定位均未命中 ${o.exSkip.patternNotFound} 次；挖空后题干过短 ${o.exSkip.tooShort} 次；pos 异类干扰项不足 ${o.exSkip.distractorShort} 次`);
  L.push('');
  L.push('### 题量分布');
  L.push('');
  L.push(`0 道：${o.hist[0]} 条语法；1 道：${o.hist[1]} 条；2 道：${o.hist[2]} 条。`);
  L.push('');
  L.push('| 语法 | 级别 | 主题 | 题数 |');
  L.push('| --- | --- | --- | --- |');
  for (const row of o.perGrammar) L.push(`| ${row.pattern} | ${row.level} | ${row.pos} | ${row.count} |`);
  L.push('');
  L.push('### 缺题清单（题数 < 1，必须清零；剩余项逐条给出例句原文，需数据侧修复）');
  L.push('');
  if (!o.missing.length) L.push('无 ✅');
  else {
    L.push('| 语法 | 级别 | 主题 | 尝试过的候选形 | 例句1 | 例句2 |');
    L.push('| --- | --- | --- | --- | --- | --- |');
    const esc = (s) => String(s == null ? '' : s).replace(/\|/g, '｜');
    for (const m of o.missing) {
      L.push(`| ${esc(m.pattern)} | ${m.level} | ${m.pos} | ${esc(m.candidates.join(' / '))} | ${esc(m.examples[0])} | ${esc(m.examples[1])} |`);
    }
  }
  return L.join('\n');
}

function main() {
  const items = C.readJson(INPUT);
  if (!Array.isArray(items)) throw new Error(`输入必须是数组：${INPUT}`);

  const rng = C.mulberry32(SEED);
  const questions = [];
  const perCount = new Map();
  const missing = [];
  const exSkip = { noSentence: 0, patternNotFound: 0, tooShort: 0, distractorShort: 0 };
  const stats = { blacklistHits: 0, poolEvaluated: 0 };
  let directHits = 0;
  let morphHits = 0;
  let looseHits = 0;
  let fragmentHits = 0;

  for (const it of items) {
    if (!it || typeof it.pattern !== 'string' || !it.pattern.trim()) continue;
    const candidates = C.patternCandidates(it.pattern);
    const fragments = C.patternFragments(it.pattern);
    let made = 0;

    for (const [exKey, zhKey] of [['example1', 'example1_zh'], ['example2', 'example2_zh']]) {
      if (made >= 2) break;
      const sentence = typeof it[exKey] === 'string' ? it[exKey] : '';
      const zh = typeof it[zhKey] === 'string' ? it[zhKey] : '';
      if (!sentence.trim() || !zh.trim()) { exSkip.noSentence++; continue; }
      if (!candidates.length) { exSkip.patternNotFound++; continue; }

      const hit = locateBlank(candidates, fragments, sentence);
      if (!hit) { exSkip.patternNotFound++; continue; }
      if (hit.mode === 'direct') directHits++;
      else if (hit.mode === 'morph') morphHits++;
      else if (hit.mode === 'loose') looseHits++;
      else fragmentHits++;

      const qText = sentence.slice(0, hit.idx) + '＿＿＿' + sentence.slice(hit.idx + hit.len);
      if (qText.length < 6) { exSkip.tooShort++; continue; }
      const ds = pickDistractors(it, items, rng, stats);
      if (!ds) { exSkip.distractorShort++; continue; }
      const options = C.shuffle([it.pattern, ds[0], ds[1], ds[2]], rng);
      questions.push({
        grammar_pattern: it.pattern,
        type: 'context',
        question: qText,
        question_zh: zh,
        options,
        correct: options.indexOf(it.pattern),
        explanation: `句意为「${zh}」，此处应用 ${it.pattern}（${it.meaning || '该语法'}）。`,
        source: 'auto',
        reviewed: false,
        level: it.level != null ? it.level : null,
        theme: it.pos != null ? it.pos : null,
      });
      made++;
    }

    perCount.set(it.pattern, made);
    if (made === 0) {
      missing.push({
        pattern: it.pattern,
        level: it.level || '',
        pos: it.pos || '',
        candidates,
        examples: [it.example1 || '', it.example2 || ''],
      });
    }
  }

  // 防御性复查：四选项归一化后两两不同
  let dupCount = 0;
  const dupList = [];
  for (const q of questions) {
    const norms = q.options.map(C.normalizeOption);
    if (new Set(norms).size !== norms.length) { dupCount++; dupList.push(q.grammar_pattern); }
  }
  if (dupCount > 0) console.error(`警告：${dupCount} 道题四选项归一化后仍有重复：${dupList.join('、')}`);

  const outFull = C.writeJson(OUT, questions);

  const hist = [0, 0, 0];
  const perGrammar = items
    .filter((it) => it && typeof it.pattern === 'string' && it.pattern.trim())
    .map((it) => {
      const n = perCount.get(it.pattern) || 0;
      hist[Math.min(n, 2)]++;
      return { pattern: it.pattern, level: it.level || '', pos: it.pos || '', count: n };
    });
  perGrammar.sort((a, b) => a.count - b.count || a.pattern.localeCompare(b.pattern, 'zh-Hans-CN'));

  const report = renderReport({
    time: C.nowStr(),
    input: INPUT,
    totalItems: items.length,
    questions: questions.length,
    directHits,
    morphHits,
    looseHits,
    fragmentHits,
    dupCount,
    dupRate: C.pct(dupCount, questions.length),
    blacklistHits: stats.blacklistHits,
    blacklistRate: C.pct(stats.blacklistHits, stats.poolEvaluated),
    exSkip,
    hist,
    perGrammar,
    missing,
  });
  const reportFull = C.upsertReportSection(REPORT, 'context', report);

  console.log(report);
  console.log(`\n已写出 ${questions.length} 道题 → ${outFull}`);
  console.log(`报告已更新 → ${reportFull}`);
  console.log(`[summary] {"type":"context","total":${questions.length},"blacklist":${stats.blacklistHits},"dup":${dupCount},"missing":${missing.length},"loose":${looseHits},"morph":${morphHits},"fragment":${fragmentHits}}`);
}

try {
  main();
} catch (e) {
  console.error(`生成失败：${e.message}`);
  process.exit(1);
}
