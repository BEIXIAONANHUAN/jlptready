'use strict';
// 生成脚本共用工具：路径、JSON 读写、选项归一化、确定性随机、报告段落合并。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function resolveRoot(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

function readJson(p) {
  const full = resolveRoot(p);
  let raw;
  try {
    raw = fs.readFileSync(full, 'utf8');
  } catch (e) {
    throw new Error(`读取文件失败：${full}\n${e.message}`);
  }
  raw = raw.replace(/^﻿/, ''); // 去 BOM
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`JSON 解析失败：${full}\n${e.message}`);
  }
}

function writeJson(p, data) {
  const full = resolveRoot(p);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return full;
}

// ---------- 选项归一化 ----------
// 目的：比对"形异实同"的接续字符串，防止正确项与干扰项字面不同但归一化后相同。
// 规则（与任务书约定一致）：
//   1. 波浪号统一：〜(U+301C) ∼(U+223C) ～(U+FF5E) 全部归一为半角 ~
//      （先做波浪号映射，再走全角→半角，U+FF5E 落在 !-～ 区间内会被自然转成 ~）
//   2. 全角→半角：!-～ 区间（含全角括号、全角小写字母等）
//   3. 半角片假名→全角片假名
//   4. 加号统一：＋/﹢ → +，且 + 前后空格清空
//   5. 去除全部空白（含全角空格），统一小写
const HW_KANA = 'ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝﾞﾟ';
const FW_KANA = 'ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン゛゜';

function normalizeOption(s) {
  if (s == null) return '';
  let t = String(s);
  t = t.replace(/[〜∼～]/g, '~'); // 波浪号统一（此时 ~ 已是目标形态，此步把三种波浪变体归一）
  t = t.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)); // 全角 ASCII → 半角
  t = t.replace(/[ｦ-ﾟ]/g, (ch) => { const i = HW_KANA.indexOf(ch); return i >= 0 ? FW_KANA[i] : ch; });
  t = t.replace(/[＋﹢]/g, '+');
  t = t.replace(/\s*\+\s*/g, '+');
  t = t.replace(/[\s　]+/g, '');
  return t.toLowerCase();
}

// 语法条目 pattern 的比对形态：去开头波浪号 + 归一化
function normPat(p) {
  return normalizeOption(String(p == null ? '' : p).replace(/^[〜～~\s　]+/, ''));
}

function stripWave(p) {
  return String(p == null ? '' : p).replace(/^[〜～~\s　]+/, '');
}

// ---------- 语境题挖空：pattern 候选形 ----------
// 「〜において / 〜における」→ ['において', 'における']
// 「ならでは（の）」        → ['ならではの', 'ならでは']（先试保留括号内容，再试整段删除）
// 「〜とおり(に)」          → ['とおりに', 'とおり']（全半角括号都处理）
// 「〜中（ちゅう／じゅう）」→ ['中ちゅう', '中じゅう', '中']（括号内 ／ 做笛卡尔展开，省略殿后）
// 规则：括号外按「／」「/」拆变体 → 每个变体剥开头「〜/～」、去空白 →
//       每段括号内容按内部 ／ 拆 + 可整段省略，与剩余文本做笛卡尔积；含内容形在前、省略形在后。
function patternCandidates(pattern) {
  const raw = String(pattern == null ? '' : pattern);
  const variants = splitOutsideBrackets(raw, /[／/]/)
    .map((s) => stripWave(s).replace(/[\s　]+/g, ''))
    .filter(Boolean);
  const out = [];
  const seen = new Set();
  const push = (s) => { if (s && !seen.has(s)) { seen.add(s); out.push(s); } };
  for (const v of variants) {
    const extras = [];
    const segs = v.match(/[（(][^（）()]*[)）]/g);
    if (!segs || !segs.length) {
      push(v);
    } else {
      let forms = [v];
      for (const seg of segs) {
        const parts = seg.slice(1, -1).split(/[／/]/);
        const opts = parts.slice();
        for (const o of parts) {
          if (/^[〜～~＋+]/.test(o)) {
            const s = stripWave(o); // 槽位 surface 形：受身形（〜られる）→ られる；意向形（〜よう）→ よう
            if (s) { opts.push(s); extras.push(s); }
          }
        }
        opts.push('');
        const next = [];
        for (const f of forms) for (const o of opts) next.push(f.replace(seg, o));
        forms = next;
      }
      for (const f of forms) push(f);
    }
    // 形态兜底：无括号变体去掉内部 〜/＋ 后再试（と〜→と 这类 1 字符结果不入候选，避免噪声）
    if (!segs || !segs.length) {
      const nw = v.replace(/[〜～~＋+]/g, '');
      if (nw !== v && nw.length >= 2) extras.push(nw);
    }
    for (const e of extras) push(e);
  }
  return out;
}

// 候选片段：含内部槽位「〜/＋」的 pattern（如「もう＋動詞た形」「〜ば〜ほど」）拆出的片段，
// 按长度降序（≥2 字符），供挖空最后一级兜底（例：例句只出现槽位之一「ほど」「もう」也可出题）。
function patternFragments(pattern) {
  const raw = String(pattern == null ? '' : pattern);
  const out = new Set();
  for (const variant of splitOutsideBrackets(raw, /[／/]/)) {
    const v = stripWave(variant).replace(/[\s　]+/g, '');
    for (const seg of v.split(/[〜～~＋+]/)) {
      const s = seg.replace(/[（(][^（）()]*[)）]/g, '');
      if (s.length >= 2) out.add(s);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

// 括号外切分：按 re 切字符串，忽略（）/() 括号内的分隔符
function splitOutsideBrackets(s, re) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of String(s == null ? '' : s)) {
    if (ch === '（' || ch === '(') { depth++; cur += ch; continue; }
    if (ch === '）' || ch === ')') { depth = Math.max(0, depth - 1); cur += ch; continue; }
    if (depth === 0 && re.test(ch)) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

// ---------- 语境题第 2 级：形态交替扩展 ----------
// 例句常用敬体/活用形而 pattern 是辞典形：为候选形生成礼貌形与活用形交替面，
// 在例句原串中匹配（命中即挖匹配到的交替面，不会误伤原文其他位置）。
// 交替面由候选形自身派生，错误形式（如五段动词「終わます」）只会失配、不会造成错误挖空。
const GODAN_I = { く: 'き', ぐ: 'ぎ', す: 'し', つ: 'ち', ぬ: 'に', ぶ: 'び', む: 'み', る: 'り', う: 'い' };
const GODAN_PAST_TE = { く: ['いた', 'いて'], ぐ: ['いだ', 'いで'], す: ['した', 'して'], つ: ['った', 'って'], ぬ: ['んだ', 'んで'], ぶ: ['んだ', 'んで'], む: ['んだ', 'んで'], う: ['った', 'って'], る: ['った', 'って'] };
const IRREG = { する: ['した', 'して', 'している', 'ています', 'ていました', 'します', 'しました'], くる: ['きた', 'きます', 'きました'] };
// 敬语动词不规则礼貌形：いらっしゃる→いらっしゃいます 等（做尾缀匹配，前面可带助词等前缀）
const IRREG_TAIL = {
  いらっしゃる: ['いらっしゃいます', 'いらっしゃいました'],
  おっしゃる: ['おっしゃいます', 'おっしゃいました'],
  なさる: ['なさいます', 'なさいました'],
  くださる: ['くださいます', 'くださいました'],
  ござる: ['ございます', 'ございました'],
};

function surfaceAlternants(cand) {
  if (!cand) return [];
  const out = new Set();
  const tail = cand[cand.length - 1];
  const stem = cand.slice(0, -1);
  if (IRREG[cand]) for (const x of IRREG[cand]) out.add(x);
  if (cand.length >= 2 && (cand.endsWith('する') || cand.endsWith('くる'))) {
    const st = cand.slice(0, -2);
    for (const x of IRREG[cand.slice(-2)]) out.add(st + x);
  }
  for (const [k, forms] of Object.entries(IRREG_TAIL)) {
    if (cand.length >= k.length && cand.endsWith(k)) {
      const st = cand.slice(0, -k.length);
      for (const x of forms) out.add(st + x);
    }
  }
  if (tail === 'る') {
    // 一段：食べる→食べます；五段：終わる→終わります；过去：食べた／終わった；て形：食べて／終わって；れる过去：余儀なくされる→余儀なくされた
    for (const x of ['ます', 'ました', 'ません', 'ましょう', 'ります', 'りました', 'た', 'った', 'て', 'って', 'れた']) out.add(stem + x);
  } else if (GODAN_I[tail]) {
    for (const suf of ['ます', 'ました', 'ません', 'ましょう']) out.add(stem + GODAN_I[tail] + suf);
    for (const x of GODAN_PAST_TE[tail]) out.add(stem + x);
  }
  if (tail === 'だ') { // 名词/な形谓语：予定だ→予定です／予定だった
    for (const x of ['です', 'でした', 'じゃない', 'だった']) out.add(stem + x);
  }
  if (tail === 'い') { // 形容词：高い→高かった／高くない
    for (const x of ['かった', 'くない', 'くなかった']) out.add(stem + x);
  }
  if (/^だ[のん]/.test(cand)) out.add('な' + cand.slice(1)); // だのに→なのに
  if (/^な[のん]/.test(cand)) out.add('だ' + cand.slice(1));
  out.delete(cand);
  return [...out].filter((x) => x.length >= 2 && x.length <= 24);
}

// ---------- 语境题兜底：助词宽松匹配 ----------
// 候选形从最长到最短取「结尾片段」（后缀），在例句中找该片段，片段长度 ≥3 即命中。
// 例：候选形「しかたがない」+ 例句「これはしょうがない」→ 后缀「がない」(3) 命中；
//     候选形「にもかかわらず」+「病気なのにかかわらず」→ 后缀「にかかわらず」(6) 命中。
// 返回命中片段（用于挖空），未命中返回 null。
function looseMatchSegment(candidate, sentence) {
  const b = String(sentence == null ? '' : sentence);
  if (!candidate || !b) return null;
  for (let len = candidate.length; len >= 3; len--) {
    const frag = candidate.slice(candidate.length - len);
    if (b.includes(frag)) return frag;
  }
  return null;
}

// ---------- 确定性随机（同 seed + 同输入 → 同输出，方便自测与复现） ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

function sample(arr, k, rng) {
  return shuffle(arr, rng).slice(0, Math.min(k, arr.length));
}

// ---------- 命令行参数 ----------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[k] = next; i++; }
      else out[k] = true;
    }
  }
  return out;
}

// ---------- 报告（markdown，按段落 upsert，两个生成脚本共用一个文件） ----------
function upsertReportSection(reportPath, sectionId, content) {
  const full = resolveRoot(reportPath);
  const begin = `<!-- SECTION:${sectionId} -->`;
  const end = '<!-- /SECTION -->';
  let text = fs.existsSync(full)
    ? fs.readFileSync(full, 'utf8')
    : '# 语法题库生成报告\n\n本文件由 tools/gen_continuation.js 与 tools/gen_context.js 自动更新；每个脚本只改写自己的段落，可先后独立运行。\n';
  const block = `${begin}\n${content.trim()}\n${end}\n`;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${esc(begin)}[\\s\\S]*?${esc(end)}\\n?`);
  text = re.test(text) ? text.replace(re, block) : text.trimEnd() + '\n\n' + block;
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text, 'utf8');
  return full;
}

function nowStr() {
  return new Date().toLocaleString('sv-SE'); // YYYY-MM-DD HH:MM:SS，无时区歧义
}

function pct(n, total) {
  return total ? `${((n / total) * 100).toFixed(2)}%` : '0%';
}

module.exports = {
  ROOT, resolveRoot, readJson, writeJson,
  normalizeOption, normPat, stripWave, patternCandidates, patternFragments, splitOutsideBrackets, surfaceAlternants, looseMatchSegment,
  mulberry32, shuffle, sample, parseArgs,
  upsertReportSection, nowStr, pct,
};
