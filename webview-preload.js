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

  // ===== 无障碍强制点击：穿透透明遮罩 / 补偿被站点吞掉的按钮点击 =====
  // 模式：smart=智能穿透（默认，只处理"透明且无内容的拦截层"）
  //       force=强穿透（点击未落在交互链上时一律补偿重播）
  //       off=关闭
  // 思路参考：microsoft/vscode PR#76148（webview 吞鼠标事件的补偿重播）、
  // MDN pointer-events / elementFromPoint 穿透方案、强制点击类 userscript。
  var forceMode = 'smart';
  try {
    ipcRenderer.on('pip-force-click', function (_e, data) {
      var m = data && data.mode;
      if (m === 'smart' || m === 'force' || m === 'off') forceMode = m;
    });
  } catch (e) {}
  // 读取当前模式：优先主进程广播（覆盖 iframe），回退 preload 内置值
  function currentForceMode() {
    try { return window.__pipForceMode || forceMode; } catch (e) { return 'smart'; }
  }

  function a11yIsInteractive(el) {
    if (!el || el === document.documentElement || el === document.body) return false;
    var tag = el.tagName;
    if (tag === 'A' || tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' ||
        tag === 'TEXTAREA' || tag === 'OPTION' || tag === 'LABEL' || tag === 'SUMMARY' ||
        tag === 'VIDEO' || tag === 'AUDIO') return true;
    var role = el.getAttribute && el.getAttribute('role');
    if (role && /^(button|tab|menuitem|menuitemcheckbox|menuitemradio|option|checkbox|radio|switch|link)$/.test(role)) return true;
    if (el.hasAttribute && (el.hasAttribute('onclick') || el.hasAttribute('jsaction'))) return true;
    try { if (getComputedStyle(el).cursor === 'pointer') return true; } catch (e) {}
    return false;
  }

  // 取点击点下的元素栈（含 open shadow DOM 内部节点）
  function a11yStackAt(x, y) {
    var stack = [];
    try { stack = document.elementsFromPoint(x, y); } catch (e) { return stack; }
    for (var i = 0; i < stack.length; i++) {
      var node = stack[i], depth = 0;
      var root = node.shadowRoot;
      while (root && depth < 4) {
        try {
          var inner = root.elementFromPoint(x, y);
          if (!inner || inner === node) break;
          stack.push(inner);
          root = inner.shadowRoot;
        } catch (e) { break; }
        depth++;
      }
    }
    return stack;
  }

  // 对目标元素派发完整点击序列（pointerdown→mousedown→pointerup→mouseup→click）
  function a11yFire(el, x, y) {
    if (!el) return;
    var restored = null;
    try {
      if (el.disabled) { restored = { el: el, v: el.disabled }; el.disabled = false; }
      var opts = { bubbles: true, cancelable: true, composed: true, view: window,
                   clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: 1, detail: 1 };
      for (var i = 0; i < 5; i++) {
        var type = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'][i];
        var Ev = (type.indexOf('pointer') === 0 && window.PointerEvent) ? PointerEvent : MouseEvent;
        try { el.dispatchEvent(new Ev(type, opts)); } catch (e) {}
      }
    } catch (e) {}
    finally { try { if (restored) restored.el.disabled = restored.v; } catch (e) {} }
  }

  // 智能模式判定：顶层元素是否为"透明拦截层"
  function a11yBgAlpha(el) {
    try {
      var bg = getComputedStyle(el).backgroundColor || 'transparent';
      var m = bg.match(/rgba?\(([^)]+)\)/);
      if (!m) return bg === 'transparent' ? 0 : 1;
      var parts = m[1].split(',').map(parseFloat);
      return parts.length >= 4 ? parts[3] : 1;
    } catch (e) { return 1; }
  }
  function a11yIsBlocker(el) {
    if (!el || el === document.documentElement || el === document.body) return false;
    if (a11yIsInteractive(el)) return false;
    var tag = el.tagName;
    if (tag === 'VIDEO' || tag === 'CANVAS' || tag === 'IMG') return false;
    if ((el.textContent || '').trim() !== '') return false;   // 有文字的层不穿透（多为刻意弹窗）
    if (a11yBgAlpha(el) >= 0.2) return false;                  // 明显遮罩（黑色 backdrop 等）不穿透
    try {
      if (el.querySelector('a,button,input,select,textarea,[role=button],video,audio')) return false;
    } catch (e) {}
    return true;
  }

  // capture 注册在 preload 最早阶段，先于页面脚本，站点无法先于我们吞事件。
  // 注意：上面的链接拦截用的是 document capture，这里用 window capture，二者不冲突。
  // nodeIntegrationInSubFrames 开启后，本 preload 在 iframe 里同样运行，播放器 iframe 内也覆盖。
  window.addEventListener('click', function (e) {
    try {
      var mode = currentForceMode();
      if (mode === 'off' || !e.isTrusted || e.detail === 0) return; // 跳过键盘合成点击
      var x = e.clientX, y = e.clientY;
      var stack = a11yStackAt(x, y);
      if (!stack.length) return;
      var top = stack[0];
      var target = null;
      for (var i = 0; i < stack.length; i++) {
        if (a11yIsInteractive(stack[i])) { target = stack[i]; break; }
      }
      if (!target) return;

      if (mode === 'smart') {
        if (!a11yIsBlocker(top) || target === top) return;
        if (top.contains(target) || target.contains(top)) return;
        a11yFire(target, x, y);
        e.stopPropagation(); e.preventDefault(); // 阻断透明拦截层自身行为
        return;
      }

      // force：事件没落在交互链上（被挡/被吞）→ 补偿重播
      var normal = e.target === target || e.target.contains(target) || target.contains(e.target);
      if (!normal) a11yFire(target, x, y);
    } catch (err) {}
  }, true);
})();
