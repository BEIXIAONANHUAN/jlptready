// Hash 路由：#/ 门户页；#/words 单词板块首页；#/grammar 语法板块首页；
// #/words|grammar/new|review|exam|wrongbook|search|stats|checkin 各板块 7 个子页。
// 解析规则：去掉 "#/" 后按第一段分模块、第二段分页面；无第二段即该模块首页；
// 未知模块/页面一律回退门户页。
window.Router = (function () {
  const MODULES = {
    words: ['new', 'review', 'exam', 'wrongbook', 'search', 'stats', 'checkin'],
    grammar: ['new', 'review', 'exam', 'wrongbook', 'search', 'stats', 'checkin'],
  };
  // 模块首页的 DOM id（门户设计：语法首页叫 page-grammar-home）
  const HOME_ID = { words: 'page-words', grammar: 'page-grammar-home' };

  // 返回 { module, page }；门户页为 { module: null, page: null }
  function current() {
    const seg = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    const mod = seg[0];
    const sub = seg[1];
    if (mod && MODULES[mod]) {
      if (!sub) return { module: mod, page: null };
      if (MODULES[mod].includes(sub)) return { module: mod, page: sub };
    }
    return { module: null, page: null };
  }

  // 上一跳路由（用于识别「离开 grammar/new」；初始为 null，首屏不算切出）
  let prev = null;

  function isGrammarNew(r) {
    return !!(r && r.module === 'grammar' && r.page === 'new');
  }

  // 页面切入时的回调（刷新数据 / 恢复断点）
  function onEnter(route) {
    // 仅当上一跳是 grammar/new、当前不是，且 GrammarNew 已加载时才 leave（其它路由零调用）
    if (isGrammarNew(prev) && !isGrammarNew(route) && window.GrammarNew && GrammarNew.leave) {
      GrammarNew.leave();
    }
    prev = route;
    if (route.module === 'grammar') {
      if (route.page === 'new' && window.GrammarNew) GrammarNew.enter();
      if (route.page === 'review' && window.GrammarReview) GrammarReview.enter();
      if (route.page === 'exam' && window.GrammarExam) GrammarExam.enter();
      if (route.page === 'wrongbook' && window.GrammarWrongbook) GrammarWrongbook.enter();
      if (route.page === 'search' && window.GrammarSearch) GrammarSearch.enter();
      if (route.page === 'stats' && window.GrammarStats) GrammarStats.enter();
      if (route.page === 'checkin' && window.GrammarCheckin) GrammarCheckin.enter();
      if (route.page === null && window.GrammarHome && GrammarHome.onShow) GrammarHome.onShow();
      return;
    }
    if (route.module !== 'words') {
      // 回到门户页时刷新两张卡片（进度可能刚变过）
      if (window.Landing && Landing.onShow) Landing.onShow();
      return;
    }
    if (route.page === 'new' && window.NewWords) NewWords.enter();
    if (route.page === 'review' && window.Review) Review.enter();
    if (route.page === 'exam' && window.Exam) Exam.enter();
    if (route.page === 'wrongbook' && window.WrongBook) WrongBook.enter();
    if (route.page === 'search' && window.Search) Search.enter();
    if (route.page === 'stats' && window.Stats) Stats.enter();
    if (route.page === 'checkin' && window.CheckIn) CheckIn.enter();
    if (route.page === null && window.Home && Home.onShow) Home.onShow();
  }

  function render() {
    const active = current();

    const landing = document.getElementById('page-landing');
    landing.classList.toggle('active', active.module === null);
    Object.keys(MODULES).forEach((mod) => {
      document.getElementById(HOME_ID[mod]).classList.toggle(
        'active', active.module === mod && active.page === null
      );
      MODULES[mod].forEach((p) => {
        document.getElementById('page-' + mod + '-' + p).classList.toggle(
          'active', active.module === mod && active.page === p
        );
      });
    });

    window.scrollTo(0, 0);
    onEnter(active);
  }

  window.addEventListener('hashchange', render);

  return { render };
})();
