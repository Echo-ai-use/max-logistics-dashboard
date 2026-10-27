/* 自动检测最新版本
 * 解决 GitHub Pages max-age=600 + 浏览器缓存导致「分享链接打开不是最新」的问题：
 * 访客打开页面时，用 no-store 拉取 version.json，若线上 buildId 比当前页面新，则自动跳转到最新构建。
 */
(function () {
  var buildAt = window.__BUILD_AT__ || '';
  function curV() {
    var m = location.search.match(/[?&]v=([^&]+)/);
    return m ? m[1] : '';
  }
  function go(newId) {
    if (curV() === newId) return; // 已在最新版，避免循环
    var url = location.pathname + '?v=' + newId + (location.hash || '');
    location.replace(url);
  }
  function check() {
    fetch('version.json?_=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.buildId) return;
        var nb = parseInt(d.buildId, 10), cb = parseInt(buildAt, 10);
        if (!isNaN(nb) && !isNaN(cb) && nb > cb) go(d.buildId);
      })
      .catch(function () {}); // 网络/404 忽略，下次再试
  }
  try {
    if (buildAt) {
      check();
      setInterval(check, 60000); // 标签页常开时，每分钟复查一次
    }
  } catch (e) {}
})();
