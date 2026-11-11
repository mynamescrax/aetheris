// autoplay
window.auto_play = true;

// Load Poki SDK
const script = document.createElement('script');
script.src = 'https://game-cdn.poki.com/scripts/v2/poki-sdk.js';
script.onload = () => {
    // Initialize Poki SDK
    if (window.PokiSDK) {
        PokiSDK.init().then(() => {
            console.log('Poki SDK initialized.');
            // Additional Poki SDK setup if needed
            window.SDK.loadingStart();
        }).catch((error) => {
            console.error('Poki SDK initialization failed:', error);
        });
    } else {
        console.warn("PokiSDK not loaded properly.");
    }
};
document.head.appendChild(script);

var loadingStartSent = false;

// SDK Wrapper with null checks
window.SDK = {
    gameplayStart() {
        if (window.PokiSDK?.gameplayStart) {
            PokiSDK.gameplayStart();
        } else {
            console.warn("PokiSDK gameplayStart is unavailable.");
        }
    },
    loadingStart() {
        if (loadingStartSent)
            return;
        loadingStartSent = true;
        
        // No equivalent in Poki SDK, empty implementation
        console.log("Loading started (Poki)");
    },
    loadingEnd() {
        if (window.PokiSDK?.gameLoadingFinished) {
            PokiSDK.gameLoadingFinished();
        } else {
            console.warn("PokiSDK gameLoadingFinished is unavailable.");
        }
    },
    gameplayEnd() {
        if (window.PokiSDK?.gameplayStop) {
            PokiSDK.gameplayStop();
        } else {
            console.warn("PokiSDK gameplayStop is unavailable.");
        }
    },
    showMidroll() {
        if (window.PokiSDK?.commercialBreak) {
            PokiSDK.commercialBreak().then(() => {
                console.log("Midroll Ad Finished");
                unityInstance.SendMessage("SDKManager", "OnVideoAdEnded", "true");
            }).catch(() => {
                console.log("Midroll Ad Skipped/Failed");
                unityInstance.SendMessage("SDKManager", "OnVideoAdEnded", "false");
            });
        } else {
            console.warn("PokiSDK commercialBreak is unavailable.");
            unityInstance.SendMessage("SDKManager", "OnVideoAdEnded", "false");
        }
    },
    showRewarded() {
        console.log("Poki does not support rewarded ads. Showing commercial instead.");
        this.showMidroll();
    },
};
