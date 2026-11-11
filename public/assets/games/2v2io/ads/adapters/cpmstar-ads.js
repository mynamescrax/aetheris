// CPMStar Ad Provider Module
// This module handles all CPMStar-specific ad functionality

(function() {
    console.log("[cpmstar-ads.js] Module loading...");
    
    // Ensure global providers exist
    window.videoAdProviders = window.videoAdProviders || {};
    window.bannerAdProviders = window.bannerAdProviders || {};
    
    // CPMStar configuration
    const CPMSTAR_ZONE_FILE = '1137_54105_gameapi';
    
    // CPMStar banner placement IDs (replace with your actual placement IDs)
    window.cpmstarBannerMapping = {
        0: '88824', // 300x250
        1: '88823', // 728x90
        2: '88827'  // 300x600
    };
    
    // CPMStar state
    let cpmstarRewardedVideo = null;
    let cpmstarInitialized = false;
    
    // Initialize CPMStar for video ads
    function initCpmstarVideo() {
        console.log("[cpmstar-ads.js] Initializing CPMStar video ads...");
        
        (function (zonefile) {
            var y = "cpmstarx";
            var drutObj = window[y] = window[y] || {};
            function failCpmstarAPI() {
                var failFn = function (o) { o && typeof (o) === "object" && o.fail && o.fail(); };
                drutObj && Array.isArray(drutObj.cmd) && drutObj.cmd.forEach(failFn) && (drutObj.cmd.length = 0);
                window.cpmstarAPI = window["_" + zonefile] = failFn;
            }
            var rnd = Math.round(Math.random() * 999999);
            var s = document.createElement('script');
            s.type = 'text/javascript';
            s.async = true;
            s.onerror = failCpmstarAPI;
            s.onload = initCpmstarAPI;
            var proto = document.location.protocol;
            var host = (proto == "https:" || proto == "file:") ? "https://server" : "//cdn";
            if (window.location.hash == "#cpmstarDev") host = "//dev.server";
            if (window.location.hash == "#cpmstarStaging") host = "//staging.server";
            s.src = host + ".cpmstar.com/cached/zonefiles/" + zonefile + ".js?rnd=" + rnd;
            var s2 = document.getElementsByTagName('script')[0];
            s2.parentNode.insertBefore(s, s2);
            window.cpmstarAPI = function (o) { (drutObj.cmd = drutObj.cmd || []).push(o); }
        })(CPMSTAR_ZONE_FILE);
    }
    
    function initCpmstarAPI() {
        console.log("[cpmstar-ads.js] CPMStar API callback");
        
        if (typeof cpmstarAPI !== 'undefined') {
            cpmstarAPI(function(api) {
                console.log("[cpmstar-ads.js] Setting up CPMStar...");
                
                // Set target for game ads
                api.game.setTarget(document.body);
                
                // Initialize interstitial ad
                cpmstarAPI({
                    kind: "game.createInterstitial",
                    onAdOpened: function () {
                        console.log("[cpmstar-ads.js] Interstitial opened");
                    },
                    onAdClosed: function () {
                        console.log("[cpmstar-ads.js] Interstitial closed");
                    },
                    fail: function () {
                        console.log("[cpmstar-ads.js] Interstitial failed");
                        window.adblocked = true;
                    }
                });
                
                // Initialize rewarded video
                cpmstarRewardedVideo = new api.game.RewardedVideoView("rewardedvideo");
                
                cpmstarRewardedVideo.addEventListener("ad_opened", function(e) {
                    console.log("[cpmstar-ads.js] Rewarded video opened");
                });
                
                cpmstarRewardedVideo.addEventListener("ad_closed", function(e) {
                    console.log("[cpmstar-ads.js] Rewarded video closed");
                    if (window._cpmstarTempSuccess) {
                        window._cpmstarTempSuccess();
                        delete window._cpmstarTempSuccess;
                        delete window._cpmstarTempFailure;
                    } else if (typeof unityInstance !== 'undefined') {
                        unityInstance.SendMessage("SDKManager", "OnVideoAdEnded", "true");
                    }
                    // Preload another ad
                    setTimeout(function() {
                        cpmstarRewardedVideo.load();
                    }, 700);
                });
                
                cpmstarRewardedVideo.addEventListener("loaded", function(e) {
                    console.log("[cpmstar-ads.js] Rewarded video loaded");
                });
                
                cpmstarRewardedVideo.addEventListener("load_failed", function(e) {
                    console.log("[cpmstar-ads.js] Rewarded video failed to load");
                });
                
                // Preload first rewarded video
                cpmstarRewardedVideo.load();
                cpmstarInitialized = true;
                console.log("[cpmstar-ads.js] Initialization complete");
            });
        }
    }
    
    // Helper function to trigger CPMStar banner
    function triggerCpmstarBanner(placementId, element) {
        console.log(`[cpmstar-ads.js] Triggering banner for placement ID: ${placementId}`);
        
        if (typeof window.cpmstarx === 'undefined') {
            window.cpmstarx = {};
        }
        
        if (!window.cpmstarx.libcmd) {
            window.cpmstarx.libcmd = [];
        }
        
        // Find all elements with this class and get the last one
        const els = document.getElementsByClassName(`div-${placementId}`);
        const pindex = els.length - 1;
        const el = els[pindex];
        
        console.log(`[cpmstar-ads.js] Elements found: ${els.length}, using index: ${pindex}`);
        
        // Push the banner command
        window.cpmstarx.libcmd.push({
            kind: 'asynctagfetch',
            el: el,
            pid: placementId,
            pindex: pindex
        });
        
        console.log(`[cpmstar-ads.js] Banner command queued`);
    }
    
    // Video ad provider implementation
    window.videoAdProviders.cpmstar = {
        showMidroll: function(onSuccess, onFailure) {
            console.log(`[cpmstar-ads.js] showMidroll called`);
            
            if (typeof cpmstarAPI !== 'undefined') {
                cpmstarAPI({
                    kind: "game.displayInterstitial",
                    onAdOpened: function () {
                        console.log(`[cpmstar-ads.js] Midroll opened`);
                    },
                    onAdClosed: function () {
                        console.log(`[cpmstar-ads.js] Midroll closed`);
                        onSuccess();
                    },
                    fail: function () {
                        console.log(`[cpmstar-ads.js] Midroll failed`);
                        onFailure();
                    }
                });
            } else {
                console.log(`[cpmstar-ads.js] API not available`);
                onFailure();
            }
        },
        showRewarded: function(onSuccess, onFailure) {
            console.log(`[cpmstar-ads.js] showRewarded called`);
            
            if (cpmstarRewardedVideo && cpmstarRewardedVideo.isLoaded()) {
                window._cpmstarTempSuccess = onSuccess;
                window._cpmstarTempFailure = onFailure;
                cpmstarRewardedVideo.show();
            } else if (cpmstarRewardedVideo) {
                console.log(`[cpmstar-ads.js] Rewarded video not loaded`);
                cpmstarRewardedVideo.load();
                onFailure();
            } else {
                console.log(`[cpmstar-ads.js] Rewarded video not initialized`);
                onFailure();
            }
        }
    };
    
    // Banner ad provider implementation
    window.bannerAdProviders.cpmstar = {
        displayBanner: async function(bannerType, container) {
            const placementId = window.cpmstarBannerMapping[bannerType];
            console.log(`[cpmstar-ads.js] displayBanner for type: ${bannerType}, placement ID: ${placementId}`);
            
            if (!placementId) {
                console.log(`[cpmstar-ads.js] No placement ID for banner type ${bannerType}`);
                return false;
            }
            
            // Get dimensions from global bannerDimensions
            const dims = window.bannerDimensions[bannerType];
            if (!dims) {
                console.log(`[cpmstar-ads.js] No dimensions for banner type ${bannerType}`);
                return false;
            }
            
            // Create CPMStar banner container
            const cpmstarDiv = document.createElement('div');
            cpmstarDiv.className = `div-${placementId}`;
            cpmstarDiv.style.width = dims.width;
            cpmstarDiv.style.height = dims.height;
            cpmstarDiv.style.position = 'relative';
            cpmstarDiv.style.display = 'block';
            
            // Clear existing content and add CPMStar div
            container.innerHTML = '';
            container.appendChild(cpmstarDiv);
            
            // Observe for creative injection
            const success = await new Promise((resolve) => {
                let settled = false;
                const settle = (ok) => { if (!settled) { settled = true; resolve(ok); } };
                
                const observer = new MutationObserver(() => {
                    const hasCreative = cpmstarDiv.querySelector('iframe, img, ins, div');
                    if (hasCreative && cpmstarDiv.children.length > 0) {
                        observer.disconnect();
                        settle(true);
                    }
                });
                try {
                    observer.observe(cpmstarDiv, { childList: true, subtree: true });
                } catch {}

                const timeoutMs = 3000;
                const timeoutId = setTimeout(() => {
                    observer.disconnect();
                    const ok = cpmstarDiv.children.length > 0;
                    settle(ok);
                }, timeoutMs);

                // Load CPMStar banner script if not already loaded
                if (!window.cpmstarBannerScriptLoaded) {
                    console.log(`[cpmstar-ads.js] Loading banner script`);
                    const script = document.createElement('script');
                    script.async = true;
                    script.src = 'https://ssl.cdne.cpmstar.com/cached/js/lib.js';
                    script.onload = function() {
                        console.log(`[cpmstar-ads.js] Banner script loaded`);
                        window.cpmstarBannerScriptLoaded = true;
                        try {
                            triggerCpmstarBanner(placementId, cpmstarDiv);
                        } catch (e) {
                            clearTimeout(timeoutId);
                            observer.disconnect();
                            settle(false);
                        }
                    };
                    script.onerror = function() {
                        console.log(`[cpmstar-ads.js] Failed to load banner script`);
                        clearTimeout(timeoutId);
                        observer.disconnect();
                        settle(false);
                    };
                    document.head.appendChild(script);
                } else {
                    try {
                        triggerCpmstarBanner(placementId, cpmstarDiv);
                    } catch (e) {
                        clearTimeout(timeoutId);
                        observer.disconnect();
                        settle(false);
                    }
                }
            });

            return success;
        }
    };
    
    // Initialize CPMStar video ads
    initCpmstarVideo();
    
    // Ensure CPMStar API is initialized when available
    if (typeof cpmstarAPI !== 'undefined') {
        initCpmstarAPI();
    } else {
        var checkInterval = setInterval(function () {
            if (typeof cpmstarAPI !== 'undefined') {
                clearInterval(checkInterval);
                initCpmstarAPI();
            }
        }, 100);
    }
    
    console.log("[cpmstar-ads.js] Module loaded successfully");
})();
