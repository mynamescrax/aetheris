/**
 * Legion SDK Integration for Unity WebGL Games
 * 
 * Simple integration file that loads the Legion SDK and bridges to Unity.
 * The SDK handles all complexity - this file just connects the dots.
 * 
 * ESC key, pointer lock, and menu handling are automatic via the SDK.
 */

const IS_PLAYTEST_LINK = window.location.href.includes('playtest');

const GAME_AUTH_URL = IS_PLAYTEST_LINK ? '/proxy/tsunamis-dev-auth/' : '/proxy/tsunamis-auth/';

// Cache the latest user data from onUserChanged for sync getters
let cachedLegionUser = null;

// Track if Unity is ready to receive events
let unityReady = false;
// undefined = no result stored yet, null = auth failed, object = auth succeeded
let pendingAuthResult = undefined;

// Auth state: use a promise so concurrent calls wait for the same result
let authPromise = null; // Promise<result> | null - the in-flight or completed auth
let lastAuthLegionId = null; // Track which Legion user we authenticated

// Create a promise that resolves when the Legion SDK is initialized
const legionSdkInitPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://sdk.legionsdk.com/v1/legion-sdk.min.js';
    script.onload = () => {
        if (window.Legion && window.Legion.SDK) {
            // Initialize SDK (ESC key + pointer lock handling is automatic)
            window.Legion.SDK.init();

            // Listen for user changes - this fires immediately with current state
            window.Legion.SDK.auth.onUserChanged((user) => {
                console.log('[LegionIntegration] onUserChanged:', user ? user.username : 'null',
                    user ? `(legionId: ${user._id})` : '');

                // Cache the fresh user data
                cachedLegionUser = user;

                if (user) {
                    // User is logged in - authenticate with game server
                    authenticateWithGameServer();
                } else {
                    // User logged out or not logged in
                    console.log('[LegionIntegration] No user - clearing session');
                    // Reset auth state so next login starts fresh
                    authPromise = null;
                    lastAuthLegionId = null;
                    sendAuthResultToUnity(null);
                }
            });

            // Listen for respawn requests from portal menu
            window.Legion.SDK.player.onRespawnRequest(() => {
                notifyUnity('LegionListener', 'OnLegionRespawnRequested');
            });

            // Listen for when I send a chat message via legionsdk
            window.Legion.SDK.player.onChatMessageSent((message) => {
                notifyUnity('LegionListener', 'OnLegionChatMessageSent', message);
            });

            // ============================================
            // Settings Listeners (string-based API)
            // ============================================

            // Volume setting (0-100 as string)
            window.Legion.SDK.settings.listen('master_volume', (volume) => {
                notifyUnity('LegionListener', 'OnLegionVolumeChanged', volume);
            });

            // Music volume setting (0-100 as string)
            window.Legion.SDK.settings.listen('music_volume', (volume) => {
                notifyUnity('LegionListener', 'OnLegionMusicVolumeChanged', volume);
            });

            // Graphics quality setting ("Low", "Medium", "High", "Ultra")
            window.Legion.SDK.settings.listen('graphics_quality', (quality) => {
                notifyUnity('LegionListener', 'OnLegionGraphicsQualityChanged', quality);
            });

            // Show FPS setting ("true" or "false")
            window.Legion.SDK.settings.listen('show_fps', (showFps) => {
                notifyUnity('LegionListener', 'OnLegionShowFpsChanged', showFps);
            });

            // Camera sensitivity setting (0.1-5.0 as string)
            window.Legion.SDK.settings.listen('camera_sensitivity', (sensitivity) => {
                notifyUnity('LegionListener', 'OnLegionCameraSensitivityChanged', sensitivity);
            });

            // ============================================
            // Avatar Change Listener
            // ============================================

            // Listen for avatar changes (when user equips/unequips items in customizer)
            window.Legion.SDK.avatar.onAvatarChanged((equipped) => {
                // equipped = { hatId?: number, backId?: number, skinId?: number }
                console.log('[LegionIntegration] Avatar changed:', equipped);
                notifyUnity('LegionListener', 'OnLegionAvatarChanged', JSON.stringify(equipped));
            });

            console.log('[LegionIntegration] SDK initialized');
            resolve();
        } else {
            reject(new Error('Legion SDK failed to load'));
        }
    };
    script.onerror = reject;
    document.head.appendChild(script);
});

// ============================================
// Unity Bridge Helper
// ============================================

function notifyUnity(objectName, methodName, value = '') {
    if (typeof unityInstance !== 'undefined' && unityInstance !== null) {
        unityInstance.SendMessage(objectName, methodName, value);
    }
}

// ============================================
// Game Server Authentication
// ============================================

/**
 * Validates that the auth result is from the Tsunamis game server, not raw Legion data.
 * Game server responses have legionId and selected_* fields.
 * Raw Legion responses have avatar.hatId/backId/skinId format.
 */
function isValidGameServerResponse(result) {
    if (!result || !result.user) return false;

    // Game server format: has legionId or selected_hat/selected_back/selected_skin
    const hasGameServerFields = result.user.legionId !== undefined ||
        result.user.selected_hat !== undefined ||
        result.user.selected_back !== undefined;

    // Raw Legion format: has avatar.hatId/backId/skinId (and NO legionId)
    const hasRawLegionFormat = result.user.avatar &&
        result.user.avatar.hatId !== undefined &&
        result.user.legionId === undefined;

    if (hasRawLegionFormat) {
        console.error('[LegionIntegration] REJECTED: Received raw Legion format instead of game server response!',
            JSON.stringify(result.user).substring(0, 200));
        return false;
    }

    return hasGameServerFields;
}

async function authenticateWithGameServer() {
    const currentLegionId = cachedLegionUser?._id;

    // If we already have an auth in progress/completed for this user, wait for it
    if (authPromise && lastAuthLegionId === currentLegionId) {
        console.log('[LegionIntegration] Auth already in progress for this user, waiting...');
        return authPromise;
    }

    // Start new auth
    console.log('[LegionIntegration] Starting new auth for legionId:', currentLegionId);
    lastAuthLegionId = currentLegionId;

    authPromise = (async () => {
        try {
            await legionSdkInitPromise;
            console.log('[LegionIntegration] Authenticating with game server...');
            const result = await window.Legion.SDK.auth.authenticateWithServer(GAME_AUTH_URL);

            if (result && isValidGameServerResponse(result)) {
                console.log('[LegionIntegration] Auth successful (valid game server response)');
                sendAuthResultToUnity(result);
                return result;
            } else if (result) {
                // Got a response but it's not valid game server format
                console.error('[LegionIntegration] Auth returned invalid format, not sending to Unity');
                authPromise = null; // Reset so retry is possible
                lastAuthLegionId = null;
                return null;
            } else {
                console.log('[LegionIntegration] Auth returned null');
                authPromise = null;
                lastAuthLegionId = null;
                sendAuthResultToUnity(null);
                return null;
            }
        } catch (error) {
            console.error('[LegionIntegration] Auth failed:', error);
            authPromise = null;
            lastAuthLegionId = null;
            sendAuthResultToUnity(null);
            return null;
        }
    })();

    return authPromise;
}

/**
 * Send auth result to Unity - handles the case where Unity might not be ready yet
 */
function sendAuthResultToUnity(result) {
    if (unityReady) {
        if (result) {
            console.log('[LegionIntegration] sendAuthResultToUnity: OK. Sending to Unity: AuthManager.ProcessJsonAfterLogin:', JSON.stringify(result));
            notifyUnity('AuthManager', 'ProcessJsonAfterLogin', JSON.stringify(result));
        } else {
            console.error('[LegionIntegration] sendAuthResultToUnity: logged out! Sending Logout2.');
            notifyUnity('AuthManager', 'Logout2');
            notifyUnity('AuthManager', 'SetLoginPendingFromJS', 'false');
        }
    } else {
        // Unity not ready yet - store for when it signals ready
        console.log('[LegionIntegration] Unity not ready, storing auth result');
        pendingAuthResult = result;
    }
}

/**
 * Called by Unity when it's ready to receive auth events.
 * This replaces the old loginLegion() call.
 */
window.onUnityReady = function () {
    console.log('[LegionIntegration] Unity signaled ready');
    unityReady = true;

    // If we already have a stored result (success OR failure), send it now
    // undefined = no result stored, null = auth failed, object = auth succeeded
    if (pendingAuthResult !== undefined) {
        console.log('[LegionIntegration] Sending pending auth result to Unity:', pendingAuthResult ? 'success' : 'failed');
        sendAuthResultToUnity(pendingAuthResult);
        pendingAuthResult = undefined;
    } else if (authPromise === null && cachedLegionUser === null) {
        // No pending result and no user - tell Unity there's no auto-login
        notifyUnity('AuthManager', 'SetLoginPendingFromJS', 'false');
    }
    // If authPromise exists but no pendingAuthResult, auth is still in progress
    // and will call sendAuthResultToUnity when complete (unityReady is now true)
};

// ============================================
// Unity Entry Points (called from Unity C#)
// ============================================

// Show auth modal (for games embedded in legionsdk.com/g/[game])
window.showLegionAuthModal = async function () {
    await legionSdkInitPromise;

    // If already logged into Legion but game server auth failed, retry instead of showing modal
    if (window.Legion.SDK.auth.isLoggedIn()) {
        console.log('[LegionIntegration] Already logged into Legion, retrying game server auth');
        notifyUnity('AuthManager', 'SetLoginPendingFromJS', 'true');
        authPromise = null; // Reset to force fresh attempt
        lastAuthLegionId = null;
        await authenticateWithGameServer();
        return;
    }

    await window.Legion.SDK.auth.showAuthModal();
};

// Show auth window (for standalone games on your own domain)
window.showLegionAuthWindow = async function () {
    await legionSdkInitPromise;

    // If already logged into Legion but game server auth failed, retry instead of opening window
    if (window.Legion.SDK.auth.isLoggedIn()) {
        console.log('[LegionIntegration] Already logged into Legion, retrying game server auth');
        notifyUnity('AuthManager', 'SetLoginPendingFromJS', 'true');
        authPromise = null; // Reset to force fresh attempt
        lastAuthLegionId = null;
        await authenticateWithGameServer();
        return;
    }

    await window.Legion.SDK.auth.showAuthWindow();
};

// Auto-login / check login status (DEPRECATED - use onUnityReady instead)
// Kept for backward compatibility but just calls onUnityReady
window.loginLegion = function () {
    console.log('[LegionIntegration] loginLegion called (deprecated, use onUnityReady)');
    window.onUnityReady();
};

// Logout
window.logoutLegion = async function () {
    await legionSdkInitPromise;
    window.Legion.SDK.auth.logout();
};

// ============================================
// Room/Multiplayer Support
// ============================================

/**
 * Update the current room and party IDs for multiplayer.
 * Call this when the player joins/leaves a room or party.
 * 
 * @param {string} roomId - The game room/match ID, or empty string if not in a match
 * @param {string} partyId - The party ID (for squad-based games), or empty string if not in a party
 */
window.updateLegionRoom = async function (roomId, partyId) {
    await legionSdkInitPromise;
    window.Legion.SDK.game.updateRoom(roomId || '', partyId || '');
    console.log(`[LegionIntegration] Room updated: roomId=${roomId || '(none)'}, partyId=${partyId || '(none)'}`);
};

// ============================================
// Settings Getters (for one-time reads)
// ============================================

// Get a setting value by key (synchronous for Unity DllImport)
window.getLegionSetting = function (key) {
    if (!window.Legion || !window.Legion.SDK) {
        return '';
    }
    return window.Legion.SDK.settings.get(key) || '';
};

// Get all settings (async version)
window.getLegionSettings = async function () {
    await legionSdkInitPromise;
    return window.Legion.SDK.settings.getAll();
};

// ============================================
// SDK Compatibility Layer (window.SDK.*)
// ============================================
// IMPORTANT: This wraps existing SDK methods rather than replacing them.
// If sdk.js (or another SDK) loads, we call BOTH Legion's methods AND the original.
// If no other SDK exists, we provide fallback stubs.

window.SDK = window.SDK || {};

// Helper to wrap lifecycle methods - calls both Legion and any existing implementation
function wrapLifecycleMethod(methodName, legionMethod) {
    const original = window.SDK[methodName];
    window.SDK[methodName] = async function (...args) {
        // Always notify Legion SDK
        await legionSdkInitPromise;
        legionMethod();
        // Also call original if it exists
        if (typeof original === 'function') {
            return original.apply(this, args);
        }
    };
}

wrapLifecycleMethod('gameplayStart', () => window.Legion.SDK.game.gameplayStart());
wrapLifecycleMethod('loadingStart', () => window.Legion.SDK.game.loadingStart());
wrapLifecycleMethod('loadingEnd', () => window.Legion.SDK.game.loadingEnd());
wrapLifecycleMethod('gameplayEnd', () => window.Legion.SDK.game.gameplayEnd());

// Ad methods: DO NOT override if a real implementation exists (e.g., from sdk.js)
// Only provide fallback stubs if no other SDK has implemented them

if (typeof window.SDK.showMidroll !== 'function') {
    window.SDK.showMidroll = function () {
        // Fallback: Ads not supported, immediately complete
        notifyUnity('SDKManager', 'OnVideoAdEnded', 'false');
    };
}

if (typeof window.SDK.showRewarded !== 'function') {
    window.SDK.showRewarded = function () {
        // Fallback: Ads not supported, immediately complete
        notifyUnity('SDKManager', 'OnVideoAdEnded', 'false');
    };
}

if (typeof window.SDK.SetBanner !== 'function') {
    window.SDK.SetBanner = function () {
        // Fallback: Banners not supported on Legion
    };
}

// ============================================
// Social/Connections API
// ============================================

/**
 * Get the current user's connections (friends) with presence info.
 * Returns an array of connection objects with presence data.
 * Returns empty array if not logged in.
 * 
 * Works efficiently in both modes:
 * - Embedded in legionsdk.com: Uses postMessage (no extra HTTP requests)
 * - Standalone: Makes HTTP request to Legion API
 * 
 * Connection object format:
 * {
 *   _id: string,
 *   username: string,
 *   displayName?: string,
 *   pfp?: string,
 *   presence: {
 *     status: 'online' | 'in_game' | 'away' | 'offline',
 *     currentGame?: string,    // Game ID if playing
 *     currentRoom?: string,    // Room ID if joinable
 *     gameSlug?: string,       // Game URL slug
 *     gameName?: string,       // Human-readable game name
 *     lastSeen?: string        // ISO timestamp
 *   }
 * }
 * 
 * @returns {Promise<Array>} Array of connections
 */
window.getLegionConnections = async function () {
    await legionSdkInitPromise;
    return window.Legion.SDK.social.getConnections();
};


/**
 * Get connections and notify Unity with the result as JSON.
 * Useful for Unity C# interop where async isn't directly supported.
 */
window.fetchLegionConnectionsForUnity = async function () {
    console.log('[LegionIntegration] fetchLegionConnectionsForUnity called');
    try {
        const connections = await window.getLegionConnections();
        console.log('[LegionIntegration] Got connections from Legion SDK:', connections?.length ?? 0, 'friends');
        if (connections && connections.length > 0) {
            console.log('[LegionIntegration] First connection sample:', JSON.stringify(connections[0]));
        }
        notifyUnity('FriendsManager', 'OnConnectionsReceived', JSON.stringify(connections));
        console.log('[LegionIntegration] Sent connections to Unity');
    } catch (error) {
        console.error('[LegionIntegration] Failed to fetch connections:', error);
        notifyUnity('FriendsManager', 'OnConnectionsReceived', '[]');
    }
};

/**
 * Send a connection request (friend request) to another user.
 * 
 * Possible response values:
 * - { success: true, status: 'accepted' } - Request was auto-accepted (they already sent you one)
 * - { success: true, status: 'pending' } - Request sent successfully
 * - { success: false, error: 'Not authenticated' } - User is not logged in
 * - { success: false, error: 'Invalid user ID' } - The provided user ID is invalid
 * - { success: false, error: 'Cannot send connection request to yourself' } - Tried to add yourself
 * - { success: false, error: 'Your account no longer exists' } - Current user account was deleted
 * - { success: false, error: 'User not found' } - Target user doesn't exist
 * - { success: false, error: 'Cannot send connection request to this user' } - User is blocked
 * - { success: false, error: 'Already connected' } - Already friends with this user
 * - { success: false, error: 'You have reached the maximum number of connections (100)' } - Too many friends
 * - { success: false, error: 'You have too many pending requests (max 20). Wait for responses or cancel some.' } - Too many pending requests
 * - { success: false, error: 'Connection request already pending' } - Request already sent
 * - { success: false, error: 'Network error' } - Network/API error occurred
 * 
 * @param {string} userId - The user ID to send the connection request to
 * @returns {Promise<{success: boolean, status?: 'accepted'|'pending', error?: string}>} - Result object
 */
window.sendLegionConnectionRequest = async function (userId) {
    await legionSdkInitPromise;
    return window.Legion.SDK.social.sendConnectionRequest(userId);
};

/**
 * Send a connection request and notify Unity with the result.
 * Useful for Unity C# interop where async isn't directly supported.
 * 
 * @param {string} userId - The user ID to send the connection request to
 */
window.sendLegionConnectionRequestForUnity = async function (userId) {
    try {
        const result = await window.sendLegionConnectionRequest(userId);
        notifyUnity('FriendsManager', 'OnConnectionRequestSent', JSON.stringify(result));
    } catch (error) {
        console.error('[LegionIntegration] Failed to send connection request:', error);
        notifyUnity('FriendsManager', 'OnConnectionRequestSent', JSON.stringify({
            success: false,
            error: 'Network error'
        }));
    }
};

/**
 * Invite a friend to join your current game/room.
 * Make sure to call updateLegionRoom(roomId) first!
 * 
 * @param {string} friendId - The friend's user ID (from connections list)
 * @returns {Promise<boolean>} - true if invite was sent successfully
 */
window.inviteLegionFriend = async function (friendId) {
    await legionSdkInitPromise;
    return window.Legion.SDK.social.inviteFriend(friendId);
};

/**
 * Invite a friend and notify Unity with the result.
 * Useful for Unity C# interop where async isn't directly supported.
 * 
 * @param {string} friendId - The friend's user ID
 */
window.inviteLegionFriendForUnity = async function (friendId) {
    try {
        const success = await window.inviteLegionFriend(friendId);
        notifyUnity('FriendsManager', 'OnInviteSent', success ? 'true' : 'false');
    } catch (error) {
        console.error('[LegionIntegration] Failed to send invite:', error);
        notifyUnity('FriendsManager', 'OnInviteSent', 'false');
    }
};

// Note: Avatar/Cosmetics API removed - skin/hat/back/pfp are stored in game DB
// and accessed via AuthManager.GetCurrentUser().skin, .hat, .back, .Pfp
// The game server syncs these from Legion on login.

// ============================================
// Legacy Invite Functions (for backward compatibility)
// ============================================
// Note: Room/party presence is now automatically tracked via updateLegionRoom()
// which is called by LegionListener when joining/leaving rooms/parties.

window.inviteLegion = function () {
    // Deprecated - room is tracked automatically
};

window.showInviteButton = function () {
    // Deprecated - invites handled by Legion portal
};

window.hideInviteButton = function () {
    // Deprecated - room is tracked automatically
};