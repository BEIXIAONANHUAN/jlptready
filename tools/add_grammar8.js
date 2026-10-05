#!/usr/bin/env node
/**
 * add_grammar8.js — 插入 8 个已获用户确认的新语法条目（第 3 阶段补数据）
 *
 * 用法：
 *   node tools/add_grammar8.js          # dry-run：更新 data/grammar_clean.json（620→628），不写库
 *   node tools/add_grammar8.js --run    # 同时插入 grammar 表
 *
 * 幂等：按 pattern 查重，已存在的条目跳过（可安全重复执行）。
 * 只写 grammar 一张表，不碰任何其他表。
 */
'use strict';

const fs = require('fs');
const C = require('./lib/common');
const SB = require('./lib/supabase');

// theme_order 与 pos 对齐词库同分类（1 时间先后/6 比较对比/7 程度变化/12 感叹强调/13 敬语体系/14 被动使役/15 传闻引用）
const NEW8 = [
  { pattern: '〜に至って', meaning: '直到……才；到了……的地步', continuation: '動詞辞書形/名詞＋に至って', example1: '再三の注意に至って、彼はようやく謝罪した。', example1_zh: '到了再三警告的地步，他终于道歉了。', example2: '事態がここに至って、初めて危機感を覚えた。', example2_zh: '事态发展到这个地步，才第一次感到危机感。', pos: '时间先后', theme_order: 1 },
  { pattern: '〜お〜になる（尊敬語）', meaning: '（尊敬）对动作主体的敬语表达', continuation: 'お＋動詞ます形語幹＋になる／ご＋サ変語幹＋になる', example1: '部長はもうお帰りになりました。', example1_zh: '部长已经回去了。', example2: '先生、ご覧になりますか。', example2_zh: '老师，您要看吗？', pos: '敬语体系', theme_order: 13 },
  { pattern: '〜させていただく（謙譲語）', meaning: '（谦让）请允许我做……', continuation: '動詞使役形＋ていただく', example1: 'まず自己紹介させていただきます。', example1_zh: '请允许我先做个自我介绍。', example2: '明日休ませていただきます。', example2_zh: '请允许我明天休息。', pos: '敬语体系', theme_order: 13 },
  { pattern: '〜とは（感嘆）', meaning: '竟然……！（对意外事实的感叹）', continuation: '普通形（名詞・ナ形〜だ）＋とは', example1: 'こんなに早く結果が出るとは驚いた。', example1_zh: '没想到这么快就出结果了，真惊人。', example2: 'これほど美しい景色とは思わなかった。', example2_zh: '没想到景色这么美。', pos: '感叹强调', theme_order: 12 },
  { pattern: '〜むしろ', meaning: '与其……不如……；宁可', continuation: '（というより）＋むしろ／文頭＋むしろ', example1: 'これは失敗というより、むしろ学習のチャンスだ。', example1_zh: '这与其说是失败，不如说是学习的机会。', example2: '難しいというより、むしろ複雑だ。', example2_zh: '与其说难，不如说复杂。', pos: '比较对比', theme_order: 6 },
  { pattern: '〜きらいがある', meaning: '有……的倾向（贬义）', continuation: '動詞辞書形＋きらいがある', example1: '彼は人の話を途中で遮るきらいがある。', example1_zh: '他有打断别人说话的毛病。', example2: '長時間のデスクワークは肩こりを招くきらいがある。', example2_zh: '长时间伏案工作容易引发肩颈酸痛。', pos: '程度变化', theme_order: 7 },
  { pattern: '〜に〜される（被害受身）', meaning: '被……（蒙受不利/受害的被动）', continuation: '（被害者は）＋被害源名詞＋に＋動詞受身形', example1: '散歩中に犬に手を咬まれた。', example1_zh: '散步时被狗咬了手。', example2: '満員電車で足を踏まれた。', example2_zh: '在满员电车里被踩了脚。', pos: '被动使役', theme_order: 14 },
  { pattern: '〜とのことだ', meaning: '据……说（正式转述）', continuation: '普通形/名詞＋とのことだ', example1: '担当者の話によると、来月から料金が値上げされるとのことだ。', example1_zh: '据负责人说，下月起费用要上调。', example2: '天気予報によると、明日は雨とのことだ。', example2_zh: '据天气预报说明天有雨。', pos: '传闻引用', theme_order: 15 },
];

const CLEAN = 'data/grammar_clean.json';
const LEVEL_ORDER = { N5: 0, N4: 1, N3: 2, N2: 3 };

async function main() {
  const run = process.argv.includes('--run');

  // 1. 更新 data/grammar_clean.json（幂等：按 pattern 查重）
  const clean = C.readJson(CLEAN);
  const existing = new Set(clean.map((g) => g.pattern));
  const toAdd = NEW8.filter((g) => !existing.has(g.pattern));
  if (toAdd.length) {
    const merged = clean.concat(toAdd.map((g) => ({ ...g, level: 'N2', frequency: 0 })));
    merged.sort((a, b) => (a.theme_order - b.theme_order) || ((LEVEL_ORDER[a.level] || 9) - (LEVEL_ORDER[b.level] || 9)));
    C.writeJson(CLEAN, merged);
    console.log(`data/grammar_clean.json：${clean.length} → ${merged.length}（新增 ${toAdd.length} 条）`);
  } else {
    console.log(`data/grammar_clean.json 已含全部 8 条（${clean.length} 条），跳过文件更新`);
  }

  // 2. 写库（幂等：先查 grammar 表现有 pattern）
  const cfg = SB.loadConfig();
  const { map } = await SB.fetchGrammarMap(cfg);
  const dbHas = (p) => map.has(C.normPat(p));
  const rows = NEW8.filter((g) => !dbHas(g.pattern))
    .map((g) => ({ ...g, level: 'N2', frequency: 0 }));
  console.log(`grammar 表待插入：${rows.length} 条（已存在跳过 ${NEW8.length - rows.length} 条）`);
  if (!rows.length) {
    console.log('无需写库。');
    return;
  }
  if (!run) {
    console.log('[dry-run] 未写库。确认后加 --run 执行。');
    return;
  }
  await SB.req(cfg, 'POST', '/rest/v1/grammar', rows);
  console.log(`完成：grammar 表插入 ${rows.length} 行。`);
}

main().catch((e) => {
  console.error(`失败：${e.message}`);
  process.exit(1);
});
