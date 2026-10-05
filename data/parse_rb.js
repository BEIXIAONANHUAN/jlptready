// Parse Ralphbupt lesson markdown v2 — flexible section names, junk filtering
const fs = require('fs');

const files = fs.readdirSync('rb_md').filter(f => f.endsWith('.md'));
const entries = [];

const JUNK = /辨析|対比|对比|總結|总结|整理|图解|図解|错误|誤り|間違い|mistake|注意|复习|復習|練習|练习|答案|速查|口诀|口訣|場景|场景|比較|比较|詳解|详解|汇总|總対比|总対比|対比表|比较表|使用注意|搭配|組合|组合|区分|判断|選択|选择|填空|翻訳|翻译|改错|总览|總覽|速览|切换规则|分类|版本|^授受|用途|基本用法|Complete|Comparison|Summary|Contrast|Rules|Overview|Table|Practice|Exercise|Answers|vs\b/i;

const FORM_WHITELIST = /^(ます|て|た|ない|受身|使役|意向|可能|命令|禁止|条件|假定|推量|意志|様態|伝聞|過去|尊敬|謙譲|丁重|美化)形(成)?$|^(受身|使役|使役受身|敬語|尊敬語|謙譲語|丁重語|美化語|普通形|辞書形)$/;

function classifySection(name) {
  if (/接[続续]/.test(name) || /Conjugation/i.test(name)) return 'conj';
  if (/含?[义義]/.test(name) || /^Meaning/i.test(name)) return 'meaning';
  if (/例句/.test(name) || /Example/i.test(name)) return 'examples';
  return null;
}

function extractZhBlock(sectionText) {
  const m = sectionText.match(/:::zh\s*\n([\s\S]*?):::/);
  return m ? m[1] : null;
}

for (const f of files) {
  const level = f.split('__')[1];
  const lesson = (f.match(/lesson(\d+)_/) || [])[1] || '?';
  const text = fs.readFileSync('rb_md/' + f, 'utf8');

  const parts = text.split(/^##\s+(\d+)\.\s+/m);
  for (let i = 1; i < parts.length; i += 2) {
    let body = parts[i + 1].split(/^##\s+/m)[0];
    const headerEnd = body.indexOf('\n');
    const header = body.slice(0, headerEnd).trim();
    body = body.slice(headerEnd + 1);

    const zhPart = header.split('||')[0].trim();
    let pattern = zhPart, shortZh = null;
    const pm = zhPart.match(/^(.*?)（([^（）]*)）\s*$/);
    if (pm) { pattern = pm[1].trim(); shortZh = pm[2].trim(); }

    // skip junk sections (comparison tables, summaries, exercises...)
    if (JUNK.test(pattern)) continue;
    // keep only 〜-style patterns or recognized standalone form names
    if (!/[〜～]/.test(pattern) && !FORM_WHITELIST.test(pattern)) continue;

    const secRe = /^###\s+([^\n]+)/gm;
    const secIdx = [];
    let m;
    while ((m = secRe.exec(body))) secIdx.push({ name: m[1].trim(), headEnd: secRe.lastIndex });
    const sections = {};
    for (let s = 0; s < secIdx.length; s++) {
      const end = s + 1 < secIdx.length ? secIdx[s + 1].start ?? secIdx[s + 1].headEnd : body.length;
      // note: secRe lastIndex is end of match; compute section start properly
      sections[secIdx[s].name] = { text: body.slice(secIdx[s].headEnd, end), cls: classifySection(secIdx[s].name) };
    }

    let continuation = null, meaning = null;
    const examples = [];
    for (const [name, sec] of Object.entries(sections)) {
      if (sec.cls === 'conj' && !continuation) {
        const zh = extractZhBlock(sec.text);
        if (zh) {
          const lines = zh.split('\n').map(l => l.trim()).filter(l => /^[-・]/.test(l)).map(l => l.replace(/^[-・]\s*/, '').replace(/\*\*/g, '').trim());
          if (lines.length) continuation = lines.join('；');
        }
      }
      if (sec.cls === 'meaning' && !meaning) {
        const zh = extractZhBlock(sec.text);
        if (zh) {
          meaning = zh.split('\n').map(l => l.trim()).filter(l => l && !/^:::/.test(l))
            .map(l => l.replace(/^>\s*/, '').replace(/\*\*/g, '').trim()).join('\n').trim() || null;
        }
      }
      if (sec.cls === 'examples') {
        const zh = extractZhBlock(sec.text);
        if (zh) {
          for (const raw of zh.split('\n')) {
            const line = raw.trim();
            const em = line.match(/^(\d+)\.\s*(.+)$/);
            if (!em) continue;
            const content = em[2];
            const tm = content.match(/^(.*?)（([^（）]*)）\s*[。.]?\s*$/);
            if (tm && tm[2].length <= 60 && /[\u4e00-\u9fff]/.test(tm[2])) {
              examples.push({ ja: tm[1].replace(/\*\*/g, '').trim(), zh: tm[2].trim() });
            } else {
              examples.push({ ja: content.replace(/\*\*/g, '').trim(), zh: null });
            }
          }
        }
      }
    }

    entries.push({ source: 'ralphbupt', level, lesson, pattern, shortZh, continuation, meaning, examples, file: f });
  }
}

console.log('total parsed entries:', entries.length);
const byLv = {};
entries.forEach(e => byLv[e.level] = (byLv[e.level] || 0) + 1);
console.log('by level:', byLv);
let noMean = 0, noEx = 0, noCont = 0;
entries.forEach(e => {
  if (!e.meaning) noMean++;
  if (!e.examples.length) noEx++;
  if (!e.continuation) noCont++;
});
console.log('missing meaning:', noMean, '| no examples:', noEx, '| missing continuation:', noCont);
fs.writeFileSync('rb_entries.json', JSON.stringify(entries, null, 1));
