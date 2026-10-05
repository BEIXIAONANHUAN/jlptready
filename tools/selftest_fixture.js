#!/usr/bin/env node
/**
 * selftest_fixture.js — 题库生成/导入脚本的 fixture 自测
 *
 * 用法：node tools/selftest_fixture.js
 * 全程只用 data/_fixture*.json 与临时文件，不碰 data/grammar_clean.json、不写库。
 * 退出码 0 = 全部断言通过；1 = 有失败项。
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const C = require('./lib/common');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  PASS  ${msg}`); }
  else { fail++; console.log(`  FAIL  ${msg}`); }
}
function run(args) {
  try {
    const stdout = execFileSync('node', args, { cwd: C.ROOT, encoding: 'utf8' });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}
function summary(stdout) {
  const m = stdout.match(/\[summary\] (\{.*\})/);
  return m ? JSON.parse(m[1]) : null;
}

const fixture = C.readJson('data/_fixture.json');
const fixByPattern = new Map(fixture.map((f) => [f.pattern, f]));
const WHOLE_MODE = ['～だろう', '～ちゃう', '～じゃない']; // continuation 无「＋」，走整串模式

// ---------- 0. 语法检查 ----------
console.log('== 0. node --check 全部脚本 ==');
for (const f of ['tools/lib/common.js', 'tools/lib/supabase.js', 'tools/gen_continuation.js', 'tools/gen_context.js', 'tools/import_questions.js', 'tools/import_manual150.js']) {
  const r = run(['--check', f]);
  ok(r.code === 0, `${f} 语法通过`);
}

// ---------- 0.5 候选形与宽松匹配（单元级） ----------
console.log('\n== 0.5 patternCandidates / surfaceAlternants / patternFragments ==');
ok(JSON.stringify(C.patternCandidates('〜において / 〜における')) === JSON.stringify(['において', 'における']), '变体按「／」「/」拆分');
ok(JSON.stringify(C.patternCandidates('ならでは（の）')) === JSON.stringify(['ならではの', 'ならでは']), '全角可选括号：先试保留内容再试整段删除');
ok(JSON.stringify(C.patternCandidates('〜とおり(に)')) === JSON.stringify(['とおりに', 'とおり']), '半角可选括号同样处理');
ok(JSON.stringify(C.patternCandidates('〜中（ちゅう／じゅう）')) === JSON.stringify(['中ちゅう', '中じゅう', '中']), '括号内「／」笛卡尔展开，省略形殿后');
ok(C.looseMatchSegment('しかたがない', 'これはしょうがない') === 'がない', '宽松匹配：后缀 ≥3 命中（がない）');
ok(C.looseMatchSegment('にもかかわらず', '彼は病気なのにかかわらず働いている') === 'かかわらず', '宽松匹配：中取最长可用后缀');
ok(C.looseMatchSegment('ちゃう', '食べちゃった') === null, '宽松匹配：<3 字符不命中');
ok(C.surfaceAlternants('ている').includes('ています') && C.surfaceAlternants('ている').includes('ていません'), '形态交替：ている→ています/ていません');
ok(C.surfaceAlternants('終わる').includes('終わりました') && C.surfaceAlternants('終わる').includes('終わった'), '形态交替：五段 終わる→終わりました/終わった');
ok(C.surfaceAlternants('食べる').includes('食べました') && C.surfaceAlternants('食べる').includes('食べた'), '形态交替：一段 食べる→食べました/食べた');
ok(C.surfaceAlternants('予定だ').includes('予定です') && C.surfaceAlternants('予定だ').includes('予定だった'), '形态交替：予定だ→予定です/予定だった');
ok(C.surfaceAlternants('読む').includes('読みました') && C.surfaceAlternants('読む').includes('読んだ'), '形态交替：読む→読みました/読んだ');
ok(C.surfaceAlternants('だのに').includes('なのに'), '形态交替：だのに↔なのに');
ok(C.surfaceAlternants('する').includes('した') && C.surfaceAlternants('勉強する').includes('勉強した'), '形态交替：する 不规则');
ok(JSON.stringify(C.patternFragments('もう＋動詞た形')) === JSON.stringify(['動詞た形', 'もう']), '槽位片段：按 ＋ 拆、长度降序');
ok(JSON.stringify(C.patternFragments('〜ば〜ほど')) === JSON.stringify(['ほど']), '槽位片段：〜ば〜ほど → ほど（ば 仅 1 字符剔除）');

// ---------- 1. 接续题生成（主 fixture） ----------
console.log('\n== 1. gen_continuation.js（主 fixture） ==');
let r = run(['tools/gen_continuation.js', '--input', 'data/_fixture.json', '--out', 'data/_fixture_q_cont.json', '--report', 'data/_fixture_report.md']);
if (r.code !== 0) console.log(r.stderr);
ok(r.code === 0, '脚本无报错退出');
const cont = C.readJson('data/_fixture_q_cont.json');
const s1 = summary(r.stdout);
const EXPECT_CONT = (fixture.length - 1) * 3; // 除 ～ずつ（无 continuation）外每语法 3 道
ok(s1 && s1.total === EXPECT_CONT, `接续题总数 = ${s1 && s1.total}（期望 ${EXPECT_CONT} = 16 条可出 × 3）`);
ok(s1 && s1.dup === 0, '四选项重复率 = 0');
ok(s1 && s1.fallback === 0, '主 fixture 无兜底题（干扰项充足）');
ok(s1 && s1.whole === WHOLE_MODE.length * 3, `整串模式题 = ${s1 && s1.whole}（期望 9 = 3 条 × 3）`);

let badShape = 0, badDup = 0, badCorrect = 0, badContract = 0, badWhole = 0;
const contCount = new Map();
for (const q of cont) {
  contCount.set(q.grammar_pattern, (contCount.get(q.grammar_pattern) || 0) + 1);
  if (!Array.isArray(q.options) || q.options.length !== 4) badShape++;
  const norms = q.options.map(C.normalizeOption);
  if (new Set(norms).size !== 4) badDup++;
  const src = fixByPattern.get(q.grammar_pattern);
  if (!src || norms[q.correct] !== C.normalizeOption(src.continuation)) badCorrect++;
  if (WHOLE_MODE.includes(q.grammar_pattern) && q.options[q.correct] !== src.continuation.trim()) badWhole++;
  if (!(q.type === 'continuation' && q.question === `「${q.grammar_pattern}」的正确接续是？`)) badContract++;
  if (!(q.reviewed === false && q.source === 'auto' && q.question_zh === null)) badContract++;
  if (!(typeof q.explanation === 'string' && q.explanation.includes(q.grammar_pattern))) badContract++;
  if (!(q.level && q.theme)) badContract++;
}
ok(badShape === 0, '所有题 options 均为 4 项');
ok(badDup === 0, '约束：四选项归一化后两两不同');
ok(badCorrect === 0, '约束：correct 索引指向该条目 continuation（重组与整串模式都校验）');
ok(badWhole === 0, '整串模式正确项 = continuation 整串原文');
ok(badContract === 0, '输出契约字段（type/question/reviewed/source/question_zh/explanation/level/theme）齐全');
ok((contCount.get('～ずつ') || 0) === 0, '无 continuation 的条目未出题');
ok([...contCount.entries()].every(([p, n]) => p === '～ずつ' || n === 3), '每个可出条目恰好 3 道');

const reportText = fs.readFileSync(C.resolveRoot('data/_fixture_report.md'), 'utf8');
ok(reportText.includes('～ずつ') && reportText.includes('需数据侧补'), '缺题清单：无 continuation 条目原因=需数据侧补');
ok(reportText.includes('整串模式'), '报告含整串模式统计');

// ---------- 2. 接续题兜底（tiny fixture：全部同左部，正常干扰凑不齐） ----------
console.log('\n== 2. gen_continuation.js（tiny fixture → 兜底路径） ==');
r = run(['tools/gen_continuation.js', '--input', 'data/_fixture_tiny.json', '--out', 'data/_fixture_tiny_q.json', '--report', 'data/_fixture_report.md']);
ok(r.code === 0, '脚本无报错退出');
const tiny = C.readJson('data/_fixture_tiny_q.json');
const s2 = summary(r.stdout);
ok(s2 && s2.total === 12, `tiny fixture 题数 = ${s2 && s2.total}（期望 12 = 4 × 3）`);
ok(s2 && s2.fallback === 12, `兜底题 = ${s2 && s2.fallback}（期望全部 12 道兜底）`);
ok(tiny.every((q) => q.reviewed === false), '兜底题 reviewed=false（人工抽查队列）');
let tinyOk = true;
for (const q of tiny) {
  const contExpected = `名詞＋${C.stripWave(q.grammar_pattern)}（${q.grammar_pattern}）`;
  const norms = q.options.map(C.normalizeOption);
  if (new Set(norms).size !== 4) tinyOk = false;
  if (norms[q.correct] !== C.normalizeOption(contExpected)) tinyOk = false;
}
ok(tinyOk, '兜底题选项为「接续（pattern）」形式且 correct 指向本条目');

// ---------- 3. 语境题生成（主 fixture） ----------
console.log('\n== 3. gen_context.js（主 fixture） ==');
r = run(['tools/gen_context.js', '--input', 'data/_fixture.json', '--out', 'data/_fixture_q_ctx.json', '--report', 'data/_fixture_report.md']);
ok(r.code === 0, '脚本无报错退出');
const ctx = C.readJson('data/_fixture_q_ctx.json');
const s3 = summary(r.stdout);
ok(s3 && s3.total === 33, `语境题总数 = ${s3 && s3.total}（期望 33）`);
ok(s3 && s3.blacklist === 4, `黑名单拦截 = ${s3 && s3.blacklist}（期望 4：ために↔ように 两向 × 各 2 条例句）`);
ok(s3 && s3.missing === 1, `缺题语法 = ${s3 && s3.missing}（期望 1：～からといって 两个例句都不含 pattern）`);
ok(s3 && s3.loose === 1, `宽松匹配命中 = ${s3 && s3.loose}（期望 1：にもかかわらず 的 example2）`);
ok(s3 && s3.morph === 2, `形态交替命中 = ${s3 && s3.morph}（期望 2：てあります、ちゃった）`);
ok(s3 && s3.fragment === 1, `槽位片段命中 = ${s3 && s3.fragment}（期望 1：ば～ほど 的「ほど」）`);

let ctxBad = 0, ctxPosBad = 0, ctxBlBad = 0;
const ctxCount = new Map();
for (const q of ctx) {
  ctxCount.set(q.grammar_pattern, (ctxCount.get(q.grammar_pattern) || 0) + 1);
  const src = fixByPattern.get(q.grammar_pattern);
  const norms = q.options.map(C.normalizeOption);
  if (new Set(norms).size !== 4) ctxBad++;
  if (q.options[q.correct] !== q.grammar_pattern) ctxBad++;
  if (!q.question.includes('＿＿＿') || q.question.length < 6) ctxBad++;
  if (!q.question_zh || !src) ctxBad++;
  else if (q.question_zh !== src.example1_zh && q.question_zh !== src.example2_zh) ctxBad++;
  for (const d of q.options) {
    if (d === q.grammar_pattern) continue;
    const o = fixByPattern.get(d);
    if (!o || o.pos === src.pos) ctxPosBad++;
    if (o && isBL(d, q.grammar_pattern)) ctxBlBad++;
  }
}
ok(ctxBad === 0, '语境题契约：挖空/长度/译文/选项唯一/correct 指向原 pattern');
ok(ctxPosBad === 0, '约束2：所有干扰项 pos 与正确项不同（含同 pos ので/から、ば/たら 被排除）');
ok(ctxBlBad === 0, '约束3：选项中无黑名单可互换对');
ok((ctxCount.get('～のみならず') || 0) === 1, '无 example2 的条目只出 1 道（example1 成功即止）');
ok((ctxCount.get('～うえで') || 0) === 1, 'example1 未命中时用 example2 出 1 道');
ok((ctxCount.get('～からといって') || 0) === 0, '两个例句都不含 pattern 的条目 0 道并进缺题清单');
ok((ctxCount.get('～ちゃう') || 0) === 2, '形态交替救回 example1：ちゃう→ちゃった → 2 道');

// 变体拆分与括号形态：挖空只挖命中的那段文本
function ctxQ(pattern, zh) { return ctx.find((q) => q.grammar_pattern === pattern && q.question_zh === zh); }
ok(ctxQ('～しょうがない／しかたがない', '这已经没办法了。').question === 'これはもう＿＿＿。', '变体1：example1 命中「しょうがない」');
ok(ctxQ('～しょうがない／しかたがない', '只能放弃了。').question === '諦める＿＿＿。', '变体2：example2 命中「しかたがない」');
ok(ctxQ('～ならでは（の）', '这正是日本独有的风景。').question === 'これぞ日本＿＿＿風景だ。', '全角括号：先命中带内容形「ならではの」');
ok(ctxQ('～ならでは（の）', '这项技术是工匠独有的。').question === 'この技術は職人＿＿＿だ。', '全角括号：example2 命中删括号形「ならでは」');
ok(ctxQ('～にもかかわらず', '他尽管生病仍在工作。').question === '彼は病気なのに＿＿＿働いている。', '助词宽松匹配：挖候选形结尾后缀「かかわらず」（に 留在句中）');
ok(ctxQ('～てある', '窗户事先开好了。').question === '窓が開け＿＿＿。', '形态交替：てある→てあります，挖交替面');
ok(ctxQ('～ば～ほど', '越练习越熟练。').question === '練習すればする＿＿＿上手になる。', '槽位片段：挖「ほど」（～ば～ほど 整形未命中）');

const ctxReport = fs.readFileSync(C.resolveRoot('data/_fixture_report.md'), 'utf8');
ok(ctxReport.includes('～からといって') && ctxReport.includes('未命中'), '报告缺题清单逐条给出候选形与例句原文');

function isBL(a, b) { // 与 gen_context.js 同源的黑名单判断（复制常量）
  return genBL().has([C.normPat(a), C.normPat(b)].sort().join('|'));
}
function genBL() {
  if (genBL._set) return genBL._set;
  const pairs = [['ので', 'から'], ['ように', 'ために'], ['だけでなく', 'のみならず'], ['ば', 'たら'], ['までに', 'まで'], ['うちに', 'あいだ']];
  genBL._set = new Set(pairs.map(([a, b]) => [C.normPat(a), C.normPat(b)].sort().join('|')));
  return genBL._set;
}

// ---------- 4. import_manual150.js ----------
console.log('\n== 4. import_manual150.js ==');
r = run(['tools/import_manual150.js']);
ok(r.code === 1 && r.stderr.includes('未找到数据文件'), '数据文件缺失时明确报错退出（exit 1）');

const sample = {
  meta: {
    title: '自测样例',
    field_mapping: { grammar_pattern: '语法点', question: '题干', question_zh: '题干中文', options: '选项', correct: '答案', explanation: '解析', level: '级别', theme: '主题', bloom_level: 'bloom', difficulty: '难度' },
  },
  questions: [
    { 语法点: '～ばかりか', 题干: '「名詞＋ばかりか」与「動詞辞書形＋だけ」的区别？', 题干中文: null, 选项: ['接続詞', '助詞', '副詞', '助動詞'], 答案: 'B', 解析: 'ばかりか 是并列助词。', 级别: 'N2', 主题: '递进并列', bloom: '应用', 难度: '中' },
    { 语法点: '～だけ', 题干: 'だけ 的辨析', 选项: ['a', 'b', 'c', 'd'], 答案: 3, 解析: 'だけ 表限定。', 级别: 'N2', 主题: '限定', bloom: '理解', 难度: '易' },
  ],
};
C.writeJson('data/_manual_sample.json', sample);
r = run(['tools/import_manual150.js', '--input', 'data/_manual_sample.json']);
ok(r.code === 0 && r.stdout.includes('题目总数：2') && r.stdout.includes('[dry-run]'), 'dry-run：解析成功且未写文件');
ok(!fs.existsSync(C.resolveRoot('data/questions_similar.json')), 'dry-run 不生成正式产物');
r = run(['tools/import_manual150.js', '--input', 'data/_manual_sample.json', '--run', '--out', 'data/_manual_sample_out.json']);
ok(r.code === 0 && fs.existsSync(C.resolveRoot('data/_manual_sample_out.json')), '--run 写出 questions_similar 契约文件');
const sim = C.readJson('data/_manual_sample_out.json');
ok(sim.length === 2, '转换 2 题');
ok(sim.every((q) => q.type === 'similar' && q.source === 'manual' && q.reviewed === true), '每题 source=manual、reviewed=true、type=similar');
ok(sim[0].correct === 1 && sim[1].correct === 3, 'correct 兼容字母（B→1）与数字索引');
ok(sim[0].question_zh === null && sim[0].level === 'N2' && sim[0].theme === '递进并列' && sim[0].bloom_level === '应用' && sim[0].difficulty === '中', 'level/theme/bloom_level/difficulty 原样保留，question_zh 缺省为 null');

const sampleB = {
  meta: { field_mapping: { 语法点: 'grammar_pattern', 题干: 'question', 选项: 'options', 答案: 'correct', 解析: 'explanation' } },
  questions: [{ 语法点: '～X', 题干: 'q', 选项: ['1', '2', '3', '4'], 答案: 'A', 解析: 'e' }],
};
C.writeJson('data/_manual_sample_b.json', sampleB);
r = run(['tools/import_manual150.js', '--input', 'data/_manual_sample_b.json']);
ok(r.code === 0 && r.stdout.includes('题目总数：1'), 'field_mapping 反向（源字段名→规范名）也能识别');

// ---------- 5. import_questions.js（dry-run，无网络部分） ----------
console.log('\n== 5. import_questions.js / config 提取 ==');
const SB = require('./lib/supabase');
const cfg = SB.loadConfig();
ok(/^https:\/\/.+\.supabase\.co$/.test(cfg.url) && cfg.key.length > 20, '从 js/config.js 正则提取 SUPABASE_URL / ANON_KEY');
fs.mkdirSync(C.resolveRoot('data/_empty_dir'), { recursive: true });
r = run(['tools/import_questions.js', '--data-dir', 'data/_empty_dir']);
ok(r.code === 0 && r.stdout.includes('不存在或为空'), '题库 JSON 全缺时友好退出（不触碰网络）');
fs.rmdirSync(C.resolveRoot('data/_empty_dir'));

// ---------- 清理临时产物 ----------
for (const f of ['data/_fixture_q_cont.json', 'data/_fixture_q_ctx.json', 'data/_fixture_tiny_q.json', 'data/_fixture_report.md', 'data/_manual_sample.json', 'data/_manual_sample_b.json', 'data/_manual_sample_out.json']) {
  try { fs.unlinkSync(C.resolveRoot(f)); } catch (e) { /* 忽略 */ }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
