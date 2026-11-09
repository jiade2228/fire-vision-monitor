// 在样式与模块脚本执行前应用已保存的主题，避免浅色用户刷新时先闪一下深色。
// 独立同源脚本，符合 CSP `script-src 'self'`（不需要内联脚本或 unsafe-inline）。
(function () {
  try {
    var theme =
      window.localStorage.getItem('flame-vision.theme.v1') === 'light'
        ? 'light'
        : 'dark';
    document.documentElement.dataset.theme = theme;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content', theme === 'light' ? '#f2f5f9' : '#070c14');
    }
  } catch (error) {
    // 隐私模式或存储被禁用时保持默认深色。
  }
})();
