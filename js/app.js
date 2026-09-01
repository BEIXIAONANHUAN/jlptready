// 应用入口
document.addEventListener('DOMContentLoaded', function () {
  Router.render(); // 根据当前 hash 显示对应页面
  Home.init();     // 首页数据与事件（始终初始化，返回首页时即为最新状态）
});
