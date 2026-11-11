// Yandex Games SDK Integration
// Based on https://yandex.com/dev/games/doc/en/sdk/sdk-about

// Load the Yandex Games SDK from the official source
const yandexScript = document.createElement("script");
yandexScript.src = "https://sdk.games.s3.yandex.net/sdk.js";
yandexScript.async = true;
document.head.appendChild(yandexScript);

// Create a promise that resolves when the Yandex SDK is initialized
const ysdkInitPromise = new Promise((resolve, reject) => {
    // Function to initialize SDK
    function initYandexSDK() {
        if (typeof YaGames !== 'undefined') {
            YaGames.init()
                .then(ysdk => {
                    console.log('Yandex SDK initialized');
                    window.ysdk = ysdk;
                    resolve(ysdk);
                })
                .catch(err => {
                    console.error('Yandex SDK initialization failed:', err);
                    reject(err);
                });
        } else {
            // If YaGames is not yet defined, wait and try again
            setTimeout(checkAndInitSDK, 100);
        }
    }
    
    // Function to check if YaGames is defined and initialize it
    function checkAndInitSDK() {
        if (typeof YaGames !== 'undefined') {
            initYandexSDK();
        } else {
            // Wait some time and check again, up to a timeout
            const maxWaitTime = 10000; // 10 seconds timeout
            if (window._yandexSDKWaitTime === undefined) {
                window._yandexSDKWaitTime = 0;
            }
            
            window._yandexSDKWaitTime += 100;
            if (window._yandexSDKWaitTime < maxWaitTime) {
                setTimeout(checkAndInitSDK, 100);
            } else {
                console.error('Timed out waiting for YaGames to be defined');
                reject(new Error('YaGames not defined after timeout'));
            }
        }
    }
    
    // Start the initialization process
    checkAndInitSDK();
});

let loadingStartSent = false;

window.SDK = {
    async gameplayStart() {
        try {
            const ysdk = await ysdkInitPromise;
            if (ysdk.features && ysdk.features.GameplayAPI) {
                ysdk.features.GameplayAPI.start();
                console.log('[yandex_sdk.js] Gameplay started');
            }
        } catch (error) {
            console.error('[yandex_sdk.js] Error in gameplayStart:', error);
        }
    },
    
    loadingStart() {
        if (loadingStartSent)
            return;
        loadingStartSent = true;
        console.log('[yandex_sdk.js] Loading started');
    },
    
    async loadingEnd() {
        try {
            const ysdk = await ysdkInitPromise;
            if (ysdk.features && ysdk.features.LoadingAPI) {
                ysdk.features.LoadingAPI.ready();
                console.log('[yandex_sdk.js] Loading finished');
            }
        } catch (error) {
            console.error('[yandex_sdk.js] Error in loadingEnd:', error);
        }
    },
    
    async gameplayEnd() {
        try {
            const ysdk = await ysdkInitPromise;
            if (ysdk.features && ysdk.features.GameplayAPI) {
                ysdk.features.GameplayAPI.stop();
                console.log('[yandex_sdk.js] Gameplay ended');
            }
        } catch (error) {
            console.error('[yandex_sdk.js] Error in gameplayEnd:', error);
        }
    },
    
    async showMidroll() {
        console.log('[yandex_sdk.js] Attempting to show midroll ad...');
        try {
            const ysdk = await ysdkInitPromise;
            
            // Stop gameplay during ad
            if (ysdk.features && ysdk.features.GameplayAPI) {
                ysdk.features.GameplayAPI.stop();
            }
            
            ysdk.adv.showFullscreenAdv({
                callbacks: {
                    onClose: function(wasShown) {
                        console.log(`[yandex_sdk.js] Fullscreen ad closed, wasShown: ${wasShown}`);
                        
                        // Resume gameplay after ad
                        if (ysdk.features && ysdk.features.GameplayAPI) {
                            ysdk.features.GameplayAPI.start();
                        }
                        
                        // Always notify Unity of completion
                        if (typeof unityInstance !== 'undefined') {
                            unityInstance.SendMessage("SDKManager", "OnVideoAdEnded", wasShown ? "true" : "false");
                        }
                    },
                    onError: function(error) {
                        console.error('[yandex_sdk.js] Fullscreen ad error:', error);
                        
                        // Resume gameplay after error
                        if (ysdk.features && ysdk.features.GameplayAPI) {
                            ysdk.features.GameplayAPI.start();
                        }
                        
                        // Notify Unity of failure
                        if (typeof unityInstance !== 'undefined') {
                            unityInstance.SendMessage("SDKManager", "OnVideoAdEnded", "false");
                        }
                    }
                }
            });
        } catch (error) {
            console.error('[yandex_sdk.js] Error showing midroll ad:', error);
            
            // Notify Unity of failure
            if (typeof unityInstance !== 'undefined') {
                unityInstance.SendMessage("SDKManager", "OnVideoAdEnded", "false");
            }
        }
    },
    
    async showRewarded() {
        console.log('[yandex_sdk.js] Attempting to show rewarded ad...');
        try {
            const ysdk = await ysdkInitPromise;
            
            // Stop gameplay during ad
            if (ysdk.features && ysdk.features.GameplayAPI) {
                ysdk.features.GameplayAPI.stop();
            }
            
            ysdk.adv.showRewardedVideo({
                callbacks: {
                    onOpen: () => {
                        console.log('[yandex_sdk.js] Rewarded video opened');
                    },
                    onRewarded: () => {
                        console.log('[yandex_sdk.js] User earned reward');
                    },
                    onClose: () => {
                        console.log('[yandex_sdk.js] Rewarded video closed');
                        
                        // Resume gameplay after ad
                        if (ysdk.features && ysdk.features.GameplayAPI) {
                            ysdk.features.GameplayAPI.start();
                        }
                        
                        // Notify Unity of success
                        if (typeof unityInstance !== 'undefined') {
                            unityInstance.SendMessage("SDKManager", "OnVideoAdEnded", "true");
                        }
                    },
                    onError: (error) => {
                        console.error('[yandex_sdk.js] Rewarded video error:', error);
                        
                        // Resume gameplay after error
                        if (ysdk.features && ysdk.features.GameplayAPI) {
                            ysdk.features.GameplayAPI.start();
                        }
                        
                        // Notify Unity of failure
                        if (typeof unityInstance !== 'undefined') {
                            unityInstance.SendMessage("SDKManager", "OnVideoAdEnded", "false");
                        }
                    }
                }
            });
        } catch (error) {
            console.error('[yandex_sdk.js] Error showing rewarded ad:', error);
            
            // Notify Unity of failure
            if (typeof unityInstance !== 'undefined') {
                unityInstance.SendMessage("SDKManager", "OnVideoAdEnded", "false");
            }
        }
    },
    
    // Implement empty SetBanner function to maintain SDK interface compatibility
    SetBanner: function(bannerType, bannerPosition) {
        console.log('[yandex_sdk.js] SetBanner called, but not implemented for Yandex');
    },
    
    // These methods allow Unity to check if SDK is loaded
    getBuildURL: function() {
        return "Build"; // Default path
    },
    
    getStreamingAssetsUrl: function() {
        return "/StreamingAssets"; // Default path
    },
    
    getStaticResolutionScaleMulti: function() {
        return 1.0; // Default scale
    }
};

// Initialize SDK on load
window.SDK.loadingStart(); 
