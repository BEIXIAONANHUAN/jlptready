// Merge jkindrix + Ralphbupt grammar entries by canonical pattern keys (v2)
const fs = require('fs');

function halfWidth(s) {
  return s.replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/･/g, '・').replace(/　/g, ' ');
}
function normalizePattern(s) {
  return halfWidth(s).trim().replace(/\s+/g, ' ');
}
function canonKey(s) {
  let t = halfWidth(s).toLowerCase();
  t = t.replace(/（[^（）]*）/g, '').replace(/\([^()]*\)/g, ''); // drop parenthetical content
  t = t.replace(/[〜～・･\s]/g, '');
  t = t.replace(/[。．.、，,;:；：!！?？'"「」\[\]]/g, '');
  return t;
}
function firstVariant(s) {
  return s.split('/')[0].trim();
}

// ---------- load jkindrix ----------
const jk = JSON.parse(fs.readFileSync('grammar_raw1.json', 'utf8')).grammar_points
  .filter(e => e.level !== 'N1')
  .map(e => {
    const pattern = normalizePattern(e.pattern);
    const parts = pattern.split('+').map(x => x.trim()).filter(Boolean);
    const last = parts.length ? parts[parts.length - 1] : pattern;
    const keys = [canonKey(firstVariant(last))];
    const full = canonKey(last);
    if (full !== keys[0]) keys.push(full);
    if (parts.length >= 2) {
      const pen = parts[parts.length - 2];
      const carrier = firstVariant(pen);
      if (!/ます|stem|意向|volitional|可能|potential|てみる|しまう|おく|ある$/.test(carrier)) {
        const m = carrier.match(/([ぁ-んァ-ヶ]+)\s*[-‐‑‒–—]?\s*(?:form|stem)?\s*$/);
        if (m && m[1].length <= 3) {
          const k = canonKey(m[1] + firstVariant(last));
          if (!keys.includes(k)) keys.push(k);
        }
      }
    }
    return {
      source: 'jkindrix', id: e.id, level: e.level, pattern,
      meaning_en: e.meaning_en, meaning_detailed: e.meaning_detailed,
      formation: e.formation, formality: e.formality,
      examples: e.examples.map(x => ({ ja: x.japanese, en: x.english })),
      keys,
    };
  });

// ---------- load ralphbupt ----------
const rb = JSON.parse(fs.readFileSync('rb_entries.json', 'utf8'))
  .map(e => ({
    source: 'ralphbupt', level: e.level, lesson: e.lesson, file: e.file,
    pattern: normalizePattern(e.pattern), shortZh: e.shortZh,
    continuation: e.continuation, meaning: e.meaning,
    examples: e.examples,
    key: canonKey(firstVariant(e.pattern)),
  }));

// hand-curated aliases: jkindrix key -> rb key (true duplicates the keys missed)
const ALIASES = {
  'いられない': 'てはいられない',          // V-て form + (は)いられない = 〜てはいられない
  'だけでなく': 'だけでなくも',            // だけでなく = 〜だけでなく〜も
  'つもり': 'つもりだ',                    // dictionary form + つもり = 〜つもりだ
  'だけましだ': 'だけまし',                // だけましだ = 〜だけまし
  'かのうちに': 'かないかのうちに',        // V dict + か + V ない + かのうちに = 〜か〜ないかのうちに
  'ところ': 'ところだ',                    // Verb form + ところ = 〜ところだ
  'おかげでorせいで': 'おかげで',          // bundled entry = 〜おかげで
  'かのように': 'かのようだ',              // かのように = 〜かのようだ / 〜かのように
};

// ---------- match ----------
const rbByKey = new Map();
rb.forEach(r => {
  if (!rbByKey.has(r.key)) rbByKey.set(r.key, []);
  rbByKey.get(r.key).push(r);
});

const groups = []; // {key, jk:[], rb:[]}
const groupByKey = new Map();
function getGroup(key) {
  if (!groupByKey.has(key)) {
    const g = { key, jk: [], rb: [] };
    groups.push(g); groupByKey.set(key, g);
  }
  return groupByKey.get(key);
}

const matchedRb = new Set();
for (const j of jk) {
  let g = null, hitRb = null;
  const keys = [...j.keys];
  for (const [from, to] of Object.entries(ALIASES)) {
    if (keys.includes(from) && rbByKey.has(to)) keys.unshift(to);
  }
  for (const k of keys) {
    if (rbByKey.has(k)) { g = getGroup(k); hitRb = k; break; }
  }
  if (!g) g = getGroup(j.keys[0]);
  g.jk.push(j);
  if (hitRb) {
    for (const r of rbByKey.get(hitRb)) { g.rb.push(r); matchedRb.add(r); }
  }
}
for (const r of rb) {
  if (!matchedRb.has(r)) getGroup(r.key).rb.push(r);
}

let both = 0, jkOnly = 0, rbOnly = 0;
const jkOnlyList = [], rbOnlyList = [];
for (const gr of groups) {
  if (gr.jk.length && gr.rb.length) both++;
  else if (gr.jk.length) { jkOnly++; jkOnlyList.push(gr); }
  else { rbOnly++; rbOnlyList.push(gr); }
}
console.log('groups:', groups.length, '| both:', both, '| jk-only:', jkOnly, '| rb-only:', rbOnly);

// near-match review list
function near(a, b) { return (a.includes(b) || b.includes(a)) && Math.min(a.length, b.length) >= 3; }
const pairs = [];
for (const gj of jkOnlyList) for (const gr of rbOnlyList) {
  if (near(gj.key, gr.key)) pairs.push({ jk: gj.jk[0].pattern + ' [' + gj.jk[0].level + '] <' + gj.key + '>', rb: gr.rb[0].pattern + ' [' + gr.rb[0].level + '] <' + gr.key + '>' });
}
console.log('near-match pairs:', pairs.length);
pairs.forEach(p => console.log('  JK:', p.jk, ' <=> RB:', p.rb));

fs.writeFileSync('merge_groups.json', JSON.stringify(groups, null, 1));
