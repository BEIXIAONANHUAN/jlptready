// 应用入口
document.addEventListener('DOMContentLoaded', function () {
  Router.render(); // 根据当前 hash 显示对应页面
  Home.init();     // 首页数据与事件（始终初始化，返回首页时即为最新状态）
});

// 注册 Service Worker（PWA：离线缓存）；注册失败不影响正常使用
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function (e) {
      console.warn('[SW] 注册失败', e);
    });
  });
}
