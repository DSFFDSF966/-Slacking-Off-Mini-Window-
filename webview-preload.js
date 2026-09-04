// webview 预加载脚本：拦截链接 + 传出非输入框按键事件
const { ipcRenderer } = require('electron');

(function () {
  if (window.__pipLinkInterceptorInstalled) return;
  window.__pipLinkInterceptorInstalled = true;

  // 拦截 target=_blank / 修饰键点击的链接
  document.addEventListener('click', function (e) {
    var a = null;
    var el = e.target;
    while (el && el !== document) {
      if (el.tagName === 'A') { a = el; break; }
      el = el.parentElement;
    }
    if (!a || !a.href) return;
    var href = a.href;
    if (!href || href.indexOf('javascript:') === 0 || href.charAt(0) === '#') return;
    var target = (a.target || '').toLowerCase();
    var isBlank = target === '_blank' || target === '_new' || target === '_parent' || target === '_top';
    var modifier = e.ctrlKey || e.shiftKey || e.metaKey || e.button === 1;
    if (isBlank || modifier) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      ipcRenderer.sendToHost('pip-open-url', href);
    }
  }, true);

  // 传出非输入框按键事件（用于应用内热键，不拦截系统打字）
  document.addEventListener('keydown', function (e) {
    var target = e.target;
    if (!target) return;
    var tag = target.tagName;
    // 焦点在输入框/可编辑区域 → 不触发热键，正常打字
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
        target.isContentEditable || (target.closest && target.closest('[contenteditable="true"]'))) {
      return;
    }
    ipcRenderer.sendToHost('pip-keydown', {
      key: e.key,
      code: e.code,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey
    });
  }, true);

  // 传出 Alt+滚轮（调节透明度）和 Ctrl+滚轮（网页缩放）
  document.addEventListener('wheel', function (e) {
    if (e.altKey) {
      e.preventDefault();
      ipcRenderer.sendToHost('pip-alt-wheel', { deltaY: e.deltaY });
    } else if (e.ctrlKey) {
      e.preventDefault();
      ipcRenderer.sendToHost('pip-ctrl-wheel', { deltaY: e.deltaY });
    }
  }, { passive: false, capture: true });
})();
