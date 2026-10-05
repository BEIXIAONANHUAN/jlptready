'use strict';
// Supabase REST 共享库：从 js/config.js 提取连接信息、全量拉取 grammar 表建 pattern→id 映射、
// grammar_questions 批量写入。供 tools/import_questions.js 与 tools/import_manual150.js 复用。
// 仅用 Node 内置 fetch（Node 18+），零第三方依赖。

const fs = require('fs');
const C = require('./common');

function loadConfig(configPath = 'js/config.js') {
  const full = C.resolveRoot(configPath);
  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch (e) {
    throw new Error(`无法读取 Supabase 配置：${full}\n${e.message}`);
  }
  const url = (text.match(/SUPABASE_URL\s*:\s*['"]([^'"]+)['"]/) || [])[1];
  const key = (text.match(/SUPABASE_ANON_KEY\s*:\s*['"]([^'"]+)['"]/) || [])[1];
  if (!url || !key) throw new Error(`无法从 ${configPath} 中正则提取 SUPABASE_URL / SUPABASE_ANON_KEY`);
  return { url: url.replace(/\/+$/, ''), key };
}

async function req(cfg, method, urlpath, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = await fetch(cfg.url + urlpath, {
      method,
      signal: ctl.signal,
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      let hint = '';
      if (res.status === 404 && /PGRST205/.test(String(text))) {
        hint = '\n提示：数据库中不存在 grammar 表，请先执行 migrations/2026-10-05_grammar_module.sql 建表。';
      }
      throw new Error(`HTTP ${res.status} ${method} ${urlpath}\n${String(text).slice(0, 800)}${hint}`);
    }
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

// 全量拉取 grammar 表（PostgREST 单页上限 1000，用 limit/offset 分页）。
// 返回 Map：normPat(pattern) → id。归一化后重复的 pattern 只保留第一条并计数告警（禁止猜匹配）。
async function fetchGrammarMap(cfg) {
  const map = new Map();
  const dupPatterns = [];
  const PAGE = 1000;
  let offset = 0;
  for (;;) {
    const rows = await req(cfg, 'GET', `/rest/v1/grammar?select=id,pattern&order=id&limit=${PAGE}&offset=${offset}`);
    if (!Array.isArray(rows)) throw new Error('grammar 表响应异常：不是数组');
    for (const r of rows) {
      const k = C.normPat(r.pattern);
      if (map.has(k)) dupPatterns.push(r.pattern);
      else map.set(k, r.id);
    }
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  return { map, dupPatterns };
}

// 把生成好的题目行映射为 grammar_questions 表行。表内已有 level/theme/bloom_level/
// difficulty 列（migration 2026-10-05），JSON 里带了就一并入库，没带为 null。
function toRow(grammarId, q) {
  return {
    grammar_id: grammarId,
    type: q.type,
    question: q.question,
    question_zh: q.question_zh != null ? q.question_zh : null,
    options: q.options,
    correct: q.correct,
    explanation: q.explanation,
    source: q.source || 'auto',
    reviewed: !!q.reviewed,
    level: q.level != null ? String(q.level) : null,
    theme: q.theme != null ? String(q.theme) : null,
    bloom_level: q.bloom_level != null ? String(q.bloom_level) : null,
    difficulty: q.difficulty != null ? String(q.difficulty) : null,
  };
}

// 按题目行的 grammar_pattern（normPat 匹配）解析 grammar_id。
// 匹配不上的计入清单返回（由调用方打印），不猜、不跳过 silent。
function resolveGrammarIds(rows, gmap) {
  const resolved = [];
  const unmatched = new Map(); // pattern → 行数
  for (const q of rows) {
    const id = gmap.get(C.normPat(q.grammar_pattern));
    if (!id) {
      const k = q.grammar_pattern;
      unmatched.set(k, (unmatched.get(k) || 0) + 1);
      continue;
    }
    resolved.push(toRow(id, q));
  }
  return { resolved, unmatched };
}

// 批量 insert，每批 500。任一批失败即抛错中止（不留半截成功却不报错的局面）。
async function batchInsert(cfg, rows, batchSize = 500, onBatch) {
  let batches = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    await req(cfg, 'POST', '/rest/v1/grammar_questions', chunk);
    batches++;
    if (onBatch) onBatch(batches, chunk.length, rows.length);
  }
  return { batches, inserted: rows.length };
}

module.exports = { loadConfig, req, fetchGrammarMap, toRow, resolveGrammarIds, batchInsert };
