// Microsoft Start (MSN) integration v7 with selective fallback

// Autoplay is allowed in the shell
window.auto_play = true;

// Load AdinPlay script directly for fallback (rewarded ads and 300x250 banners only)
let adinplayLoaded = false;
let adinplayLoadPromise = null;

// Wait for AdinPlay to be ready
window.waitForAdinPlay = function() {
  return new Promise((resolve) => {
    if (typeof aipDisplayTag !== "undefined") {
      resolve(true);
      return;
    }
    
    const timeoutId = setTimeout(() => {
      resolve(false);
    }, 1800);
    
    const checkInterval = setInterval(() => {
      if (typeof aipDisplayTag !== "undefined") {
        clearInterval(checkInterval);
        clearTimeout(timeoutId);
        resolve(true);
      }
    }, 100);
  });
};

function loadAdinplayFallback() {
  if (adinplayLoadPromise) return adinplayLoadPromise;
  
  adinplayLoadPromise = new Promise(async (resolve) => {
    if (adinplayLoaded) {
      resolve(true);
      return;
    }
    
    try {
      // First load the AdinPlay tag script
      await new Promise((tagResolve, tagReject) => {
        const tagScript = document.createElement('script');
        tagScript.src = '//api.adinplay.com/libs/aiptag/pub/LGP/poxel.io/tag.min.js';
        tagScript.async = true;
        tagScript.onload = tagResolve;
        tagScript.onerror = tagReject;
        document.head.appendChild(tagScript);
      });
      
      // Then load our adapter
      await new Promise((adapterResolve, adapterReject) => {
        const adapterScript = document.createElement('script');
        adapterScript.src = 'ads/adapters/adinplay-ads.js';
        adapterScript.async = true;
        adapterScript.onload = adapterResolve;
        adapterScript.onerror = adapterReject;
        document.head.appendChild(adapterScript);
      });
      
      // Wait for AdinPlay to be ready
      await window.waitForAdinPlay?.();
      
      adinplayLoaded = true;
      console.log('[msn_sdk.js] AdinPlay fallback fully loaded');
      resolve(true);
    } catch (e) {
      console.warn('[msn_sdk.js] AdinPlay fallback failed to load:', e);
      resolve(false);
    }
  });
  
  return adinplayLoadPromise;
}

// Load official MS Start SDK if available via CDN, expose a promise
const MSSTART_CDN = 'https://assets.msn.com/staticsb/statics/latest/msstart-games-sdk/msstart-v1.0.0-rc.20.min.js';
const msStartSdkPromise = new Promise((resolve) => {
  if (window.$msstart) {
    console.log('[msn_sdk.js] Found pre-injected $msstart');
    resolve(window.$msstart);
    return;
  }
  try {
    const s = document.createElement('script');
    s.src = MSSTART_CDN;
    s.async = true;
    s.onload = function() {
      console.log('[msn_sdk.js] MS Start SDK script loaded');
      resolve(window.$msstart || null);
    };
    s.onerror = function() {
      console.warn('[msn_sdk.js] MS Start SDK script failed to load');
      resolve(null);
    };
    document.head.appendChild(s);
  } catch (e) {
    console.warn('[msn_sdk.js] Failed to inject MS Start SDK script', e);
    resolve(null);
  }
  // Safety timeout
  setTimeout(() => {
    const present = !!window.$msstart;
    if (!present) console.warn('[msn_sdk.js] MS Start SDK load timeout (8s)');
    resolve(window.$msstart || null);
  }, 8000);
});

// Start preloading as soon as SDK is ready (guarded)
msStartSdkPromise.then(() => { startPreloadsIfNeeded(); });

// Cached ad instances (preloaded)
let _msnInterstitialAdInstance = null;
let _msnRewardedAdInstance = null;
let _msnPreloadStarted = false;
let _msnAdShowInProgress = false;

// Banner ad state
let _msnDisplayAdVisible = false;
let _msnLastBannerShowTime = 0;
const MSN_BANNER_COOLDOWN = 5000; // 5 second cooldown required by MSN

// Banner state tracking for debouncing
let _banner300x250State = { visible: false, position: 0 };
let _banner300x600State = { visible: false, position: 0 };
let _bannerDebounceTimer = null;

// Map Unity banner positions to MSN display ad placements (only for 300x250)
const UNITY_TO_MSN_POSITION = {
  2: 'topright:300x250',    // TopRight
  3: 'topleft:300x250',     // TopLeft
  5: 'bottomright:300x250', // BottomRight
  6: 'bottomleft:300x250',  // BottomLeft
  8: 'left:300x250',        // MiddleLeft
  9: 'right:300x250'        // MiddleRight
};

// Map Unity banner positions for 300x600
const UNITY_TO_MSN_POSITION_300x600 = {
  2: 'topright:300x600',    // TopRight
  3: 'topleft:300x600',     // TopLeft
  5: 'bottomright:300x600', // BottomRight
  6: 'bottomleft:300x600',  // BottomLeft
  8: 'left:300x600',        // MiddleLeft
  9: 'right:300x600'        // MiddleRight
};

function startPreloadsIfNeeded() {
  if (_msnPreloadStarted) return;
  _msnPreloadStarted = true;
  preloadInterstitialAd();
  preloadRewardedAd();
}

async function preloadInterstitialAd() {
  try {
    _msnInterstitialAdInstance = null;
    const sdk = await msStartSdkPromise;
    if (!sdk || typeof sdk.loadAdsAsync !== 'function') {
      console.warn('[msn_sdk.js] preloadInterstitialAd: loadAdsAsync not available');
      return;
    }
    const ad = await sdk.loadAdsAsync(false);
    _msnInterstitialAdInstance = ad;
    console.log('[msn_sdk.js] Interstitial ad preloaded');
  } catch (e) {
    console.error('[msn_sdk.js] Error preloading interstitial ad. Will retry in 20 seconds...', e);
    setTimeout(preloadInterstitialAd, 20000);
  }
}

async function preloadRewardedAd() {
  try {
    _msnRewardedAdInstance = null;
    const sdk = await msStartSdkPromise;
    if (!sdk || typeof sdk.loadAdsAsync !== 'function') {
      console.warn('[msn_sdk.js] preloadRewardedAd: loadAdsAsync not available');
      return;
    }
    const ad = await sdk.loadAdsAsync(true);
    _msnRewardedAdInstance = ad;
    console.log('[msn_sdk.js] Rewarded ad preloaded');
  } catch (e) {
    console.error('[msn_sdk.js] Error preloading rewarded ad. Will retry in 20 seconds...', e);
    setTimeout(preloadRewardedAd, 20000);
  }
}
// (Old host-provided object detection removed; we rely on $msstart directly)

// Helper to load an ad instance via official $msstart API
async function loadMsStartAd(kind /* 'interstitial' | 'rewarded' */) {
  console.log('[msn_sdk.js] loadMsStartAd begin:', kind);
  const sdk = await msStartSdkPromise;
  if (!sdk) {
    console.warn('[msn_sdk.js] $msstart SDK not available');
    return null;
  }
  if (typeof sdk.loadAdsAsync !== 'function') {
    console.warn('[msn_sdk.js] $msstart.loadAdsAsync is not a function');
    return null;
  }
  // Preferred signature per docs: boolean isRewardedAd
  try {
    if (kind === 'rewarded') {
      const ad = await sdk.loadAdsAsync(true);
      if (ad) { console.log('[msn_sdk.js] loadAdsAsync(true) returned ad'); return ad; }
    } else {
      const ad = await sdk.loadAdsAsync(false);
      if (ad) { console.log('[msn_sdk.js] loadAdsAsync(false) returned ad'); return ad; }
    }
  } catch (e) {
    // fall through to option candidates for older SDKs
    console.warn('[msn_sdk.js] loadAdsAsync(bool) threw, trying legacy option objects:', e?.message || e);
  }
  const optCandidates = [
    { adUnitType: kind },
    { adFormat: kind },
    { adPlacement: kind },
    { type: kind },
    { adUnitType: kind?.toUpperCase?.() },
    { adFormat: kind?.toUpperCase?.() },
    undefined
  ];
  for (let i = 0; i < optCandidates.length; i++) {
    try {
      const opt = optCandidates[i];
      const ad = await sdk.loadAdsAsync(opt);
      if (ad) { console.log('[msn_sdk.js] loadAdsAsync(opt) returned ad with opt:', opt); return ad; }
    } catch (e) {
      // try next option shape
      console.warn('[msn_sdk.js] loadAdsAsync(opt) failed for opt:', optCandidates[i], e?.message || e);
    }
  }
  return null;
}

async function showMsStartAdInstance(ad) {
  const sdk = await msStartSdkPromise;
  if (!sdk) { console.warn('[msn_sdk.js] showMsStartAdInstance: $msstart not available'); return false; }
  if (!ad)  { console.warn('[msn_sdk.js] showMsStartAdInstance: ad is null'); return false; }
  const instanceId = ad.instanceId || ad.id || ad;
  try {
    if (typeof sdk.showAdsAsync !== 'function') {
      console.warn('[msn_sdk.js] showMsStartAdInstance: showAdsAsync not available');
      return false;
    }
    const shownInstance = await sdk.showAdsAsync(instanceId);
    if (!shownInstance || !shownInstance.showAdsCompletedAsync || typeof shownInstance.showAdsCompletedAsync.then !== 'function') {
      console.warn('[msn_sdk.js] showMsStartAdInstance: completion promise missing');
      return false;
    }
    await shownInstance.showAdsCompletedAsync; // wait for completion before granting
    console.log('[msn_sdk.js] showMsStartAdInstance OK');
    return true;
  } catch (e) {
    console.warn('[msn_sdk.js] showMsStartAdInstance error', e);
    return false;
  }
}

// (Message-based fallback removed)

async function showMsStartInterstitial() {
  if (_msnAdShowInProgress) {
    console.warn('[msn_sdk.js] Ad show already in progress, ignoring interstitial request');
    return false;
  }
  _msnAdShowInProgress = true;
  try {
    if (_msnInterstitialAdInstance) {
      const ok = await showMsStartAdInstance(_msnInterstitialAdInstance);
      // Always try to reload the instance after show attempt
      preloadInterstitialAd();
      if (ok) { console.log('[msn_sdk.js] Interstitial shown via cached instance'); return true; }
      return false;
    }
    console.warn('[msn_sdk.js] Interstitial not ready: no cached instance');
    return false;
  } finally {
    _msnAdShowInProgress = false;
  }
}

async function showMsStartRewarded() {
  if (_msnAdShowInProgress) {
    console.warn('[msn_sdk.js] Ad show already in progress, ignoring rewarded request');
    return false;
  }
  _msnAdShowInProgress = true;
  try {
    if (_msnRewardedAdInstance) {
      const ok = await showMsStartAdInstance(_msnRewardedAdInstance);
      // Always try to reload the instance after show attempt
      preloadRewardedAd();
      if (ok) { console.log('[msn_sdk.js] Rewarded shown via cached instance'); return true; }
      return false;
    }
    console.warn('[msn_sdk.js] Rewarded not ready: no cached instance');
    return false;
  } finally {
    _msnAdShowInProgress = false;
  }
}

// Helper function to show MSN display ad
async function showMsnDisplayAd(placement, bannerType, bannerPosition) {
  try {
    // Check cooldown
    const now = Date.now();
    const timeSinceLastShow = now - _msnLastBannerShowTime;
    if (timeSinceLastShow < MSN_BANNER_COOLDOWN) {
      const waitTime = MSN_BANNER_COOLDOWN - timeSinceLastShow;
      console.log(`[msn_sdk.js] Waiting ${waitTime}ms for MSN banner cooldown`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    // Hide existing ad if visible
    if (_msnDisplayAdVisible) {
      await hideMsnDisplayAd();
      // Wait a bit after hiding
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const sdk = await msStartSdkPromise;
    if (!sdk || typeof sdk.showDisplayAdsAsync !== 'function') {
      console.warn('[msn_sdk.js] MSN showDisplayAdsAsync not available, trying AdinPlay fallback');
      // Fallback to AdinPlay for 300x250
      await showAdinplayBannerFallback(bannerType, bannerPosition);
      return;
    }

    console.log(`[msn_sdk.js] Showing MSN display ad: ${placement}`);
    const response = await sdk.showDisplayAdsAsync([placement]);
    
    if (response) {
      console.log(`[msn_sdk.js] MSN display ad shown successfully: ${placement}`);
      _msnDisplayAdVisible = true;
      _msnLastBannerShowTime = Date.now();
    } else {
      throw new Error('showDisplayAdsAsync returned falsy response');
    }
  } catch (error) {
    console.warn('[msn_sdk.js] Failed to show MSN display ad:', error);
    // Fallback to AdinPlay for 300x250
    console.log('[msn_sdk.js] Falling back to AdinPlay for banner');
    await showAdinplayBannerFallback(bannerType, bannerPosition);
  }
}

// Helper function to hide MSN display ad
async function hideMsnDisplayAd() {
  if (!_msnDisplayAdVisible) {
    return;
  }

  try {
    const sdk = await msStartSdkPromise;
    if (sdk && typeof sdk.hideDisplayAdsAsync === 'function') {
      console.log('[msn_sdk.js] Hiding MSN display ad');
      await sdk.hideDisplayAdsAsync();
      _msnDisplayAdVisible = false;
    }
  } catch (error) {
    console.warn('[msn_sdk.js] Failed to hide MSN display ad:', error);
    _msnDisplayAdVisible = false;
  }
}

// AdinPlay fallback functions
async function tryAdinplayRewardedFallback() {
  try {
    const loaded = await loadAdinplayFallback();
    if (!loaded || !window.videoAdProviders?.adinplay) {
      console.warn('[msn_sdk.js] AdinPlay not available for rewarded fallback');
      if (typeof unityInstance !== 'undefined' && unityInstance) {
        unityInstance.SendMessage('SDKManager', 'OnVideoAdEnded', 'false');
      }
      return;
    }
    
    window.videoAdProviders.adinplay.showRewarded(
      function() {
        // Success callback
        if (typeof unityInstance !== 'undefined' && unityInstance) {
          unityInstance.SendMessage('SDKManager', 'OnVideoAdEnded', 'true');
        }
      },
      function() {
        // Failure callback
        if (typeof unityInstance !== 'undefined' && unityInstance) {
          unityInstance.SendMessage('SDKManager', 'OnVideoAdEnded', 'false');
        }
      }
    );
  } catch (e) {
    console.error('[msn_sdk.js] AdinPlay rewarded fallback error:', e);
    if (typeof unityInstance !== 'undefined' && unityInstance) {
      unityInstance.SendMessage('SDKManager', 'OnVideoAdEnded', 'false');
    }
  }
}

// AdinPlay banner state
let _adinplayBannerVisible = false;
let _adinplayBannerContainer = null;

async function showAdinplayBannerFallback(bannerType, bannerPosition) {
  try {
    // Hide existing AdinPlay banner if visible
    if (_adinplayBannerVisible && _adinplayBannerContainer) {
      _adinplayBannerContainer.style.display = 'none';
      _adinplayBannerVisible = false;
    }
    
    // If hiding (position 0), we're done
    if (bannerPosition === 0) {
      return;
    }
    
    const loaded = await loadAdinplayFallback();
    if (!loaded || !window.bannerAdProviders?.adinplay) {
      console.warn('[msn_sdk.js] AdinPlay not available for banner fallback');
      return;
    }
    
    // Create container if doesn't exist
    if (!_adinplayBannerContainer) {
      _adinplayBannerContainer = document.createElement('div');
      _adinplayBannerContainer.className = 'banner-container';
      _adinplayBannerContainer.id = 'msn_fallback_banner_300x250';
      _adinplayBannerContainer.style.position = 'absolute';
      _adinplayBannerContainer.style.zIndex = 1000;
      _adinplayBannerContainer.style.width = '300px';
      _adinplayBannerContainer.style.height = '250px';
      _adinplayBannerContainer.style.backgroundColor = 'rgba(255, 255, 255, 0.2)';
      
      const bannerDiv = document.createElement('div');
      bannerDiv.id = '300x250';
      bannerDiv.style.width = '300px';
      bannerDiv.style.height = '250px';
      _adinplayBannerContainer.appendChild(bannerDiv);
      
      document.body.appendChild(_adinplayBannerContainer);
    }
    
    // Update position
    updateBannerPosition(_adinplayBannerContainer, bannerPosition);
    _adinplayBannerContainer.style.display = 'block';
    
    // Display the ad via AdinPlay - pass bannerType (0) instead of '300x250' string
    const success = await window.bannerAdProviders.adinplay.displayBanner(bannerType, _adinplayBannerContainer);
    
    if (success) {
      console.log('[msn_sdk.js] AdinPlay fallback banner shown successfully');
      _adinplayBannerVisible = true;
    } else {
      console.warn('[msn_sdk.js] AdinPlay fallback banner failed');
      _adinplayBannerContainer.style.display = 'none';
    }
  } catch (e) {
    console.error('[msn_sdk.js] AdinPlay banner fallback error:', e);
  }
}

// Helper to position banner container
function updateBannerPosition(container, position) {
  container.style.top = '';
  container.style.right = '';
  container.style.bottom = '';
  container.style.left = '';
  container.style.margin = '';
  container.style.marginLeft = '';
  container.style.marginRight = '';
  
  switch (position) {
    case 1: // TopCenter
      container.style.top = '1%';
      container.style.left = '0';
      container.style.right = '0';
      container.style.marginLeft = 'auto';
      container.style.marginRight = 'auto';
      break;
    case 2: // TopRight
      container.style.top = '1%';
      container.style.right = '1%';
      break;
    case 3: // TopLeft
      container.style.top = '1%';
      container.style.left = '1%';
      break;
    case 4: // BottomCenter
      container.style.bottom = '0.5%';
      container.style.left = '0';
      container.style.right = '0';
      container.style.marginLeft = 'auto';
      container.style.marginRight = 'auto';
      break;
    case 5: // BottomRight
      container.style.bottom = '1%';
      container.style.right = '1%';
      break;
    case 6: // BottomLeft
      container.style.bottom = '1%';
      container.style.left = '1%';
      break;
    case 7: // MiddleCenter
      container.style.top = '0';
      container.style.bottom = '0';
      container.style.left = '0';
      container.style.right = '0';
      container.style.margin = 'auto';
      break;
    case 8: // MiddleLeft
      container.style.left = '1%';
      container.style.top = '0';
      container.style.bottom = '0';
      container.style.margin = 'auto';
      break;
    case 9: // MiddleRight
      container.style.right = '1%';
      container.style.top = '0';
      container.style.bottom = '0';
      container.style.margin = 'auto';
      break;
    case 10: // BelowTopLeft
      container.style.left = '1%';
      container.style.top = '14%';
      break;
    case 11: // BelowTopRight
      container.style.top = '10%';
      container.style.right = '1%';
      break;
    default:
      // Unsupported position, hide
      container.style.display = 'none';
      break;
  }
}

// (Timeout guard removed for simplicity)

// Process banner placement after debounce
async function processBannerPlacement() {
  console.log('[msn_sdk.js] Processing banner placement after debounce...');
  console.log('[msn_sdk.js] 300x250 state:', _banner300x250State);
  console.log('[msn_sdk.js] 300x600 state:', _banner300x600State);

  // If both are hidden, hide MSN ad
  if (!_banner300x250State.visible && !_banner300x600State.visible) {
    console.log('[msn_sdk.js] Both banners hidden, hiding MSN ad');
    await hideMsnDisplayAd();
    return;
  }

  // If 300x250 is visible, place MSN ad in 300x250 slot (normal behavior)
  if (_banner300x250State.visible) {
    const position = _banner300x250State.position;
    const msnPlacement = UNITY_TO_MSN_POSITION[position];
    
    if (msnPlacement) {
      console.log('[msn_sdk.js] 300x250 visible, placing MSN 300x250 ad in 300x250 slot:', msnPlacement);
      await showMsnDisplayAd(msnPlacement, 0, position);
    } else {
      // Position not supported by MSN, try AdinPlay fallback
      console.log('[msn_sdk.js] 300x250 position', position, 'not supported by MSN, trying AdinPlay fallback');
      await showAdinplayBannerFallback(0, position);
    }
    return;
  }

  // If 300x250 is hidden but 300x600 is visible, try to place MSN 300x250 ad in 300x600 slot
  if (!_banner300x250State.visible && _banner300x600State.visible) {
    const position = _banner300x600State.position;
    const msnPlacement300x600 = UNITY_TO_MSN_POSITION_300x600[position];
    
    if (msnPlacement300x600) {
      console.log('[msn_sdk.js] 300x250 hidden but 300x600 visible, placing MSN 300x250 ad in 300x600 slot:', msnPlacement300x600);
      await showMsnDisplayAd(msnPlacement300x600, 2, position);
    } else {
      // Position not supported, try AdinPlay fallback for 300x600 position
      console.log('[msn_sdk.js] 300x600 position', position, 'not supported by MSN, trying AdinPlay fallback');
      await showAdinplayBannerFallback(0, position);
    }
    return;
  }
}

let loadingStartSent = false;

// Create MSN SDK implementation
window.SDK = {
  gameplayStart() {
    console.log('[msn_sdk.js] Gameplay started');
  },
  loadingStart() {
    if (loadingStartSent) return;
    loadingStartSent = true;
    console.log('[msn_sdk.js] Loading started');
  },
  loadingEnd() {
    console.log('[msn_sdk.js] Loading finished');
    // Kick off initial ad preloads once loading is finished (guarded)
    startPreloadsIfNeeded();
  },
  gameplayEnd() {
    console.log('[msn_sdk.js] Gameplay ended');
  },
  async showMidroll() {
    try {
      console.log('[msn_sdk.js] SDK.showMidroll() called');
      const ok = await showMsStartInterstitial();
      console.log('[msn_sdk.js] SDK.showMidroll() completed with ok=', ok);
      
      if (ok) {
        // MSN ad shown successfully
        if (typeof unityInstance !== 'undefined' && unityInstance) {
          unityInstance.SendMessage('SDKManager', 'OnVideoAdEnded', 'true');
        }
      } else {
        // MSN failed, NO fallback for midroll (as requested)
        console.log('[msn_sdk.js] MSN interstitial failed, no fallback');
        if (typeof unityInstance !== 'undefined' && unityInstance) {
          unityInstance.SendMessage('SDKManager', 'OnVideoAdEnded', 'false');
        }
      }
    } catch (e) {
      console.warn('[msn_sdk.js] showMidroll error:', e);
      // Try fallback on error - NO fallback for midroll
      console.log('[msn_sdk.js] MSN midroll error, no fallback');
      if (typeof unityInstance !== 'undefined' && unityInstance) {
        unityInstance.SendMessage('SDKManager', 'OnVideoAdEnded', 'false');
      }
    }
  },
  async showRewarded() {
    try {
      console.log('[msn_sdk.js] SDK.showRewarded() called');
      const ok = await showMsStartRewarded();
      console.log('[msn_sdk.js] SDK.showRewarded() completed with ok=', ok);
      
      if (ok) {
        // MSN ad shown successfully
        if (typeof unityInstance !== 'undefined' && unityInstance) {
          unityInstance.SendMessage('SDKManager', 'OnVideoAdEnded', 'true');
        }
      } else {
        // MSN failed, try AdinPlay fallback for rewarded
        console.log('[msn_sdk.js] MSN rewarded failed, trying AdinPlay fallback');
        await tryAdinplayRewardedFallback();
      }
    } catch (e) {
      console.warn('[msn_sdk.js] showRewarded error:', e);
      // Try fallback on error
      console.log('[msn_sdk.js] MSN rewarded error, trying AdinPlay fallback');
      await tryAdinplayRewardedFallback();
    }
  },
  // Build/asset paths and rendering scale
  getBuildURL() {
    return 'Build';
  },
  getStreamingAssetsUrl() {
    return '/StreamingAssets';
  },
  getStaticResolutionScaleMulti() {
    return 1.0;
  },
    async SetBanner(bannerType, bannerPosition) {
      // Accept both 300x250 (type 0) and 300x600 (type 2)
      if (bannerType !== 0 && bannerType !== 2) {
        console.log('[msn_sdk.js] Ignoring unsupported banner type:', bannerType);
        return;
      }

      // Update state immediately based on banner type
      if (bannerType === 0) {
        // 300x250 state
        _banner300x250State.visible = bannerPosition !== 0;
        _banner300x250State.position = bannerPosition;
        console.log('[msn_sdk.js] 300x250 state updated:', _banner300x250State);
      } else if (bannerType === 2) {
        // 300x600 state
        _banner300x600State.visible = bannerPosition !== 0;
        _banner300x600State.position = bannerPosition;
        console.log('[msn_sdk.js] 300x600 state updated:', _banner300x600State);
      }

      // Clear existing debounce timer
      if (_bannerDebounceTimer) {
        clearTimeout(_bannerDebounceTimer);
      }

      // Debounce: wait 0.1s before placing ad
      _bannerDebounceTimer = setTimeout(async () => {
        await processBannerPlacement();
      }, 100);
    }
};

