window.deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  window.deferredInstall = e;
  console.log('PWA install prompt has been saved.');
  if (typeof unityInstance !== 'undefined' && unityInstance != null) {
    unityInstance.SendMessage('PWAManager', 'OnPwaPromptAvailabilityChanged', window.deferredInstall ? "1" : "0");
  }
});

// Mobile fullscreen and viewport handling
(function () {
  const ua = navigator.userAgent || '';
  const isIOS = /iP(ad|hone|od)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);

  function enterFullscreen() {
    const canvas = document.getElementById('unity-canvas') || document.documentElement;
    // Prefer Unity's API when available
    if (typeof window.unityInstance !== 'undefined' && window.unityInstance && typeof window.unityInstance.SetFullscreen === 'function') {
      try { window.unityInstance.SetFullscreen(1); return; } catch (e) { /* fallback below */ }
    }
    const req = canvas.requestFullscreen || canvas.webkitRequestFullscreen || canvas.msRequestFullscreen || canvas.mozRequestFullScreen;
    if (req) {
      try { req.call(canvas); } catch (e) { console.warn('requestFullscreen failed:', e); }
    }
  }

  function setupAndroidAutoFullscreenOnGesture() {
    if (!isAndroid) return;
    // Create a transparent full-screen overlay button to guarantee a user gesture
    const overlayId = 'android-fs-overlay';
    if (document.getElementById(overlayId)) return;
    const overlay = document.createElement('button');
    overlay.id = overlayId;
    overlay.type = 'button';
    overlay.setAttribute('aria-label', 'Enter Fullscreen');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:transparent;border:0;margin:0;padding:0;width:100%;height:100%;opacity:0;touch-action:manipulation;';

    const onTap = () => {
      enterFullscreen();
      if (screen.orientation && screen.orientation.lock) {
        try { screen.orientation.lock('landscape'); } catch (_) {}
      }
      // Remove overlay after attempting fullscreen
      requestAnimationFrame(() => {
        overlay.remove();
      });
    };
    overlay.addEventListener('pointerdown', onTap, { once: true });
    overlay.addEventListener('click', onTap, { once: true });
    overlay.addEventListener('touchend', onTap, { once: true });

    document.addEventListener('DOMContentLoaded', () => {
      document.body.appendChild(overlay);
    });
  }

  function setupIOSDynamicViewportAndBarCollapse() {
    if (!isIOS) return;

    // Allow root scroll so Safari can collapse the URL bar.
    // Do not block touchmove anywhere.
    document.documentElement.style.overflowY = 'scroll';
    document.documentElement.style.webkitOverflowScrolling = 'touch';
    document.body.style.overflowY = 'visible';

    // Dynamic 1% viewport unit to handle iOS chrome changes
    const setVh = () => {
      const vh = window.innerHeight * 0.01;
      document.documentElement.style.setProperty('--vh', vh + 'px');
    };
    setVh();
    window.addEventListener('resize', setVh);
    if (window.visualViewport && typeof window.visualViewport.addEventListener === 'function') {
      window.visualViewport.addEventListener('resize', setVh);
    }
    document.addEventListener('visibilitychange', setVh);

    // Ensure extra scroll area exists at the bottom
    const ensureFiller = () => {
      let filler = document.getElementById('ios-filler');
      if (!filler) {
        filler = document.createElement('div');
        filler.id = 'ios-filler';
        filler.style.cssText = 'height:140px;width:1px;opacity:0;pointer-events:none;';
        document.body.appendChild(filler);
      }
    };
    ensureFiller();

    // Nudge scroll on load and retries to encourage bar collapse
    let nudgeCount = 0;
    const tryNudge = () => {
      ensureFiller();
      try { window.scrollTo(0, 1); } catch (e) {}
      nudgeCount++;
      if (nudgeCount < 5) setTimeout(tryNudge, 300);
    };
    window.addEventListener('load', () => setTimeout(tryNudge, 400));
    window.addEventListener('orientationchange', () => setTimeout(tryNudge, 400));
    window.addEventListener('resize', () => setTimeout(tryNudge, 400));
  }

  function applySizing() {
    const container = document.getElementById('unity-container');
    const canvas = document.getElementById('unity-canvas');
    if (!container || !canvas) return;
    // Prefer visualViewport to avoid initial 50% height bug on iOS
    if (window.visualViewport && typeof window.visualViewport.height === 'number') {
      container.style.height = window.visualViewport.height + 'px';
      canvas.style.height = '100%';
    } else {
      const vhVar = getComputedStyle(document.documentElement).getPropertyValue('--vh');
      if (vhVar) {
        const h = parseFloat(vhVar) * 100;
        container.style.height = h + 'px';
        canvas.style.height = '100%';
      }
    }
    container.style.width = '100%';
  }

  window.addEventListener('resize', applySizing);
  if (window.visualViewport && typeof window.visualViewport.addEventListener === 'function') {
    window.visualViewport.addEventListener('resize', applySizing);
  }
  document.addEventListener('DOMContentLoaded', applySizing);

  setupAndroidAutoFullscreenOnGesture();
  setupIOSDynamicViewportAndBarCollapse();
})();
