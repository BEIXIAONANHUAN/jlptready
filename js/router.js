// Hash 路由：#/ 首页，#/new 今日新词，#/review 今日复习，#/exam 周末考试，#/wrongbook 错题本，#/search、#/stats、#/checkin 子页面
window.Router = (function () {
  const ROUTES = ['home', 'new', 'review', 'exam', 'wrongbook', 'search', 'stats', 'checkin'];

  function current() {
    const name = location.hash.replace(/^#\/?/, '');
    return ROUTES.includes(name) ? name : 'home';
  }

  // 页面切入时的回调（刷新数据 / 恢复断点）
  function onEnter(route) {
    if (route === 'new' && window.NewWords) NewWords.enter();
    if (route === 'review' && window.Review) Review.enter();
    if (route === 'exam' && window.Exam) Exam.enter();
    if (route === 'wrongbook' && window.WrongBook) WrongBook.enter();
    if (route === 'search' && window.Search) Search.enter();
    if (route === 'stats' && window.Stats) Stats.enter();
    if (route === 'checkin' && window.CheckIn) CheckIn.enter();
    if (route === 'home' && window.Home && Home.onShow) Home.onShow();
  }

  function render() {
    const active = current();
    ROUTES.forEach((r) => {
      document.getElementById('page-' + r).classList.toggle('active', r === active);
    });
    window.scrollTo(0, 0);
    onEnter(active);
  }

  window.addEventListener('hashchange', render);

  return { render };
})();
