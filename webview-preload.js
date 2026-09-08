// webview 预加载脚本：拦截链接 + 传出非输入框按键事件
const { ipcRenderer } = require('electron');

(function () {
  if (window.__pipLinkInterceptorInstalled) return;
  window.__pipLinkInterceptorInstalled = true;

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

  // 倍速：监听主进程注入的 __pipSpeed，并用 MutationObserver 持续监控新加入的媒体元素
  function applyLocalSpeed(rate) {
    function findMedia(root) {
      var results = [];
      if (!root) return results;
      try {
        var medias = root.querySelectorAll('video,audio');
        for (var i = 0; i < medias.length; i++) results.push(medias[i]);
        var all = root.querySelectorAll('*');
        for (var j = 0; j < all.length; j++) {
          if (all[j].shadowRoot) {
            results = results.concat(findMedia(all[j].shadowRoot));
          }
        }
      } catch (e) {}
      return results;
    }
    function setSpeed() {
      var medias = findMedia(document);
      medias.forEach(function (v) {
        try {
          if (v.playbackRate !== rate) v.playbackRate = rate;
          if (rate === 1 && v.defaultPlaybackRate !== 1) v.defaultPlaybackRate = 1;
        } catch (e) {}
      });
    }
    setSpeed();
    if (!window.__pipSpeedObs) {
      window.__pipSpeedObs = new MutationObserver(function () { setSpeed(); });
      window.__pipSpeedObs.observe(document.body || document.documentElement, { childList: true, subtree: true });
    }
  }
  // 主进程注入 __pipSpeed 后，webview-preload 可以读取并持续应用
  if (window.__pipSpeed != null) {
    applyLocalSpeed(window.__pipSpeed);
  }
  // 轮询检查（主进程注入有延迟）
  var _speedCheck = 0;
  var _speedTimer = setInterval(function () {
    if (window.__pipSpeed != null) {
      applyLocalSpeed(window.__pipSpeed);
    }
    _speedCheck++;
    if (_speedCheck >= 60) clearInterval(_speedTimer);
  }, 1000);
})();
