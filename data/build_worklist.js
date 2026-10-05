// Build the LLM worklist v2 — rowids, multi-group merge/split handling
const fs = require('fs');
const groups = JSON.parse(fs.readFileSync('merge_groups.json', 'utf8'));

const WORDS = [
  [/causative-passive form/g, '使役受身形'], [/causative form/g, '使役形'], [/passive form/g, '受身形'],
  [/potential form/g, '可能形'], [/volitional form/g, '意向形'], [/dictionary form/g, '辞書形'],
  [/plain( non-past)? form/g, '普通形'], [/direct form/g, '普通形'], [/negative stem/g, 'ない形語幹'],
  [/nai-form/g, 'ない形'], [/ない-form/g, 'ない形'], [/te-form/g, 'て形'], [/ta-form/g, 'た形'],
  [/ba-form/g, 'ば形'], [/masu-stem/g, 'ます形語幹'], [/verb stem/g, '動詞語幹'],
  [/transitive verb/g, '他動詞'], [/intransitive verb/g, '自動詞'], [/quoted phrase/g, '引用文'],
  [/number \+ counter/g, '数字＋助数詞'], [/i-adjective/g, 'い形容詞'], [/na-adjective/g, 'な形容詞'],
  [/na-adj root/g, 'な形容詞語幹'], [/i-adj stem/g, 'い形容詞語幹'], [/na-adj\b/g, 'な形容詞'], [/i-adj\b/g, 'い形容詞'],
  [/\bverb\b/gi, '動詞'], [/\bV\b/g, '動詞'], [/\bnoun\b/gi, '名詞'], [/\bsentence\b/gi, '文'],
  [/\bphrase\b/gi, '文節'], [/\bnumber\b/gi, '数字'], [/\bcounter\b/gi, '助数詞'], [/\bstem\b/gi, '語幹'],
];
function jpFormation(en) {
  if (!en) return null;
  let t = en.trim().replace(/\.$/, '');
  WORDS.forEach(([re, rep]) => { t = t.replace(re, rep); });
  return t;
}

// groups where multiple same-key entries are ONE grammar point (merge into a single row)
const MERGE_KEYS = new Set(['こそ', 'のみならず', 'わけにはいかない', 'ても', 'verb→passiveform', 'です', 'でした', 'ではありません', 'から', 'verb)', 'くらい', 'っぽい', 'わけがない', 'たら', 'だけ', 'ものだ', 'ことがある', 'ために', 'そう(だ', 'が', 'も', 'と']);

function dedupeRb(rbList) {
  const seen = new Set();
  return rbList.filter(r => {
    const sig = r.pattern + '@' + r.lesson;
    if (seen.has(sig)) return false;
    seen.add(sig); return true;
  });
}

const rows = [];
for (const g of groups) {
  const jks = g.jk, rbs = dedupeRb(g.rb);
  const merge = MERGE_KEYS.has(g.key) && (jks.length + rbs.length) > 2;

  if (merge) {
    // combine all entries into one row
    const jkPrimary = jks[0];
    const rbPrimary = rbs.find(r => r.meaning && r.examples.length) || rbs[0] || null;
    const rbExtra = rbs.filter(r => r !== rbPrimary);
    rows.push(makeRow({
      rowid: 'g:' + g.key,
      key: g.key, jks, rbs, jkPrimary, rbPrimary, rbExtra,
    }));
  } else if (jks.length === 1 && rbs.length === 1) {
    rows.push(makeRow({ rowid: 'g:' + g.key, key: g.key, jks, rbs, jkPrimary: jks[0], rbPrimary: rbs[0], rbExtra: [] }));
  } else {
    // split: one row per jk entry; rb entries as separate rows (LLM will merge via action)
    for (const j of jks) {
      rows.push(makeRow({ rowid: 'jk:' + j.id, key: g.key, jks: [j], rbs: [], jkPrimary: j, rbPrimary: null, rbExtra: [] }));
    }
    for (const r of rbs) {
      rows.push(makeRow({ rowid: 'rb:' + g.key + ':' + r.lesson + ':' + rbs.indexOf(r), key: g.key, jks: [], rbs: [r], jkPrimary: null, rbPrimary: r, rbExtra: [] }));
    }
    if (!jks.length && !rbs.length) console.log('EMPTY GROUP', g.key);
  }
}

function makeRow({ rowid, key, jks, rbs, jkPrimary, rbPrimary, rbExtra }) {
  const jk = jkPrimary;
  const rb = rbPrimary;
  let level = jk ? jk.level : rb.level;
  let type;
  if (rb && rb.meaning && rb.examples.length) type = 'A';
  else if (rb && rb.meaning) type = 'B-mean';
  else if (rb) type = 'C-rb';
  else type = 'C-jk';

  // examples: prefer rb (zh), else jk (en)
  let examples;
  if (rb && rb.examples.length) examples = rb.examples.map(x => ({ ja: x.ja, zh: x.zh, en: null }));
  else if (jk) examples = jk.examples.slice(0, 3).map(x => ({ ja: x.ja, zh: null, en: x.en }));
  else examples = [];

  // join rb extra continuations
  let conts = [];
  if (rb && rb.continuation) conts.push(rb.continuation);
  (rbExtra || []).forEach(x => { if (x.continuation) conts.push(x.continuation); });
  if (jk && jks.length > 1) jks.forEach(x => { const f = jpFormation(x.formation); if (f) conts.push(f); });

  return {
    rowid, type, key, level,
    pattern_jk: jks.length ? jks.map(x => x.pattern).join(' ／ ') : null,
    pattern_rb: rb ? rb.pattern : null,
    shortZh: rb ? rb.shortZh : null,
    meaning_en: jk ? jk.meaning_en : null,
    meaning_detail: jk ? (jk.meaning_detailed || null) : null,
    meaning_rb: rb && rb.meaning ? rb.meaning : null,
    continuation_opts: [...new Set(conts)],
    continuation_jp: jk ? jpFormation(jk.formation) : null,
    examples,
    lessonCat: rb ? (rb.file.match(/lesson\d+_([^_]+)_/) || [])[1] || '' : '',
    formality: jk ? jk.formality : null,
    nJk: jks.length, nRb: rbs.length,
  };
}

const lvOrder = { N5: 0, N4: 1, N3: 2, N2: 3 };
rows.sort((a, b) => (lvOrder[a.level] - lvOrder[b.level]) || a.type.localeCompare(b.type) || a.key.localeCompare(b.key));
fs.writeFileSync('worklist.json', JSON.stringify(rows, null, 1));
const byType = {}, byLv = {};
rows.forEach(r => { byType[r.type] = (byType[r.type] || 0) + 1; byLv[r.level] = (byLv[r.level] || 0) + 1; });
console.log('rows:', rows.length, byType, byLv);
