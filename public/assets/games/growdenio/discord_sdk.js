const DISCORD_APP_ID = "1395623586667954256";
const DISCORD_LOGIN_URL = `https://${DISCORD_APP_ID}.discordsays.com/.proxy/usa-1/api/accounts/login/discord`;
const DISCORD_SERVER_INVITE_LINK = "https://www.youtube.com/watch?v=QDia3e12czc";

console.log("[discord_sdk.js] Initializing");
let currentParticipantCount = 1;

// Helper function to wait for unityInstance to be available
async function waitForUnityInstance() {
  return new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      if (typeof unityInstance !== 'undefined' && unityInstance) {
        clearInterval(checkInterval);
        // Wait an additional 0.3 seconds to ensure Unity can handle the message
        setTimeout(() => {
          resolve();
        }, 300);
      }
    }, 50); // Check every 50ms
  });
}

// Helper function to safely send messages to Unity
async function sendMessageToUnity(gameObject, methodName, parameter = "") {
  // If unityInstance is already available, send message immediately
  if (typeof unityInstance !== 'undefined' && unityInstance) {
    unityInstance.SendMessage(gameObject, methodName, parameter);
    return;
  }
  
  // Otherwise, wait for it to become available (with the 0.3s delay)
  await waitForUnityInstance();
  unityInstance.SendMessage(gameObject, methodName, parameter);
}

window.SDK = {
  // Cache for login data (instance-only)
  cachedDiscordData: null,

  async loginWithDiscord() {
    try {
      await window.DiscordSdkInstance.ready();
      console.log("[discord_sdk.js] Discord SDK is ready for login.");

      // Check for cached data in this instance
      if (window.SDK.cachedDiscordData) {
        console.log("[discord_sdk.js] Using cached login data.");
        await sendMessageToUnity(
          'AuthManager',
          'ProcessJsonAfterLogin',
          JSON.stringify(window.SDK.cachedDiscordData)
        );
        return window.SDK.cachedDiscordData;
      }

      // Proceed with new login if no cache available
      const { code } = await window.DiscordSdkInstance.commands.authorize({
        client_id: DISCORD_APP_ID,
        response_type: "code",
        state: "",
        prompt: "none",
        scope: [
            "identify",
            "email",
            "guilds",
            "applications.commands",
            //@podonnell: removed when fixing IAPs to use Bot Token
            "applications.entitlements",
            // "applications.store.update",
        ],
              
      });
      console.log("[discord_sdk.js] Received authorization code:", code);

      const response = await fetch(DISCORD_LOGIN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code })
      });

      if (response.ok) {
        const data = await response.json();
        const discordAccessToken = data.discordAccessToken;
        console.log("[discord_sdk.js] Received access token from backend:", discordAccessToken);

        const auth = await window.DiscordSdkInstance.commands.authenticate({
          access_token: discordAccessToken,
        });
        if (!auth) throw new Error("Authentication failed.");
        console.log("[discord_sdk.js] Successfully logged in with Discord.");
        window.SDK.auth = auth;

        // Cache the login data (instance only)
        window.SDK.cachedDiscordData = data;

        // Send the full JSON response to Unity
        await sendMessageToUnity(
          'AuthManager',
          'ProcessJsonAfterLogin',
          JSON.stringify(data)
        );
        return data;
      } else {
        const errorData = await response.json().catch(() => ({}));
        console.error('[discord_sdk.js] Login failed:', errorData.error || `Status ${response.status}`);
        return errorData;
      }
    } catch (error) {
      console.error("[discord_sdk.js] Login with Discord failed:", error);
      throw error;
    }
  },

  async getCurrentUserInfo() {
    try {
      await window.DiscordSdkInstance.ready();
      if (!window.SDK.auth) {
        console.log("[discord_sdk.js] Not authenticated. Logging in...");
        await window.SDK.loginWithDiscord();
      }
      //const user = await window.DiscordSdkInstance.Users.getCurrentUser();
      const user = await window.DiscordSdkInstance.commands.execute("GET_USER", {});
      console.log("[discord_sdk.js] Current user:", user);
      return user;
    } catch (error) {
      console.error("[discord_sdk.js] Failed to get current user:", error);
      throw error;
    }
  },

  gameplayStart() {
    console.log("[discord_sdk.js] Gameplay started");
  },
  loadingStart() {
    console.log("[discord_sdk.js] Loading started");
  },
  loadingEnd() {
    console.log("[discord_sdk.js] Loading finished");
  },
  gameplayEnd() {
    console.log("[discord_sdk.js] Gameplay ended");
  },
  async showMidroll() {
    console.log("[discord_sdk.js] Ads are disabled; simulating success callback.");
    if (typeof unityInstance !== 'undefined') {
      await sendMessageToUnity("SDKManager", "OnVideoAdEnded", "true");
    }
  },
  showRewarded() {
    // Implement if needed
  },
  getBuildURL() {
    return "/.proxy/Build";
  },
  getStreamingAssetsUrl() {
    return "/.proxy/StreamingAssets";
  },
  getStaticResolutionScaleMulti() {
    return 1.48;
  },
  async inviteFriend() {
    if (!window.DiscordSdkInstance) {
      console.warn("[discord_sdk.js] No Discord SDK instance found.");
      return;
    }
  
    try {
      await window.DiscordSdkInstance.commands.openInviteDialog();
  
      console.log("[discord_sdk.js] Invite UI opened via openInviteDialog().");
  
      if (typeof unityInstance !== 'undefined') {
        await sendMessageToUnity("SDKManager", "OnOpenDiscordInviteDialogSuccess");
      }
    } catch (e) {
      console.warn("[discord_sdk.js] Failed to open Invite UI:", e.message);
  
      //if (typeof unityInstance !== 'undefined') {
      //  await sendMessageToUnity("DiscordPlayButton", "OnOpenDiscordInviteDialogError");
      //}

      // Instead, simply fallback to this:
      window.SDK.shareActivity();
    }
  },
  getParticipantCount() {
    return currentParticipantCount.toString();
  },
  getChannelID() {
    const channelId = window.DiscordSdkInstance?.channelId;
    const activityInstanceId = window.DiscordSdkInstance?.activityInstanceId;
    if (channelId) {
      console.log(`[discord_sdk.js] Retrieved channelId=${channelId} (activityInstanceId=${activityInstanceId})`);
      return channelId;
    }
    if (activityInstanceId) {
      console.log(`[discord_sdk.js] Fallback: Retrieved activityInstanceId=${activityInstanceId}`);
      return activityInstanceId;
    }
    console.warn("[discord_sdk.js] Neither channelId nor activityInstanceId is available.");
    return "";
  },

  // Share this activity with others using Discord's built-in share UI
  async shareActivity() {
    if (!window.DiscordSdkInstance) {
      console.warn("[discord_sdk.js] No Discord SDK instance found.");
      return;
    }

    try {
      await window.DiscordSdkInstance.commands.shareActivity();
      console.log("[discord_sdk.js] Activity share UI opened successfully");
      
      if (typeof unityInstance !== 'undefined') {
        await sendMessageToUnity("SDKManager", "OnShareActivitySuccess");
      }
    } catch (e) {
      console.warn("[discord_sdk.js] Failed to open activity share UI:", e.message);
      
      if (typeof unityInstance !== 'undefined') {
        await sendMessageToUnity("SDKManager", "OnShareActivityError");
      }
    }
  },

  // Open Discord's server invite UI using their openExternalLink command
  async joinDiscordServer() {
    if (!window.DiscordSdkInstance) {
      console.warn("[discord_sdk.js] No Discord SDK instance found.");
      return;
    }

    try {
      const result = await window.DiscordSdkInstance.commands.openExternalLink({ url: DISCORD_SERVER_INVITE_LINK });
      
      console.log("[discord_sdk.js] Discord server invite opened:", result);
      
      if (typeof unityInstance !== 'undefined') {
        await sendMessageToUnity("SDKManager", "OnOpenDiscordServerInviteSuccess");
      }
    } catch (e) {
      console.warn("[discord_sdk.js] Failed to open Discord server invite:", e.message);
      
      if (typeof unityInstance !== 'undefined') {
        await sendMessageToUnity("SDKManager", "OnOpenDiscordServerInviteError");
      }
    }
  },

  // Simple Discord purchase - like Xsolla, just "buy X"
  async purchaseDiscordSKU(skuId) {
    try {
      await window.DiscordSdkInstance.ready();
      console.log(`[discord_sdk.js] Starting Discord purchase for SKU: ${skuId}`);
      
      const result = await window.DiscordSdkInstance.commands.startPurchase({
        sku_id: skuId
      });
      
      console.log("[discord_sdk.js] Discord purchase completed:", result);
      
      // Notify Unity - Discord webhooks will handle backend (secure)
      const response = {
        success: true,
        sku_id: skuId,
        result: result
      };
      
      if (typeof unityInstance !== 'undefined') {
        await sendMessageToUnity("DiscordIapManager", "OnDiscordPurchaseComplete", JSON.stringify(response));
      }
      
      return response;
    } catch (error) {
      console.error("[discord_sdk.js] Discord purchase failed:", error);
      
      const errorResponse = {
        success: false,
        sku_id: skuId,
        error: error.message || "Purchase failed"
      };
      
      if (typeof unityInstance !== 'undefined') {
        await sendMessageToUnity("DiscordIapManager", "OnDiscordPurchaseComplete", JSON.stringify(errorResponse));
      }
      
      return errorResponse;
    }
  },
  async initialize() {
    try {
      window.DiscordSdkInstance = new window.DiscordSDK.DiscordSDK(DISCORD_APP_ID, {
        disableConsoleLogOverride: true
      });
      await window.DiscordSdkInstance.ready();
      console.log("[discord_sdk.js] Discord SDK is fully ready.");

      async function updateParticipantCount() {
        try {
          const response = await window.DiscordSdkInstance.commands.getInstanceConnectedParticipants();
          console.log("getInstanceConnectedParticipants response:", response);
          currentParticipantCount = response.participants.length;
          console.log("[discord_sdk.js] Updated participant count:", currentParticipantCount);
        } catch (error) {
          console.error("[discord_sdk.js] Error fetching participants:", error);
        }
      }
      
      updateParticipantCount();
      setInterval(updateParticipantCount, 5000);
      await window.SDK.getCurrentUserInfo();
    } catch (error) {
      console.error("[discord_sdk.js] Initialization error:", error);
    }
  }
};

// Global function for Discord login that directly calls loginWithDiscord.
window.loginDiscord = async function() {
  try {
    await window.DiscordSdkInstance.ready();
    return await window.SDK.loginWithDiscord();
  } catch (error) {
    console.error("[discord_sdk.js] loginDiscord failed:", error);
    throw error;
  }
};

// Simple Discord purchase function - works like Xsolla with webhooks
window.purchaseDiscordSKU = async function(skuId) {
  try {
    return await window.SDK.purchaseDiscordSKU(skuId);
  } catch (error) {
    console.error("[discord_sdk.js] purchaseDiscordSKU failed:", error);
    return { success: false, error: error.message };
  }
};

// Inject Discord SDK script, patch URL mappings, then initialize our instance.
(function loadDiscordSdkScript() {
  const script = document.createElement("script");
  script.src = "/s/discord.min.js";
  script.onload = function () {
    if (window.DiscordSDK?.patchUrlMappings instanceof Function) {
      window.DiscordSDK.patchUrlMappings([
        { prefix: '/files', target: 'files.growden.io' },
        { prefix: '/fra-1', target: 'fra-1.growden.io' },
        { prefix: '/fra-2', target: 'fra-2.growden.io' },
        { prefix: '/fra-3', target: 'fra-3.growden.io' },
        { prefix: '/fra-4', target: 'fra-4.growden.io' },
        { prefix: '/fra-5', target: 'fra-5.growden.io' },
        { prefix: '/asia-1', target: 'asia-1.growden.io' },
        { prefix: '/asia-2', target: 'asia-2.growden.io' },
        { prefix: '/asia-3', target: 'asia-3.growden.io' },
        { prefix: '/asia-4', target: 'asia-4.growden.io' },
        { prefix: '/asia-5', target: 'asia-5.growden.io' },
        { prefix: '/usa-1', target: 'usa-1.growden.io' },
        { prefix: '/usa-2', target: 'usa-2.growden.io' },
        { prefix: '/usa-3', target: 'usa-3.growden.io' },
        { prefix: '/usa-4', target: 'usa-4.growden.io' },
        { prefix: '/usa-5', target: 'usa-5.growden.io' },
        { prefix: '/dev-usa-1', target: 'dev-usa-1.growden.io' },
        { prefix: '/growden', target: 'growden.io' },
        { prefix: '/bytebrew', target: 'bytebrew.io' },
        { prefix: '/bytebrew-api', target: 'web-platform.bytebrew.io' },
        // Cloudflare Turnstile domains
        { prefix: '/cf-challenges', target: 'challenges.cloudflare.com' },
        { prefix: '/cloudflare', target: 'cloudflare.com' },
        { prefix: '/cf-assets', target: 'cf-assets.com' },
        { prefix: '/cf-insights', target: 'cloudflareinsights.com' },
        { prefix: '/cf-cdnjs', target: 'cdnjs.cloudflare.com' },
        // Additional Cloudflare domains for comprehensive coverage
        { prefix: '/cf-static-insights', target: 'static.cloudflareinsights.com' },
        { prefix: '/cf-workers', target: 'workers.cloudflare.com' },
        { prefix: '/cf-dash', target: 'dash.cloudflare.com' },
        { prefix: '/cf-api', target: 'api.cloudflare.com' },
        { prefix: '/cf-www', target: 'www.cloudflare.com' },
        { prefix: '/cf-radar', target: 'radar.cloudflare.com' },
        { prefix: '/cf-pages', target: 'pages.cloudflare.com' },
        { prefix: '/cf-dns', target: '1.1.1.1' },
        { prefix: '/cf-dns-alt', target: 'cloudflare-dns.com' },
        { prefix: '/cf-warp', target: 'warp.plus' },
        { prefix: '/cf-chl', target: 'cf-chl.com' },
        { prefix: '/cf-quic', target: 'cloudflare-quic.com' },
        { prefix: '/cf-turnstile', target: 'turnstile.cloudflare.com' }
      ]);
      console.log("[discord_sdk.js] patchUrlMappings applied");
    }
    window.SDK.initialize();
  };
  script.onerror = function () {
    console.error("[discord_sdk.js] Failed to load discord.min.js");
  };
  document.head.appendChild(script);
})();
