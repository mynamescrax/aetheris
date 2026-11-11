//
// legion v1 ILJV

// // Create a promise that resolves when the CrazyGames SDK is initialized.
const sdkInitPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://sdk.crazygames.com/crazygames-sdk-v3.js';
    script.onload = () => {
        // Initialize CrazyGames SDK
        window.CrazyGames.SDK.init()
            .then(async () => {
                console.log('CrazyGames SDK initialized.');
                window.SDK.loadingStart();

                // Listen for user change (A log out doesn't trigger the auth listeners, since the entire page is refreshed when the player logs out.)
                window.CrazyGames.SDK.user.addAuthListener(onCrazyGamesAuth);

                // resolve success
                resolve();
            })
            .catch((error) => {
                console.error('CrazyGames SDK initialization failed:', error);
                reject(error);
            });
    };
    document.head.appendChild(script);
});


const onCrazyGamesAuth = (user) => {
    if (user !== null && user !== undefined)
    {
        loginCrazyGames();
    }
};

// showCgAuthPrompt will be called from:
// Unity LoginButtonPressed
window.showCgAuthPrompt = async function showCgAuthPrompt() {
    try {
        const user = await window.CrazyGames.SDK.user.showAuthPrompt();
        console.log("Auth prompt result", user);
    } catch (e) {
        console.log("Error:", e);
    }
}

window.onRoomLeftCallback = null;

window.makeSureRoomLeftAsync = async function makeSureRoomLeftAsync() {
    return new Promise((resolve) => {
        try {
            if (typeof unityInstance !== 'undefined' && unityInstance !== null) {
                window.onRoomLeftCallback = resolve;
                unityInstance?.SendMessage('NetworkManager', 'OnJavaScriptRequestRoomLeave', '');
            } else {
                resolve();
            }
        } catch (error) {
            console.error("makeSureRoomLeftAsync failed:", error);
            resolve();
        }
    });
};

window.signupCrazyGames = async function signupCrazyGames() {
    try {
        await sdkInitPromise;

        const cgUser = await window.CrazyGames.SDK.user.getUser();
        console.log("signupCrazyGames: Get user result", cgUser);
        if (cgUser === null) {
            console.log("No CrazyGames user logged in, exiting signupCrazyGames.");
            if (typeof unityInstance !== 'undefined' && unityInstance !== null) {
                unityInstance?.SendMessage('AuthManager', 'SetAutoLoginPendingFromJS', 'false');
            }
            return;
        }

        const token = await window.CrazyGames.SDK.user.getUserToken();

        const response = await fetch('https://usa-1.growden.io/api/accounts/signup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                provider: 'crazygames',
                token
            })
        });

        if (response.ok) {
            const data = await response.json();
            if (typeof unityInstance !== 'undefined' && unityInstance !== null) {
                unityInstance?.SendMessage('AuthManager', 'ProcessJsonAfterLogin', JSON.stringify(data));
                unityInstance?.SendMessage('AuthManager', 'SetAutoLoginPendingFromJS', 'false');
            }
        } else {
            if (typeof unityInstance !== 'undefined' && unityInstance !== null) {
                unityInstance?.SendMessage('AuthManager', 'SetAutoLoginPendingFromJS', 'false');
            }
            console.error('[cg_sdk.js] Signup failed with status:', response.status);
        }

        window.CrazyGames.SDK.user.removeAuthListener(onCrazyGamesAuth);
    } catch (error) {
        if (typeof unityInstance !== 'undefined' && unityInstance !== null) {
            unityInstance?.SendMessage('AuthManager', 'SetAutoLoginPendingFromJS', 'false');
        }
        console.error("CrazyGames signup failed:", error);
    }
};

window.connectCrazyGames = async function connectCrazyGames() {
    try {
        await sdkInitPromise;

        const cgUser = await window.CrazyGames.SDK.user.getUser();
        console.log("connectCrazyGames: Get user result", cgUser);
        if (cgUser === null) {
            console.log("No CrazyGames user logged in, exiting connectCrazyGames.");
            return;
        }

        localStorage.setItem('cg_had_user', 'true');

        console.log("CrazyGames login detected, ensuring room is left for progress refetch...");
        await makeSureRoomLeftAsync();

        const token = await window.CrazyGames.SDK.user.getUserToken();

        if (typeof unityInstance !== 'undefined' && unityInstance !== null) {
            unityInstance?.SendMessage('AuthManager', 'OnCrazyGamesConnect', token);
        }

        window.CrazyGames.SDK.user.removeAuthListener(onCrazyGamesAuth);
    } catch (error) {
        console.error("CrazyGames connect failed:", error);
    }
};

window.checkAndLoginCrazyGames = async function() {
    try {
        await sdkInitPromise;

        const isAvailable = await window.CrazyGames.SDK.user.isUserAccountAvailable;
        console.log("CrazyGames user account available:", isAvailable);

        if (!isAvailable) {
            console.log("User account not available on this domain, falling back to anonymous");

            const hadCrazyGamesUser = localStorage.getItem('cg_had_user') === 'true';
            if (hadCrazyGamesUser) {
                console.log("CrazyGames logout detected - clearing device key for fresh anonymous account");
                localStorage.removeItem('cg_had_user');
                if (typeof unityInstance !== 'undefined' && unityInstance !== null) {
                    unityInstance?.SendMessage('AuthManager', 'OnCrazyGamesLogoutDetected', '');
                }
            }

            if (typeof unityInstance !== 'undefined' && unityInstance !== null) {
                unityInstance?.SendMessage('AuthManager', 'OnCrazyGamesCheckComplete', 'unavailable');
            }
            return;
        }

        const cgUser = await window.CrazyGames.SDK.user.getUser();
        console.log("checkAndLoginCrazyGames: User check result", cgUser);

        let userToUse = cgUser;
        if (!userToUse && isAvailable) {
            await new Promise(r => setTimeout(r, 300));
            userToUse = await window.CrazyGames.SDK.user.getUser();
            console.log("checkAndLoginCrazyGames: Recheck user result", userToUse);
        }

        if (userToUse !== null) {
            console.log("CrazyGames user found, initiating signup");
            localStorage.setItem('cg_had_user', 'true');

            console.log("CrazyGames user detected during initial check, ensuring room is left for progress refetch...");
            await makeSureRoomLeftAsync();

            if (typeof unityInstance !== 'undefined' && unityInstance !== null) {
                unityInstance?.SendMessage('AuthManager', 'SetAutoLoginPendingFromJS', 'true');
                unityInstance?.SendMessage('AuthManager', 'OnCrazyGamesCheckComplete', 'user');
            }

            await signupCrazyGames();
        } else {
            console.log("No CrazyGames user found, will fall back to anonymous");
            if (typeof unityInstance !== 'undefined' && unityInstance !== null) {
                unityInstance?.SendMessage('AuthManager', 'OnCrazyGamesCheckComplete', 'no_user');
            }
        }
    } catch (error) {
        console.error("checkAndLoginCrazyGames failed:", error);
        if (typeof unityInstance !== 'undefined' && unityInstance !== null) {
            unityInstance?.SendMessage('AuthManager', 'OnCrazyGamesCheckComplete', 'error');
        }
    }
};

window.checkCrazyGamesUserForConnect = async function() {
    try {
        await sdkInitPromise;

        const isAvailable = await window.CrazyGames.SDK.user.isUserAccountAvailable;
        if (!isAvailable) {
            console.log("User account not available, showing auth prompt");
            await window.showCgAuthPrompt();
            return;
        }

        const cgUser = await window.CrazyGames.SDK.user.getUser();
        console.log("checkCrazyGamesUserForConnect: User check result", cgUser);

        if (cgUser !== null) {
            console.log("CrazyGames user found, connecting to existing account");
            localStorage.setItem('cg_had_user', 'true');
            await connectCrazyGames();
        } else {
            console.log("No CrazyGames user found, showing auth prompt");
            await window.showCgAuthPrompt();
        }
    } catch (error) {
        console.error("checkCrazyGamesUserForConnect failed:", error);
        await window.showCgAuthPrompt();
    }
};

window.precheckCrazyGamesAuthForLogout = async function precheckCrazyGamesAuthForLogout() {
    try {
        await sdkInitPromise;

        const isAvailable = await window.CrazyGames.SDK.user.isUserAccountAvailable;
        const cgUser = await window.CrazyGames.SDK.user.getUser();
        console.log("[CG Precheck] available:", isAvailable, "user:", cgUser);

        if (cgUser) {
            localStorage.setItem('cg_had_user', 'true');
        } else {
            const hadCrazyGamesUser = localStorage.getItem('cg_had_user') === 'true';
            if (hadCrazyGamesUser) {
                console.log("[CG Precheck] Logout detected. Requesting device key rotation in Unity.");
                if (typeof unityInstance !== 'undefined' && unityInstance !== null) {
                    unityInstance?.SendMessage('AuthManager', 'OnCrazyGamesLogoutDetected', '');
                }
                localStorage.removeItem('cg_had_user');
            }
        }
    } catch (e) {
        console.warn('[CG Precheck] Error during precheck', e);
    } finally {
        if (typeof unityInstance !== 'undefined' && unityInstance !== null) {
            unityInstance?.SendMessage('AuthManager', 'OnCrazyGamesPrecheckComplete', '');
        }
    }
};

window.onRoomLeaveComplete = function() {
    console.log("Room leave complete, resolving makeSureRoomLeftAsync promise");
    if (typeof window.onRoomLeftCallback === 'function') {
        window.onRoomLeftCallback();
        window.onRoomLeftCallback = null;
    }
};

// loginCrazyGames will be called from:
// Unity SDKManager.RunCustomOneTimeAwakeLogic
// this.onCrazyGamesAuth
window.loginCrazyGames = async function loginCrazyGames() {

    try {
        // Wait for SDK initialization
        await sdkInitPromise;

        // Check if a CrazyGames user is logged in
        const cgUser = await window.CrazyGames.SDK.user.getUser();
        console.log("Get user result", cgUser);
        if (cgUser === null) {
            console.log("No CrazyGames user logged in, exiting loginCrazyGames.");
            if (typeof unityInstance !== 'undefined' && unityInstance !== null) {
                console.error("No CG user! Notify to unity...");
                unityInstance?.SendMessage('AuthManager', 'SetAutoLoginPendingFromJS', 'false');
            }
            else {
                console.error("unityInstance not found.");
            }
            return;
        }

        // Retrieve the CrazyGames user token (refreshes automatically)
        const token = await window.CrazyGames.SDK.user.getUserToken();

        // Send the token to the backend
        const response = await fetch('https://usa-1.growden.io/api/accounts/login/crazygames', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });

        // Only proceed if the response is successful (2xx status code)
        if (response.ok) {
            const data = await response.json();
            if (typeof unityInstance !== 'undefined' && unityInstance !== null) {
                unityInstance?.SendMessage('AuthManager', 'ProcessJsonAfterLogin', JSON.stringify(data));
            } else {
                console.error("unityInstance not found.");
            }
        } else {
            if (typeof unityInstance !== 'undefined' && unityInstance !== null) {
                unityInstance?.SendMessage('AuthManager', 'SetAutoLoginPendingFromJS', 'false');
            } else {
                console.error("unityInstance not found.");
            }
            console.error('[cg_sdk.js] Login failed with status:', response.status);
        }
        
        // No need to listen for auth events anymore:
        window.CrazyGames.SDK.user.removeAuthListener(onCrazyGamesAuth);
    } catch (error) {
        if (typeof unityInstance !== 'undefined' && unityInstance !== null) {
            unityInstance?.SendMessage('AuthManager', 'SetAutoLoginPendingFromJS', 'false');
        } else {
            console.error("unityInstance not found.");
        }
        console.error("CrazyGames login failed:", error);
    }
};


// Called from Unity: Application.ExternalCall("inviteCg", roomId);
window.inviteCg = function(roomId) {
    sdkInitPromise.then(() => {
        // Use the roomId string as is.
        const inviteLink = window.CrazyGames.SDK.game.inviteLink({
            roomId: roomId,
            // Additional parameters can be added if needed.
        });
        console.log("Invite link", inviteLink);

        // Try using the modern Clipboard API first.
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(inviteLink)
                .then(() => console.log("Invite link copied to clipboard."))
                .catch(err => console.error("Failed to copy invite link:", err));
        } else {
            // Fallback for older browsers.
            const textarea = document.createElement("textarea");
            textarea.value = inviteLink;
            document.body.appendChild(textarea);
            textarea.select();
            try {
                // @ts-ignore: Using deprecated document.execCommand as fallback.
                document.execCommand("copy");
                console.log("Fallback: Invite link copied to clipboard.");
            } catch (err) {
                console.error("Fallback: Unable to copy invite link", err);
            }
            document.body.removeChild(textarea);
        }
    }).catch((error) => {
        console.error("Error generating invite link:", error);
    });
};

// Called from Unity: Application.ExternalCall("showInviteButton", roomId);
window.showInviteButton = function(roomId) {
    sdkInitPromise.then(() => {
        // Show the invite button using CrazyGames SDK.
        const inviteLink = window.CrazyGames.SDK.game.showInviteButton({
            roomId: roomId,
            // You can add additional parameters if needed.
        });
        console.log("Invite button link", inviteLink);
    }).catch((error) => {
        console.error("Error showing invite button:", error);
    });
};

// Called from Unity: Application.ExternalCall("hideInviteButton");
window.hideInviteButton = function() {
    sdkInitPromise.then(() => {
        window.CrazyGames.SDK.game.hideInviteButton();
        console.log("Invite button hidden");
    }).catch((error) => {
        console.error("Error hiding invite button:", error);
    });
};

// --- Banner System Configuration ---

const DEBUG_MODE = window.location.href.includes('test');
const IS_MOBILE = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
const MIN_REFRESH_INTERVAL = 62000; // 62 seconds for CrazyGames (limit is 60s)
const CRAZY_BANNER_REQUEST_COOLDOWN = 31000; // CrazyGames throttles banner requests to every 30s
const BANNER_DEBOUNCE_TIME = 100;
const SHOWTIME_CHECK_INTERVAL = 1600;

const POSITION_NAMES = {
    0: 'Hidden', 1: 'TopCenter', 2: 'TopRight', 3: 'TopLeft',
    4: 'BottomCenter', 5: 'BottomRight', 6: 'BottomLeft',
    7: 'MiddleCenter', 8: 'MiddleLeft', 9: 'MiddleRight',
    10: 'BelowTopLeft', 11: 'BelowTopRight', 12: 'AboveBottomLeft'
};

window.bannerMapping = {
    0: '300x250',
    1: '728x90',
    2: '300x600'
};

window.bannerDimensions = {
    0: {
        width: '300px', height: '250px',
        scale: 1.3,
        enableForMobile: true,
        ratioBoostStops: [
            { ratio: 1.0,  boost: 1.8 },
            { ratio: 1.62, boost: 1.2 },
            { ratio: 1.78, boost: 1.1 }
        ]
    },
    1: {
        width: '728px', height: '90px',
        scale: 1.3,
        enableForMobile: false,
        ratioBoostStops: [
            { ratio: 0,    boost: 1.0 },
            { ratio: Infinity, boost: 1.0 }
        ]
    },
    2: {
        width: '300px', height: '600px',
        scale: 1.06,
        enableForMobile: false,
        ratioBoostStops: [
            { ratio: 1.0,  boost: 1.9 },
            { ratio: 1.62, boost: 1.15 },
            { ratio: 1.78, boost: 1.0 }
        ]
    }
};

// Sort ratioBoostStops
Object.keys(window.bannerDimensions).forEach(key => {
    window.bannerDimensions[key].ratioBoostStops.sort((a, b) => a.ratio - b.ratio);
});

function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

let loadingStartSent = false;

window.SDK = {
    async gameplayStart() {
        await sdkInitPromise;
        window.CrazyGames.SDK.game.gameplayStart();
    },
    async loadingStart() {
        if (loadingStartSent) return;
        loadingStartSent = true;
        await sdkInitPromise;
        window.CrazyGames.SDK.game.loadingStart();
    },
    async loadingEnd() {
        await sdkInitPromise;
        window.CrazyGames.SDK.game.loadingStop();
    },
    async gameplayEnd() {
        await sdkInitPromise;
        window.CrazyGames.SDK.game.gameplayStop();
    },
    async showMidroll() {
        await sdkInitPromise;
        const callbacks = {
            adFinished: () => unityInstance?.SendMessage("SDKManager", "OnVideoAdEnded", "true"),
            adError: (error) => unityInstance?.SendMessage("SDKManager", "OnVideoAdEnded", "false"),
            adStarted: () => console.log("Start midgame ad"),
        };
        window.CrazyGames.SDK.ad.requestAd("midgame", callbacks);
    },
    async showRewarded() {
        await sdkInitPromise;
        const callbacks = {
            adFinished: () => unityInstance?.SendMessage("SDKManager", "OnVideoAdEnded", "true"),
            adError: (error) => unityInstance?.SendMessage("SDKManager", "OnVideoAdEnded", "false"),
            adStarted: () => console.log("Start rewarded ad"),
        };
        window.CrazyGames.SDK.ad.requestAd("rewarded", callbacks);
    },

    // --- Banner System ---
    _bannerAds: {},
    _occupiedPositions: {},
    _lastRefreshed: {},
    _lastRequested: {},
    _pendingBannerOps: {},
    _bannerShowtime: {},
    _bannerVisibleSince: {},
    
    _startTrackingShowtime(adTag) {
        const now = Date.now();
        if (!this._bannerVisibleSince[adTag]) {
            this._bannerVisibleSince[adTag] = now;
            if (DEBUG_MODE) console.log(`[cg_sdk.js] Started tracking showtime for ${adTag}`);
        }
    },
    
    _stopTrackingShowtime(adTag) {
        if (this._bannerVisibleSince[adTag]) {
            const now = Date.now();
            const visibleDuration = now - this._bannerVisibleSince[adTag];
            this._bannerShowtime[adTag] = (this._bannerShowtime[adTag] || 0) + visibleDuration;
            delete this._bannerVisibleSince[adTag];
            if (DEBUG_MODE) console.log(`[cg_sdk.js] Stopped tracking showtime for ${adTag}. Total: ${Math.floor(this._bannerShowtime[adTag] / 1000)}s`);
        }
    },
    
    _resetShowtime(adTag) {
        this._bannerShowtime[adTag] = 0;
        delete this._bannerVisibleSince[adTag];
    },
    
    _getCurrentShowtime(adTag) {
        let totalShowtime = this._bannerShowtime[adTag] || 0;
        if (this._bannerVisibleSince[adTag]) {
            totalShowtime += (Date.now() - this._bannerVisibleSince[adTag]);
        }
        return totalShowtime;
    },
    
    _isBannerVisible(banner) {
        return banner && 
               banner.position !== 0 && 
               banner.container && 
               banner.container.style.display !== 'none' &&
               banner.container.offsetParent !== null &&
               !document.hidden;
    },

    async _originalSetBanner(bannerType, bannerPosition) {
        const adTag = window.bannerMapping[bannerType];
        const dims = window.bannerDimensions[bannerType];
        const now = Date.now();
        
        if (!adTag || !dims) {
             if (DEBUG_MODE) console.log(`[cg_sdk.js] SetBanner: Invalid banner type ${bannerType}`);
             return;
        }
        
        if (IS_MOBILE && !dims.enableForMobile) {
            if (DEBUG_MODE) console.log(`[cg_sdk.js] SetBanner: Banner ${adTag} disabled on mobile`);
            return;
        }

        const getCooldownInfo = () => {
            const lastRefresh = this._lastRefreshed[adTag] ?? 0;
            const lastRequest = this._lastRequested[adTag] ?? 0;
            const last = Math.max(lastRefresh, lastRequest);
            const elapsed = Date.now() - last;
            return {
                under: elapsed < CRAZY_BANNER_REQUEST_COOLDOWN,
                remaining: Math.max(CRAZY_BANNER_REQUEST_COOLDOWN - elapsed, 0)
            };
        };

        const releasePosition = async (posKey) => {
            const conflictTag = this._occupiedPositions[posKey];
            if (!conflictTag || conflictTag === adTag) return;

            delete this._occupiedPositions[posKey];

            const conflictInst = this._bannerAds[conflictTag];
            if (!conflictInst) return;

            this._stopTrackingShowtime(conflictTag);
            conflictInst.container.style.display = "none";
            conflictInst.position = 0;

            const lastConflictRefresh = this._lastRefreshed[conflictTag] ?? 0;
            const lastConflictRequest = this._lastRequested[conflictTag] ?? 0;
            const conflictLastAttempt = Math.max(lastConflictRefresh, lastConflictRequest);
            const elapsed = now - conflictLastAttempt;
            const conflictUnderCooldown = elapsed < CRAZY_BANNER_REQUEST_COOLDOWN;
            const conflictRemaining = conflictUnderCooldown ? CRAZY_BANNER_REQUEST_COOLDOWN - elapsed : 0;

            if (!conflictUnderCooldown) {
                try {
                    await sdkInitPromise;
                    window.CrazyGames.SDK.banner.clearBanner(conflictInst.container.id);
                } catch(e) {
                    console.error("Error clearing banner", e);
                }
                conflictInst.creativeReady = false;
            } else if (DEBUG_MODE) {
                console.log(`[cg_sdk.js] Delaying CrazyGames clear for ${conflictTag}; wait ${conflictRemaining}ms`);
            }
        };

        // Queue operation timestamp
        this._pendingBannerOps[bannerType] = {
            bannerType, bannerPosition, timestamp: now
        };

        let existingInstance = this._bannerAds[adTag];

        // HIDING
        if (bannerPosition === 0) {
             if (DEBUG_MODE) console.log(`[cg_sdk.js] Hiding banner ${adTag}`);
             if (existingInstance && existingInstance.container) {
                 this._stopTrackingShowtime(adTag);
                 existingInstance.container.style.display = "none";
                 
                 let oldPosKey = existingInstance.position?.toString?.();
                 if (oldPosKey && this._occupiedPositions[oldPosKey] === adTag) {
                     delete this._occupiedPositions[oldPosKey];
                 }

                 const { under, remaining } = getCooldownInfo();
                 if (!under) {
                     try {
                        await sdkInitPromise;
                        window.CrazyGames.SDK.banner.clearBanner(existingInstance.container.id);
                     } catch(e) { console.error("Error clearing banner", e); }
                     existingInstance.creativeReady = false;
                 } else if (DEBUG_MODE) {
                     console.log(`[cg_sdk.js] Skipping CrazyGames clear for ${adTag}; ${remaining}ms throttle remaining`);
                 }

                 existingInstance.position = 0;
                 delete this._pendingBannerOps[bannerType];
             }
             return;
        }

        // SHOWING / MOVING
        if (existingInstance) {
            if (existingInstance.position === bannerPosition) {
                 // Already here. Check refresh.
                 const currentShowtime = this._getCurrentShowtime(adTag);
                 if (currentShowtime >= MIN_REFRESH_INTERVAL) {
                     if (this._pendingBannerOps[bannerType]?.timestamp > now) return;
                     const { under, remaining } = getCooldownInfo();
                     if (!under) {
                         this._displayCGBanner(bannerType, adTag, existingInstance.container);
                     } else if (DEBUG_MODE) {
                         console.log(`[cg_sdk.js] Skipping CrazyGames refresh for ${adTag}; ${remaining}ms throttle remaining`);
                     }
                 }
                 return;
            }
            
            // Move
            let oldPosKey = existingInstance.position?.toString?.();
            if (oldPosKey && this._occupiedPositions[oldPosKey] === adTag) delete this._occupiedPositions[oldPosKey];
            
            let newPosKey = bannerPosition.toString();
            await releasePosition(newPosKey);
            
            existingInstance.container.style.display = "block";
            updateContainerPosition(existingInstance.container, bannerPosition);
            existingInstance.position = bannerPosition;
            this._occupiedPositions[newPosKey] = adTag;
            
            this._startTrackingShowtime(adTag);
            
            // Refresh on show
            const { under, remaining } = getCooldownInfo();
            if (!under) {
                this._displayCGBanner(bannerType, adTag, existingInstance.container);
            } else if (DEBUG_MODE) {
                console.log(`[cg_sdk.js] Reusing cached banner ${adTag}; ${remaining}ms before CrazyGames allows a refresh`);
            }
        } else {
            // Create New
            let posKey = bannerPosition.toString();
            if (this._occupiedPositions[posKey]) {
                await releasePosition(posKey);
            }
            
            const container = document.createElement('div');
            container.id = 'banner_' + adTag;
            container.style.position = 'absolute';
            container.style.zIndex = 1000;
            container.style.width = dims.width;
            container.style.height = dims.height;
             
            updateContainerPosition(container, bannerPosition);
            document.body.appendChild(container);
            
            this._bannerAds[adTag] = {
                bannerType, adTag, container, position: bannerPosition, creativeReady: false
            };
            this._occupiedPositions[posKey] = adTag;
            
            this._startTrackingShowtime(adTag);
            this._displayCGBanner(bannerType, adTag, container);
        }
        onWindowResize();
    },

    async _displayCGBanner(bannerType, adTag, container) {
        try {
            await sdkInitPromise;
            
            // Check if banner is still supposed to be visible
            const currentInstance = this._bannerAds[adTag];
            if (!currentInstance || currentInstance.position === 0) {
                 if (DEBUG_MODE) console.log(`[cg_sdk.js] Banner ${adTag} no longer visible, skipping request`);
                 return;
            }

            const requestTimestamp = Date.now();
            this._lastRequested[adTag] = requestTimestamp;
            
            // 300x600 (Type 2) -> Responsive
            if (bannerType === 2) {
                await window.CrazyGames.SDK.banner.requestResponsiveBanner(container.id);
            } else {
                // Fixed size
                const dims = window.bannerDimensions[bannerType];
                await window.CrazyGames.SDK.banner.requestBanner({
                    id: container.id,
                    width: parseInt(dims.width),
                    height: parseInt(dims.height)
                });
            }
            
            if (DEBUG_MODE) console.log(`[cg_sdk.js] Requested banner ${adTag}`);
            this._lastRefreshed[adTag] = requestTimestamp;
            this._resetShowtime(adTag);
            this._startTrackingShowtime(adTag);
            currentInstance.creativeReady = true;
        } catch(e) {
            const failedInstance = this._bannerAds[adTag];
            if (failedInstance) {
                failedInstance.creativeReady = false;
            }
            console.error("[cg_sdk.js] Banner request failed:", e);
        }
    }
};

// Debounced SetBanner
window.SDK.SetBanner = function(bannerType, bannerPosition) {
    if (!window.SDK._debouncedSetBannerPerType) {
        window.SDK._debouncedSetBannerPerType = {};
    }
    if (!window.SDK._debouncedSetBannerPerType[bannerType]) {
        window.SDK._debouncedSetBannerPerType[bannerType] = debounce(
            (t, p) => window.SDK._originalSetBanner(t, p),
            BANNER_DEBOUNCE_TIME
        );
    }
    window.SDK._debouncedSetBannerPerType[bannerType](bannerType, bannerPosition);
};

function updateContainerPosition(container, bannerPosition) {
    container.style.top = "";
    container.style.right = "";
    container.style.bottom = "";
    container.style.left = "";
    container.style.transformOrigin = "";
    container.style.margin = "";

    switch (parseInt(bannerPosition)) {
        case 0: container.style.display = "none"; break;
        case 1: // TopCenter
            container.style.display = "block";
            container.style.top = "1%";
            container.style.left = "0";
            container.style.right = "0";
            container.style.marginLeft = "auto";
            container.style.marginRight = "auto";
            container.style.transformOrigin = "top center";
            break;
        case 2: // TopRight
            container.style.display = "block";
            container.style.top = "1%";
            container.style.right = "1%";
            container.style.transformOrigin = "top right";
            break;
        case 3: // TopLeft
            container.style.display = "block";
            container.style.top = "1%";
            container.style.left = "1%";
            container.style.transformOrigin = "top left";
            break;
        case 4: // BottomCenter
            container.style.display = "block";
            container.style.bottom = "0.5%";
            container.style.left = "0";
            container.style.right = "0";
            container.style.marginLeft = "auto";
            container.style.marginRight = "auto";
            container.style.transformOrigin = "bottom center";
            break;
        case 5: // BottomRight
            container.style.display = "block";
            container.style.bottom = "1%";
            container.style.right = "1%";
            container.style.transformOrigin = "bottom right";
            break;
        case 6: // BottomLeft
            container.style.display = "block";
            container.style.bottom = "1%";
            container.style.left = "1%";
            container.style.transformOrigin = "bottom left";
            break;
        case 7: // MiddleCenter
            container.style.display = "block";
            container.style.top = "0";
            container.style.bottom = "0";
            container.style.left = "0";
            container.style.right = "0";
            container.style.margin = "auto";
            break;
        case 8: // MiddleLeft
            container.style.display = "block";
            container.style.left = "1%";
            container.style.top = "0";
            container.style.bottom = "0";
            container.style.margin = "auto";
            container.style.transformOrigin = "center left";
            break;
        case 9: // MiddleRight
            container.style.display = "block";
            container.style.right = "1%";
            container.style.top = "0";
            container.style.bottom = "0";
            container.style.margin = "auto";
            container.style.transformOrigin = "center right";
            break;
        case 10: // Below TopLeft
            container.style.display = "block";
            container.style.position = "absolute";
            container.style.left = "1%";
            container.style.top = "28.6%";
            container.style.transformOrigin = "top left";
            break;
        case 11: // Below TopRight
            container.style.display = "block";
            container.style.position = "absolute";
            container.style.top = "10%";
            container.style.right = "1%";
            container.style.transformOrigin = "top right";
            break;
        case 12: // Above BottomLeft
            container.style.display = "block";
            container.style.bottom = "12%";
            container.style.left = "1%";
            container.style.transformOrigin = "bottom left";
            break;
    }
}

function getRatioBoost(stops, aspect) {
    if (aspect <= stops[0].ratio) return stops[0].boost;
    if (aspect >= stops.at(-1).ratio) return stops.at(-1).boost;
    for (let i = 0; i < stops.length-1; i++) {
        const a = stops[i], b = stops[i+1];
        if (aspect >= a.ratio && aspect <= b.ratio) {
            const t = (aspect - a.ratio) / (b.ratio - a.ratio);
            return a.boost + (b.boost - a.boost) * t;
        }
    }
    return 1;
}

function onWindowResize() {
    const w = window.innerWidth, h = window.innerHeight;
    const aspect = w / h;
    const baseScale = Math.min(w/1920, h/960);

    Object.keys(window.bannerMapping).forEach(key => {
        const tag  = window.bannerMapping[key];
        const dims = window.bannerDimensions[key];
        const ctr  = document.getElementById('banner_' + tag);
        if (!ctr || (IS_MOBILE && !dims.enableForMobile)) return;

        const boost = getRatioBoost(dims.ratioBoostStops, aspect);
        const finalScale = baseScale * dims.scale * boost;
        ctr.style.transform = `scale(${finalScale})`;
    });
}

window.addEventListener("resize", onWindowResize);

// Refresh Loop
setInterval(() => {
    const now = Date.now();
    Object.keys(window.SDK._bannerAds).forEach(adTag => {
        const banner = window.SDK._bannerAds[adTag];
        if (window.SDK._isBannerVisible(banner)) {
            // Ensure tracking
            if (!window.SDK._bannerVisibleSince[adTag]) window.SDK._startTrackingShowtime(adTag);
            
            const currentShowtime = window.SDK._getCurrentShowtime(adTag);
            if (currentShowtime >= MIN_REFRESH_INTERVAL) {
                const bannerType = Object.keys(window.bannerMapping).find(key => window.bannerMapping[key] === adTag);
                if (bannerType !== undefined) {
                     window.SDK._displayCGBanner(parseInt(bannerType), adTag, banner.container);
                }
            }
        } else {
             if (window.SDK._bannerVisibleSince[adTag]) window.SDK._stopTrackingShowtime(adTag);
        }
    });
}, SHOWTIME_CHECK_INTERVAL);

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        Object.keys(window.SDK._bannerAds).forEach(tag => window.SDK._stopTrackingShowtime(tag));
    } else {
        Object.keys(window.SDK._bannerAds).forEach(tag => {
            if (window.SDK._isBannerVisible(window.SDK._bannerAds[tag])) window.SDK._startTrackingShowtime(tag);
        });
    }
});
