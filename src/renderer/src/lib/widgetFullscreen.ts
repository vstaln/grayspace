// Injected into every browser webview: sites that call requestFullscreen() must
// fill the widget, not promote the whole app window. Chromium's real fullscreen
// is blocked for guests here, so we emulate it inside the guest viewport.
//
// Emulating it means doing everything the real implementation does for the page:
//   - fill the viewport (and neutralise ancestors whose transform/filter/contain
//     would otherwise make position:fixed resolve against them instead),
//   - force the media element back to the container box, because players such as
//     YouTube letterbox their <video> with inline width/height/left/top computed
//     before the switch — stale values render as a black or stretched frame,
//   - fire fullscreenchange on the element (bubbling, like the real event) plus
//     window resize, so player layout code recomputes against the new box,
//   - answer the fullscreenElement / fullscreenEnabled queries players gate on,
//   - handle Escape ourselves, since no browser chrome does it for fake fullscreen.
export const WIDGET_FULLSCREEN_SCRIPT = String.raw`(() => {
  if (window.__orcWidgetFullscreen) return;
  window.__orcWidgetFullscreen = true;

  var FS = 'orc-widget-fullscreen';
  var ANC = 'orc-widget-fs-ancestor';
  var style = document.createElement('style');
  style.textContent = [
    '.' + FS + '{position:fixed!important;left:0!important;top:0!important;right:0!important;bottom:0!important;' +
      'width:100vw!important;height:100vh!important;min-width:0!important;min-height:0!important;' +
      'max-width:100vw!important;max-height:100vh!important;margin:0!important;padding:0!important;' +
      'border:0!important;border-radius:0!important;transform:none!important;' +
      'z-index:2147483647!important;background:#000!important}',
    '.' + FS + ' video,video.' + FS + ',.' + FS + ' .html5-main-video{position:absolute!important;' +
      'left:0!important;top:0!important;right:auto!important;bottom:auto!important;' +
      'width:100%!important;height:100%!important;max-width:100%!important;max-height:100%!important;' +
      'margin:0!important;transform:none!important;object-fit:contain!important}',
    '.' + FS + ' .html5-video-container,.' + FS + '.html5-video-player,.' + FS + ' .html5-video-player{' +
      'position:absolute!important;left:0!important;top:0!important;width:100%!important;height:100%!important}',
    '.' + ANC + '{transform:none!important;filter:none!important;-webkit-filter:none!important;' +
      'backdrop-filter:none!important;perspective:none!important;contain:none!important;' +
      'content-visibility:visible!important;will-change:auto!important;overflow:visible!important;' +
      'z-index:auto!important}'
  ].join('');
  (document.head || document.documentElement).appendChild(style);

  var active = null;
  var ancestors = [];
  var prevOverflow = '';

  var fire = function (target, names) {
    for (var i = 0; i < names.length; i++) {
      try { target.dispatchEvent(new Event(names[i], { bubbles: true })); } catch (e) {}
    }
  };
  var relayout = function () {
    var kick = function () { try { window.dispatchEvent(new Event('resize')); } catch (e) {} };
    kick();
    try { requestAnimationFrame(kick); } catch (e) {}
    setTimeout(kick, 60);
    setTimeout(kick, 250);
  };
  var changed = function (el) {
    fire(el, ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange']);
    if (!el.isConnected) fire(document, ['fullscreenchange', 'webkitfullscreenchange']);
    relayout();
  };

  var enter = function () {
    var el = this;
    if (!el || el === active) return Promise.resolve();
    if (active) release();
    active = el;
    el.classList.add(FS);
    for (var p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      p.classList.add(ANC);
      ancestors.push(p);
    }
    prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    changed(el);
    return Promise.resolve();
  };

  var release = function () {
    var el = active;
    active = null;
    if (el) el.classList.remove(FS);
    for (var i = 0; i < ancestors.length; i++) ancestors[i].classList.remove(ANC);
    ancestors = [];
    document.documentElement.style.overflow = prevOverflow;
    return el;
  };

  var exit = function () {
    var el = release();
    if (el) changed(el);
    return Promise.resolve();
  };

  Element.prototype.requestFullscreen = enter;
  Element.prototype.webkitRequestFullscreen = enter;
  Element.prototype.webkitRequestFullScreen = enter;
  Element.prototype.mozRequestFullScreen = enter;
  Element.prototype.msRequestFullscreen = enter;
  if (window.HTMLVideoElement) {
    HTMLVideoElement.prototype.webkitEnterFullscreen = enter;
    HTMLVideoElement.prototype.webkitEnterFullScreen = enter;
    HTMLVideoElement.prototype.webkitExitFullscreen = function () { return exit(); };
    HTMLVideoElement.prototype.webkitExitFullScreen = function () { return exit(); };
  }

  var defineGet = function (obj, prop, get) {
    try { Object.defineProperty(obj, prop, { configurable: true, get: get }); } catch (e) {}
  };
  var current = function () { return active; };
  defineGet(document, 'fullscreenElement', current);
  defineGet(document, 'webkitFullscreenElement', current);
  defineGet(document, 'mozFullScreenElement', current);
  defineGet(document, 'msFullscreenElement', current);
  defineGet(document, 'webkitCurrentFullScreenElement', current);
  var yes = function () { return true; };
  defineGet(document, 'fullscreenEnabled', yes);
  defineGet(document, 'webkitFullscreenEnabled', yes);
  defineGet(document, 'mozFullScreenEnabled', yes);
  defineGet(document, 'msFullscreenEnabled', yes);
  defineGet(document, 'webkitIsFullScreen', function () { return active !== null; });
  defineGet(document, 'mozFullScreen', function () { return active !== null; });

  document.exitFullscreen = exit;
  document.webkitExitFullscreen = exit;
  document.webkitCancelFullScreen = exit;
  document.mozCancelFullScreen = exit;
  document.msExitFullscreen = exit;

  // Nothing else can dismiss fake fullscreen, so own the Escape key while it is on.
  document.addEventListener('keydown', function (e) {
    if (active && (e.key === 'Escape' || e.keyCode === 27)) {
      e.stopPropagation();
      e.preventDefault();
      void exit();
    }
  }, true);
})();`
