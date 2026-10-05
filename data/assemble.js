// Final assembly: worklist + out_NN decisions + AI supplements -> grammar_clean.json
const fs = require('fs');

const THEME_NAMES = { 1: '时间先后', 2: '原因理由', 3: '条件假设', 4: '目的意图', 5: '形式体言', 6: '比较对比', 7: '程度变化', 8: '让步转折', 9: '递进并列', 10: '推测判断', 11: '命令禁止', 12: '感叹强调', 13: '敬语体系', 14: '被动使役', 15: '传闻引用', 16: '其他/杂项' };

function stripReadingParens(s) {
  if (!s) return s;
  // remove parens that contain only kana/ー/っ (reading annotations)
  let t = s.replace(/（[ぁ-んァ-ヶーっゝ]+）/g, '').replace(/\([ぁ-んァ-ヶーっゝ]+\)/g, '');
  return t.replace(/ {2,}/g, ' ').trim();
}
function canon(s) {
  return (s || '').replace(/（[^（）]*）/g, '').replace(/\([^()]*\)/g, '').replace(/[〜～・･\s]/g, '').replace(/^[～〜]+/, '').toLowerCase();
}

// load
const worklist = JSON.parse(fs.readFileSync('worklist.json', 'utf8'));
const byRow = {};
worklist.forEach(r => byRow[r.rowid] = r);
const outs = {};
for (let i = 1; i <= 10; i++) {
  JSON.parse(fs.readFileSync('translations/out_' + String(i).padStart(2, '0') + '.json', 'utf8')).forEach(o => outs[o.rowid] = o);
}
// fixes override earlier decisions
JSON.parse(fs.readFileSync('translations/out_fixes.json', 'utf8')).forEach(o => {
  if (o._drop) { outs[o.rowid] = Object.assign({}, outs[o.rowid], { action: 'drop' }); }
  else outs[o.rowid] = Object.assign({}, outs[o.rowid], o);
});
const aiDrops = new Set(JSON.parse(fs.readFileSync('translations/ai_drops.json', 'utf8')).map(d => d.rowid));
['ai:111','ai:126','ai:129','ai:319','ai:320','ai:321','ai:323','ai:325','ai:326','ai:327','ai:329','ai:330','ai:331','ai:332','ai:333','ai:131'].forEach(x => aiDrops.add(x));
const aiExtraDrops = new Set(['ai:319','ai:320','ai:321','ai:323','ai:325','ai:326','ai:327','ai:329','ai:330','ai:331','ai:332','ai:333']);
let ai = [];
['ai_01', 'ai_02', 'ai_03', 'ai_04', 'ai_05'].forEach(f => {
  ai = ai.concat(JSON.parse(fs.readFileSync('translations/' + f + '.json', 'utf8')));
});
ai = ai.filter(o => !aiDrops.has(o.rowid));

// ---------- build entries from rows ----------
let errors = [];
const mergedAway = [];
const entries = [];
const sourceStats = { aiMeaning: 0, aiExZh: 0, aiExamplesComposed: 0, rbMeaning: 0, jkMeaning: 0 };

function buildRow(row, o) {
  const r = byRow[row.rowid];
  let pattern = o.pattern || r.pattern_rb || r.pattern_jk;
  if (!pattern) errors.push('NO PATTERN: ' + row.rowid);
  let meaning = o.meaning_zh || r.meaning_rb || r.shortZh || r.meaning_en;
  if (o.meaning_zh) sourceStats.aiMeaning++;
  else if (r.meaning_rb) sourceStats.rbMeaning++;
  else if (r.meaning_en) sourceStats.jkMeaning++;
  if (!meaning) errors.push('NO MEANING: ' + row.rowid);
  meaning = stripReadingParens(meaning);

  // examples
  let ex1ja = o.ex1_ja || (r.examples[0] && r.examples[0].ja) || null;
  let ex1zh = o.ex1_zh || (r.examples[0] && r.examples[0].zh) || null;
  let ex2ja = o.ex2_ja || (r.examples[1] && r.examples[1].ja) || null;
  let ex2zh = o.ex2_zh || (r.examples[1] && r.examples[1].zh) || null;
  if (o.ex1_zh) sourceStats.aiExZh++;
  if (o.ex2_zh) sourceStats.aiExZh++;
  if ((o.ex1_ja || o.ex2_ja) && !(r.examples[0] && r.examples[0].zh)) sourceStats.aiExamplesComposed++;
  if (!ex1ja || !ex1zh) errors.push('NO EX1: ' + row.rowid + ' ja=' + !!ex1ja + ' zh=' + !!ex1zh);
  if (ex2ja && !ex2zh) errors.push('NO EX2ZH: ' + row.rowid);
  if (!ex2ja) { ex2ja = null; ex2zh = null; }

  let cont = o.continuation || (r.continuation_opts && r.continuation_opts[0]) || r.continuation_jp || null;
  cont = stripReadingParens(cont);

  let level = o.level || r.level;
  if (!['N5', 'N4', 'N3', 'N2'].includes(level)) errors.push('BAD LEVEL: ' + row.rowid + ' ' + level);
  if (!o.theme_order || !THEME_NAMES[o.theme_order]) errors.push('NO THEME: ' + row.rowid);
  if (o.pos !== THEME_NAMES[o.theme_order]) errors.push('POS/THEME MISMATCH: ' + row.rowid);

  return {
    pattern: pattern.trim(),
    meaning: meaning,
    continuation: cont,
    example1: ex1ja, example1_zh: ex1zh,
    example2: ex2ja, example2_zh: ex2zh,
    level, pos: o.pos, theme_order: o.theme_order, frequency: 0,
    _src: r.nJk ? (r.nRb ? 'both' : 'jk') : 'rb', _rowid: row.rowid
  };
}

const built = {};
for (const row of worklist) {
  const o = outs[row.rowid];
  if (!o) { errors.push('NO OUT: ' + row.rowid); continue; }
  if (o.action === 'drop') { mergedAway.push(row.rowid); continue; }
  if ((o.action || '').startsWith('mergeinto:')) { mergedAway.push(row.rowid); continue; }
  built[row.rowid] = buildRow(row, o);
}

// apply merges (source -> target, fill missing fields)
for (const row of worklist) {
  const o = outs[row.rowid];
  if (!o || !o.action || !o.action.startsWith('mergeinto:')) continue;
  const t = built[o.action.slice(10)];
  if (!t) { errors.push('MERGE TARGET MISSING: ' + row.rowid + ' -> ' + o.action); continue; }
  const before = errors.length;
  const s = buildRow(row, o);
  errors.length = before; // source-level gaps are fine; only target matters
  if (!t.meaning && s.meaning) t.meaning = s.meaning;
  if (!t.example1) { t.example1 = s.example1; t.example1_zh = s.example1_zh; t.example2 = s.example2; t.example2_zh = s.example2_zh; }
  if (!t.continuation && s.continuation) t.continuation = s.continuation;
}
Object.values(built).forEach(e => entries.push(e));

// ---------- AI entries ----------
const aiCount = ai.length;
ai.forEach(o => {
  if (!o.pattern || !o.meaning_zh || !o.example1 || !o.example1_zh) errors.push('AI INCOMPLETE: ' + o.rowid);
  if (o.example2 && !o.example2_zh) errors.push('AI EX2 no zh: ' + o.rowid);
  if (o.pos !== THEME_NAMES[o.theme_order]) errors.push('AI POS MISMATCH: ' + o.rowid);
  entries.push({
    pattern: o.pattern.trim(), meaning: stripReadingParens(o.meaning_zh), continuation: o.continuation || null,
    example1: o.example1, example1_zh: o.example1_zh,
    example2: o.example2 || null, example2_zh: o.example2_zh || null,
    level: o.level, pos: o.pos, theme_order: o.theme_order, frequency: 0, _src: 'ai', _rowid: o.rowid
  });
});

// ---------- dedup check ----------
const seen = {};
const dups = [];
entries.forEach(e => {
  const k = canon(e.pattern);
  if (seen[k]) dups.push([seen[k], e._rowid, e.pattern]);
  else seen[k] = e._rowid;
});
if (dups.length) console.log('DUPS:', dups);

// ---------- sort & write ----------
const lv = { N5: 0, N4: 1, N3: 2, N2: 3 };
entries.sort((a, b) => (a.theme_order - b.theme_order) || (lv[a.level] - lv[b.level]) || a.pattern.localeCompare(b.pattern, 'ja'));
const final = entries.map(e => {
  const { pattern, meaning, continuation, example1, example1_zh, example2, example2_zh, level, pos, theme_order, frequency } = e;
  return { pattern, meaning, continuation, example1, example1_zh, example2, example2_zh, level, pos, theme_order, frequency };
});
fs.writeFileSync('grammar_clean.json', JSON.stringify(final, null, 1));
console.log('ERRORS:', errors.length);
errors.slice(0, 40).forEach(e => console.log(' ', e));
console.log('final entries:', final.length, '| ai:', aiCount, '| merged away:', mergedAway.length);
const byLv = {}, byTh = {};
final.forEach(e => { byLv[e.level] = (byLv[e.level] || 0) + 1; byTh[e.theme_order] = (byTh[e.theme_order] || 0) + 1; });
console.log('by level:', byLv);
console.log('by theme:', byTh);
console.log('stats:', sourceStats);
fs.writeFileSync('assemble_debug.json', JSON.stringify({ errors, dups, mergedAway, stats: { byLv, byTh, total: final.length, ai: aiCount, merged: mergedAway.length, sourceStats } }, null, 1));
