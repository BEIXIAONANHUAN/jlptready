# 日语 JLPT N5–N2 备考学习系统

纯 HTML / CSS / JavaScript 实现的个人背单词备考网站，无前端框架、无构建工具，可直接静态托管（GitHub Pages）。

## 功能

- **今日新词**：工作日每天 50 词（按考频加权随机），预览 → 5 组 × 10 词强制做题（每词 3 种题型四选一，错题重排直到答对）→ 组间小结 → 当日总结，断点续学
- **今日复习**：模式 B 做题（艾宾浩斯 1/2/4 天阶梯，连对 3 次毕业）+ 模式 A 卡片自测（1/3/7/15/30 天档位，会/模糊/忘记三档自评）+  mastered 词每日随机抽检（5–10 词，做错即降级）
- **周末考试**：周六日 60 题（薄弱词 50 + 已掌握 10），评级 S/A/B/C，历史最高记录
- **错题本**：薄弱词池（`wrong_count>0 或 weak_reason 非空`），按做错次数排序
- **查单词**：汉字/假名/中文模糊搜索，详情含例句与掌握状态
- **我的数据**：学习统计、总进度条、等级分布、12 枚成就徽章
- **打卡**：GitHub 风格月历热力图、Streak 连击、「今日宜休」休息日（不断签）

## 技术栈

- 纯静态：原生 HTML/CSS/JS，`js/` 按模块拆分（config / db / newwords / review / exam / wrongbook / search / stats / checkin / achievements / home / router / app）
- 数据库：Supabase，通过 CDN 引入 `@supabase/supabase-js@2`
- 路由：hash 路由（`#/new`、`#/review`、`#/exam` 等）
- 本地状态：`localStorage` 存当日新词/考试会话、抽检名单、徽章解锁记录

## ⚠️ 关于 Supabase anon key 的说明

`js/config.js` 中的 `SUPABASE_ANON_KEY` 会随静态代码公开。**Supabase 的 anon key 设计上就是前端公开使用的**，安全性依赖 Row Level Security（RLS）策略。本项目为单用户个人学习项目，当前数据表未开启 RLS，任何拿到 key 的人都可以读写这三张表（words / user_words / daily_logs）——个人自用可接受。如需加固，请在 Supabase 后台为表开启 RLS，或改用带用户鉴权的方案。

## 本地运行

直接双击 `index.html` 即可（需联网加载 Supabase CDN 与 Google Fonts），或用任意静态服务器：

```bash
npx serve .
```

## 部署

推送到 GitHub 仓库后，Settings → Pages → Deploy from a branch → 选 `main` / `(root)` 即可。
