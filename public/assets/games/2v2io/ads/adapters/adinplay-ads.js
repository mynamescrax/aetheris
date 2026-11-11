// AdinPlay Ad Provider Module
// This module handles all AdinPlay-specific ad functionality

(function() {
    console.log("[adinplay-ads.js] Module loading...");
    
    // AdinPlay tag mapping - can be customized per game
    const ADINPLAY_TAG_MAPPING = {
        "300x250": "2v2-io_300x250",
        "728x90": "2v2-io_728x90", 
        "300x600": "2v2-io_300x600"
    };
    
    // Ensure global providers exist
    window.videoAdProviders = window.videoAdProviders || {};
    window.bannerAdProviders = window.bannerAdProviders || {};
    
    // AdinPlay initialization
    function initAdinPlay() {
        console.log("[adinplay-ads.js] Initializing AdinPlay...");
        
        window.aiptag = window.aiptag || { cmd: [] };
        aiptag.cmd.display = aiptag.cmd.display || [];
        aiptag.cmd.player = aiptag.cmd.player || [];
        aiptag.cmp = {
            show: true,
            position: "bottom",
            button: false,
            buttonText: "Privacy settings",
            buttonPosition: "bottom-left"
        };
        
        // aiptag.pageProtect = true;
        
        aiptag.cmd.player.push(function () {
            console.log("[adinplay-ads.js] Creating AdinPlay player...");
            aiptag.adplayer = new aipPlayer({
                AD_WIDTH: 960,
                AD_HEIGHT: 540,
                AD_DISPLAY: 'fullscreen',
                LOADING_TEXT: 'Loading advertisement',
                PREROLL_ELEM: function () { 
                    const elem = document.getElementById('videoad');
                    console.log(`[adinplay-ads.js] Preroll element: ${elem ? 'found' : 'not found'}`);
                    return elem;
                },
                AIP_COMPLETE: function (state) {
                    console.log(`[adinplay-ads.js] Video Ad Completed: ${state}`);
                    
                    const lowerCaseState = state.toLowerCase();
                    const isFailure = lowerCaseState.includes("adblock") ||
                        lowerCaseState.includes("failed") ||
                        lowerCaseState.includes("empty") ||
                        lowerCaseState.includes("error");
                    
                    if (isFailure) {
                        console.log("[adinplay-ads.js] Ad failed");
                        if (window._adinplayTempFailure) {
                            window._adinplayTempFailure();
                            delete window._adinplayTempFailure;
                            delete window._adinplayTempSuccess;
                        } else if (typeof unityInstance !== 'undefined') {
                            unityInstance.SendMessage("SDKManager", "OnVideoAdEnded", "false");
                        }
                    } else {
                        console.log("[adinplay-ads.js] Ad succeeded");
                        if (window._adinplayTempSuccess) {
                            window._adinplayTempSuccess();
                            delete window._adinplayTempSuccess;
                            delete window._adinplayTempFailure;
                        } else if (typeof unityInstance !== 'undefined') {
                            unityInstance.SendMessage("SDKManager", "OnVideoAdEnded", "true");
                        }
                    }
                }
            });
            console.log("[adinplay-ads.js] AdinPlay player created");
        });
        
        // Load the AdinPlay script
        console.log("[adinplay-ads.js] Loading AdinPlay script...");
        const adinplayScript = document.createElement('script');
        adinplayScript.type = "text/javascript";
        adinplayScript.src = '//api.adinplay.com/libs/aiptag/pub/LGP/2v2.io/tag.min.js';
        adinplayScript.async = true;
        adinplayScript.onload = function() {
            console.log("[adinplay-ads.js] Script loaded successfully");
        };
        adinplayScript.onerror = function() {
            console.error("[adinplay-ads.js] Failed to load script");
        };
        document.head.appendChild(adinplayScript);
    }
    
    // Video ad provider implementation
    window.videoAdProviders.adinplay = {
        showMidroll: function(onSuccess, onFailure) {
            console.log(`[adinplay-ads.js] showMidroll called`);
            
            if (typeof aiptag !== 'undefined' && typeof aiptag.adplayer !== 'undefined') {
                window._adinplayTempSuccess = onSuccess;
                window._adinplayTempFailure = onFailure;
                
                aiptag.cmd.player.push(function () {
                    console.log(`[adinplay-ads.js] Starting preroll`);
                    aiptag.adplayer.startPreRoll();
                });
            } else {
                console.log(`[adinplay-ads.js] API not available`);
                onFailure();
            }
        },
        showRewarded: function(onSuccess, onFailure) {
            console.log(`[adinplay-ads.js] showRewarded called (delegates to showMidroll)`);
            this.showMidroll(onSuccess, onFailure);
        }
    };
    
    // Banner ad provider implementation
    window.bannerAdProviders.adinplay = {
        displayBanner: async function(adTag, container) {
            console.log(`[adinplay-ads.js] displayBanner for tag: ${adTag}`);

            // Map generic adTag to AdinPlay-specific tag
            const adinplayTag = ADINPLAY_TAG_MAPPING[adTag];
            if (!adinplayTag) {
                console.error(`[adinplay-ads.js] No mapping found for adTag: ${adTag}`);
                return false;
            }
            console.log(`[adinplay-ads.js] Using AdinPlay tag: ${adinplayTag}`);

            // Ensure our container has a proper placeholder element for AdinPlay
            try {
                // Remove any existing placeholder with the same id elsewhere
                const existing = document.getElementById(adinplayTag);
                if (existing && existing.parentNode) {
                    existing.parentNode.removeChild(existing);
                }
            } catch (e) {
                // ignore
            }

            // Clear and prepare container
            container.innerHTML = "";
            const placeholder = document.createElement('div');
            placeholder.id = adinplayTag;
            placeholder.style.width = '100%';
            placeholder.style.height = '100%';
            placeholder.style.position = 'relative';
            container.appendChild(placeholder);

            // Wait for AdinPlay to be ready
            const isReady = await window.waitForAdinPlay();

            if (!(isReady && typeof aiptag !== "undefined" && typeof aipDisplayTag !== "undefined")) {
                console.log(`[adinplay-ads.js] Not available for banner`);
                return false;
            }

            // Display and verify fill. Resolve true only if creative appears; else false to allow fallback
            return await new Promise((resolve) => {
                let settled = false;

                const settle = (ok) => {
                    if (!settled) { settled = true; resolve(ok); }
                };

                // Observe for injected content
                const observer = new MutationObserver(() => {
                    // Ad networks typically inject iframes or images
                    const hasCreative = placeholder.querySelector('iframe, img, ins, div');
                    if (hasCreative && placeholder.children.length > 0) {
                        observer.disconnect();
                        settle(true);
                    }
                });
                try {
                    observer.observe(placeholder, { childList: true, subtree: true });
                } catch {}

                // Safety timeout in case nothing is injected (e.g., adblock)
                const timeoutMs = 3000;
                const timeoutId = setTimeout(() => {
                    observer.disconnect();
                    // Consider it a failure if no children were added
                    const ok = placeholder.children.length > 0;
                    settle(ok);
                }, timeoutMs);

                // Request display
                aiptag.cmd.display.push(function() {
                    try {
                        aipDisplayTag.display(adinplayTag);
                    } catch (e) {
                        clearTimeout(timeoutId);
                        observer.disconnect();
                        settle(false);
                    }
                });
            });
        }
    };
    
    // Initialize AdinPlay
    initAdinPlay();
    
    console.log("[adinplay-ads.js] Module loaded successfully");
})();
