// Proxy patch: redirect all stealnow.io requests through our server
(function() {
	const PROXY_MAP = {
		'https://files.stealnow.io':  '/proxy/stealnow-files',
		'https://usa-1.stealnow.io':  '/proxy/stealnow-usa-1',
		'https://dev-usa-1.stealnow.io': '/proxy/stealnow-dev-usa-1',
		'https://stealnow.io':        '/proxy/stealnow',
	};

	// WebSocket proxy map - routes game server WSS through wsproxy
	const WS_SERVERS = [
		'usa-1.stealnow.io',
		'dev-usa-1.stealnow.io',
	];

	function patchUrl(url) {
		if (typeof url !== 'string') return url;
		for (const [origin, prefix] of Object.entries(PROXY_MAP)) {
			if (url.startsWith(origin)) return url.replace(origin, prefix);
		}
		return url;
	}

	const origFetch = window.fetch;
	window.fetch = function(input, init) {
		if (typeof input === 'string') input = patchUrl(input);
		else if (input instanceof Request) input = new Request(patchUrl(input.url), input);
		return origFetch.call(this, input, init);
	};

	const origOpen = XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.open = function(method, url, ...rest) {
		return origOpen.call(this, method, patchUrl(url), ...rest);
	};

	// Patch WebSocket to route game servers through wsproxy
	const OrigWebSocket = window.WebSocket;
	window.WebSocket = function(url, protocols) {
		if (typeof url === 'string') {
			for (const server of WS_SERVERS) {
				if (url.includes(server)) {
					// Convert wss://usa-1.stealnow.io:443/path?query
					// to wss://aetheris.win/wsproxy/usa-1.stealnow.io:443/path?query
					const parsed = new URL(url);
					const hostPort = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
					const newUrl = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/wsproxy/' + hostPort + parsed.pathname + parsed.search;
					console.log('[SDK] WebSocket proxied:', url, '->', newUrl);
					url = newUrl;
					break;
				}
			}
		}
		return protocols ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
	};
	window.WebSocket.prototype = OrigWebSocket.prototype;
	window.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;
	window.WebSocket.OPEN = OrigWebSocket.OPEN;
	window.WebSocket.CLOSING = OrigWebSocket.CLOSING;
	window.WebSocket.CLOSED = OrigWebSocket.CLOSED;
})();

// ---- paste the rest of the original sdk.js below this line ----
const installProviders = [
    "adinplay",
    "cpmstar",
    "local"
];

const videoAdPriorities = [
    "cpmstar",
    "adinplay"
];

const bannerAdPriorities = [
    "adinplay",
    "cpmstar",
    "local"
];

// Global configuration
const DEBUG_MODE = window.location.href.includes('test') && false;
const IS_MOBILE = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
const MIN_REFRESH_INTERVAL = 22_000; // Minimum showtime before refresh
const BANNER_DEBOUNCE_TIME = 100;
const MAX_AIPTAG_WAIT_TIME = 1800;
const SHOWTIME_CHECK_INTERVAL = 1600; // Check showtime every 1.6 seconds

// Banner position names for logging
const POSITION_NAMES = {
    0: 'Hidden', 1: 'TopCenter', 2: 'TopRight', 3: 'TopLeft',
    4: 'BottomCenter', 5: 'BottomRight', 6: 'BottomLeft',
    7: 'MiddleCenter', 8: 'MiddleLeft', 9: 'MiddleRight',
    10: 'BelowTopLeft', 11: 'BelowTopRight', 12: 'AboveBottomLeft'
};

// Banner mappings and dimensions
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
            { ratio: 1.0, boost: 1.8 },
            { ratio: 1.62, boost: 1.2 },
            { ratio: 1.78, boost: 1.1 }
        ]
    },
    1: {
        width: '728px', height: '90px',
        scale: 1.3,
        enableForMobile: false,
        ratioBoostStops: [
            { ratio: 0, boost: 1.0 },
            { ratio: Infinity, boost: 1.0 }
        ]
    },
    2: {
        width: '300px', height: '600px',
        scale: 1.06,
        enableForMobile: false,
        ratioBoostStops: [
            { ratio: 1.0, boost: 1.9 },
            { ratio: 1.62, boost: 1.15 },
            { ratio: 1.78, boost: 1.0 }
        ]
    }
};

// Sort ratioBoostStops
Object.keys(window.bannerDimensions).forEach(key => {
    window.bannerDimensions[key].ratioBoostStops.sort((a, b) => a.ratio - b.ratio);
});

// Helper functions
function debounce(func, wait) {
    let timeout;
    return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

// Create promise for AdinPlay availability
window.waitForAdinPlay = function () {
    return new Promise((resolve) => {
        if (typeof aipDisplayTag !== "undefined") {
            resolve(true);
            return;
        }

        const timeoutId = setTimeout(() => {
            resolve(false);
        }, MAX_AIPTAG_WAIT_TIME);

        const checkInterval = setInterval(() => {
            if (typeof aipDisplayTag !== "undefined") {
                clearInterval(checkInterval);
                clearTimeout(timeoutId);
                resolve(true);
            }
        }, 100);
    });
};

// Load provider scripts dynamically
function loadProviderScript(provider) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `ads/adapters/${provider}-ads.js`;
        script.onload = () => {
            resolve();
        };
        script.onerror = () => {
            reject();
        };
        document.head.appendChild(script);
    });
}

// Load all configured providers
async function loadProviders() {
    for (const provider of installProviders) {
        try {
            await loadProviderScript(provider);
        } catch (e) {
            console.error(`Failed to load ${provider}:`, e);
        }
    }
}

// Main SDK object
window.SDK = {
    _isInitialized: false,
    _pendingBannerQueue: [],

    gameplayStart() {
        if (DEBUG_MODE) console.log("[sdk.js] Gameplay started");
    },

    loadingStart() {
        if (DEBUG_MODE) console.log("[sdk.js] Loading started");
        onWindowResize();
    },

    loadingEnd() {
        if (DEBUG_MODE) console.log("[sdk.js] Loading finished");
        onWindowResize();
    },

    gameplayEnd() {
        if (DEBUG_MODE) console.log("[sdk.js] Gameplay ended");
    },

    showMidroll() {
        if (window.ENABLE_ADS) {
            showAd('midroll');
        } else {
            if (typeof unityInstance !== 'undefined') {
                unityInstance.SendMessage("SDKManager", "OnVideoAdEnded", "true");
            }
        }
    },

    showRewarded() {
        if (window.ENABLE_ADS) {
            showAd('rewarded');
        } else {
            if (typeof unityInstance !== 'undefined') {
                unityInstance.SendMessage("SDKManager", "OnVideoAdEnded", "true");
            }
        }
    },

    _bannerAds: {},
    _occupiedPositions: {},
    _lastRefreshed: {},
    _pendingBannerOps: {},
    _bannerShowtime: {}, // Tracks accumulated visible time per banner
    _bannerVisibleSince: {}, // Tracks when banner became visible
    _showtimeInterval: null, // Interval for checking showtime

    _startTrackingShowtime(adTag) {
        const now = Date.now();
        if (!this._bannerVisibleSince[adTag]) {
            this._bannerVisibleSince[adTag] = now;
            if (DEBUG_MODE) console.log(`[sdk.js] Started tracking showtime for ${adTag}`);
        }
    },

    _stopTrackingShowtime(adTag) {
        if (this._bannerVisibleSince[adTag]) {
            const now = Date.now();
            const visibleDuration = now - this._bannerVisibleSince[adTag];
            this._bannerShowtime[adTag] = (this._bannerShowtime[adTag] || 0) + visibleDuration;
            delete this._bannerVisibleSince[adTag];
            if (DEBUG_MODE) console.log(`[sdk.js] Stopped tracking showtime for ${adTag}. Total showtime: ${Math.floor(this._bannerShowtime[adTag] / 1000)}s`);
        }
    },

    _resetShowtime(adTag) {
        this._bannerShowtime[adTag] = 0;
        delete this._bannerVisibleSince[adTag];
        if (DEBUG_MODE) console.log(`[sdk.js] Reset showtime for ${adTag}`);
    },

    _getCurrentShowtime(adTag) {
        let totalShowtime = this._bannerShowtime[adTag] || 0;
        if (this._bannerVisibleSince[adTag]) {
            const now = Date.now();
            totalShowtime += (now - this._bannerVisibleSince[adTag]);
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
            if (DEBUG_MODE) console.log(`[sdk.js] SetBanner: Invalid banner type ${bannerType}`);
            return;
        }

        if (IS_MOBILE && !dims.enableForMobile) {
            if (DEBUG_MODE) console.log(`[sdk.js] SetBanner: Banner ${adTag} disabled on mobile`);
            return;
        }

        // Get position name for logging
        const posName = POSITION_NAMES[bannerPosition] || `Position${bannerPosition}`;

        if (DEBUG_MODE) {
            console.log(`[sdk.js] SetBanner called: ${adTag} at ${posName}`);
        }

        this._pendingBannerOps[bannerType] = {
            bannerType: bannerType,
            bannerPosition: bannerPosition,
            timestamp: now
        };

        let existingInstance = this._bannerAds[adTag];

        // Handle hiding
        if (bannerPosition === 0) {
            if (DEBUG_MODE) console.log(`[sdk.js] Hiding banner ${adTag}`);
            if (existingInstance && existingInstance.container) {
                // Stop tracking showtime when hiding
                this._stopTrackingShowtime(adTag);

                existingInstance.container.style.display = "none";
                let oldPosKey = existingInstance.position.toString();
                if (this._occupiedPositions[oldPosKey] === adTag) {
                    delete this._occupiedPositions[oldPosKey];
                }
                existingInstance.position = 0;
                // Remove from pending operations since it's hidden
                delete this._pendingBannerOps[bannerType];
            }
            return;
        }

        // Handle existing banner
        if (existingInstance) {
            if (existingInstance.position === bannerPosition) {
                return;
            }

            // Move banner
            let oldPosKey = existingInstance.position.toString();
            if (this._occupiedPositions[oldPosKey] === adTag) {
                delete this._occupiedPositions[oldPosKey];
            }

            let newPosKey = bannerPosition.toString();
            if (this._occupiedPositions[newPosKey] && this._occupiedPositions[newPosKey] !== adTag) {
                let conflictAdTag = this._occupiedPositions[newPosKey];
                let conflictInstance = this._bannerAds[conflictAdTag];
                if (conflictInstance && conflictInstance.container) {
                    conflictInstance.container.style.display = "none";
                }
                delete this._occupiedPositions[newPosKey];
            }

            existingInstance.container.style.display = "block";
            updateContainerPosition(existingInstance.container, bannerPosition);
            existingInstance.position = bannerPosition;
            this._occupiedPositions[newPosKey] = adTag;

            // Start tracking showtime when showing
            this._startTrackingShowtime(adTag);

            // Check if we should refresh based on accumulated showtime
            const currentShowtime = this._getCurrentShowtime(adTag);
            const shouldRefresh = currentShowtime >= MIN_REFRESH_INTERVAL;

            if (shouldRefresh) {
                if (this._pendingBannerOps[bannerType]?.timestamp > now) {
                    return;
                }
                // Reset showtime counter before refresh
                this._resetShowtime(adTag);
                this._startTrackingShowtime(adTag);
                this._displayBannerWithProviders(bannerType, adTag, existingInstance.container, now);
            }
        } else {
            // Create new banner
            let posKey = bannerPosition.toString();

            if (this._occupiedPositions[posKey]) {
                let conflictAdTag = this._occupiedPositions[posKey];
                let conflictInstance = this._bannerAds[conflictAdTag];
                if (conflictInstance && conflictInstance.container) {
                    conflictInstance.container.style.display = "none";
                }
                delete this._occupiedPositions[posKey];
            }

            const container = document.createElement('div');
            container.className = 'banner-container';
            container.id = 'banner_' + adTag;
            container.style.position = 'absolute';
            container.style.zIndex = 1000;
            container.style.userSelect = 'none';
            container.style.pointerEvents = 'all';
            container.style.width = dims.width;
            container.style.height = dims.height;
            container.style.overflow = 'hidden';

            if (DEBUG_MODE) {
                container.style.backgroundColor = 'rgba(255, 255, 255, 0.2)';
            } else {
                container.style.backgroundColor = 'rgba(255, 255, 255, 0.2)';
            }

            const bannerDiv = document.createElement('div');
            bannerDiv.id = adTag;
            bannerDiv.style.width = dims.width;
            bannerDiv.style.height = dims.height;
            container.appendChild(bannerDiv);

            updateContainerPosition(container, bannerPosition);
            document.body.appendChild(container);

            this._bannerAds[adTag] = {
                bannerType: bannerType,
                adTag: adTag,
                container: container,
                position: bannerPosition
            };
            this._occupiedPositions[posKey] = adTag;

            // Start tracking showtime for new banner
            this._startTrackingShowtime(adTag);

            if (this._pendingBannerOps[bannerType]?.timestamp > now) {
                return;
            }

            this._displayBannerWithProviders(bannerType, adTag, container, now);
        }

        onWindowResize();
    },

    async _displayBannerWithProviders(bannerType, adTag, container, now) {
        let providerIndex = 0;
        const priorities = bannerAdPriorities;

        // Get position name for logging
        const bannerInstance = this._bannerAds[adTag];
        const posName = bannerInstance ? (POSITION_NAMES[bannerInstance.position] || `Position${bannerInstance.position}`) : 'Unknown';

        const tryNextProvider = async () => {
            if (providerIndex >= priorities.length) {
                if (DEBUG_MODE) console.log(`[sdk.js] All providers failed for banner ${adTag} at ${posName}`);
                return false;
            }

            const providerName = priorities[providerIndex];
            const provider = window.bannerAdProviders?.[providerName];

            if (!provider) {
                if (DEBUG_MODE) console.log(`[sdk.js] Provider ${providerName} not available for banner ${adTag}`);
                providerIndex++;
                return tryNextProvider();
            }

            if (DEBUG_MODE) console.log(`[sdk.js] Trying to show banner ${adTag} at ${posName} with provider: ${providerName}`);

            try {
                // Pass bannerType for CPMStar/Nitro/Local, adTag for AdinPlay
                const param = providerName === 'adinplay' ? adTag : bannerType;
                const success = await provider.displayBanner(param, container);

                if (success) {
                    if (DEBUG_MODE) console.log(`[sdk.js] Successfully showing banner ${adTag} at ${posName} with ${providerName}`);
                    this._lastRefreshed[adTag] = now;
                    // Reset showtime after successful refresh
                    this._resetShowtime(adTag);
                    this._startTrackingShowtime(adTag);
                    return true;
                } else {
                    if (DEBUG_MODE) console.log(`[sdk.js] Showing banner ${adTag} at ${posName} with ${providerName} FAILED, trying next...`);
                    providerIndex++;
                    return tryNextProvider();
                }
            } catch (error) {
                if (DEBUG_MODE) console.log(`[sdk.js] Error showing banner ${adTag} with ${providerName}:`, error.message || error);
                providerIndex++;
                return tryNextProvider();
            }
        };

        return tryNextProvider();
    }
};

// Debounced SetBanner with initialization queue
window.SDK.SetBanner = function (bannerType, bannerPosition) {
    // If not initialized and trying to show banner (not hide), queue it
    if (!window.SDK._isInitialized && bannerPosition !== 0) {
        if (DEBUG_MODE) console.log(`[sdk.js] SDK not initialized yet, queueing banner ${window.bannerMapping[bannerType] || bannerType} for position ${bannerPosition}`);

        // Check if we already have this banner type in queue
        const existingIndex = window.SDK._pendingBannerQueue.findIndex(item => item.bannerType === bannerType);
        if (existingIndex >= 0) {
            // Update existing entry with new position
            window.SDK._pendingBannerQueue[existingIndex].bannerPosition = bannerPosition;
        } else {
            // Add new entry
            window.SDK._pendingBannerQueue.push({ bannerType, bannerPosition });
        }
        return;
    }

    // If hiding banner (position 0), process immediately even if not initialized
    // This ensures we can remove queued banners
    if (bannerPosition === 0) {
        // Remove from queue if present
        window.SDK._pendingBannerQueue = window.SDK._pendingBannerQueue.filter(
            item => item.bannerType !== bannerType
        );

        // If initialized, hide the banner
        if (window.SDK._isInitialized) {
            window.SDK._originalSetBanner.call(window.SDK, bannerType, bannerPosition);
        }
    } else {
        // Normal debounced call for showing banners when initialized
        if (!window.SDK._debouncedSetBannerPerType) {
            window.SDK._debouncedSetBannerPerType = {};
        }

        if (!window.SDK._debouncedSetBannerPerType[bannerType]) {
            window.SDK._debouncedSetBannerPerType[bannerType] = debounce(
                (bannerType, bannerPosition) => {
                    window.SDK._originalSetBanner.call(window.SDK, bannerType, bannerPosition);
                },
                BANNER_DEBOUNCE_TIME
            );
        }

        window.SDK._debouncedSetBannerPerType[bannerType](bannerType, bannerPosition);
    }
};

// Container positioning helper
function updateContainerPosition(container, bannerPosition) {
    container.style.top = "";
    container.style.right = "";
    container.style.bottom = "";
    container.style.left = "";
    container.style.transformOrigin = "";

    switch (parseInt(bannerPosition)) {
        case 0:
            container.style.display = "none";
            break;
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
        case 12: // AboveBottomLeft
            container.style.display = "block";
            container.style.bottom = "12%";
            container.style.left = "1%";
            container.style.transformOrigin = "bottom left";
            break;
        case 7: // MiddleCenter
            container.style.display = "block";
            container.style.position = "absolute";
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
    }
}

// Video ad system
function showAd(adType) {
    let providerIndex = 0;
    const priorities = videoAdPriorities;

    function tryNextProvider() {
        if (providerIndex >= priorities.length) {
            if (typeof unityInstance !== 'undefined') {
                unityInstance.SendMessage("SDKManager", "OnVideoAdEnded", "false");
            }
            return;
        }

        const providerName = priorities[providerIndex];
        const provider = window.videoAdProviders?.[providerName];

        if (!provider) {
            providerIndex++;
            tryNextProvider();
            return;
        }

        const methodName = adType === 'rewarded' ? 'showRewarded' : 'showMidroll';

        provider[methodName](
            function () {
                if (typeof unityInstance !== 'undefined') {
                    unityInstance.SendMessage("SDKManager", "OnVideoAdEnded", "true");
                }
            },
            function () {
                providerIndex++;
                tryNextProvider();
            }
        );
    }

    tryNextProvider();
}

// Window resize handling
function getRatioBoost(stops, aspect) {
    stops.sort((a, b) => a.ratio - b.ratio);
    if (aspect <= stops[0].ratio) return stops[0].boost;
    if (aspect >= stops.at(-1).ratio) return stops.at(-1).boost;
    for (let i = 0; i < stops.length - 1; i++) {
        const a = stops[i], b = stops[i + 1];
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
    const baseScale = Math.min(w / 1920, h / 960);

    Object.keys(window.bannerMapping).forEach(key => {
        const tag = window.bannerMapping[key];
        const dims = window.bannerDimensions[key];
        const ctr = document.getElementById('banner_' + tag);
        if (!ctr || (IS_MOBILE && !dims.enableForMobile)) return;

        const boost = getRatioBoost(dims.ratioBoostStops, aspect);
        const finalScale = baseScale * dims.scale * boost;
        ctr.style.transform = `scale(${finalScale})`;
    });
}

window.addEventListener("resize", onWindowResize);

// Showtime-based refresh system
window.SDK._showtimeInterval = setInterval(async function () {
    if (!window.ENABLE_ADS) return;

    const now = Date.now();

    // Update showtime for all visible banners
    Object.keys(window.SDK._bannerAds).forEach(adTag => {
        const banner = window.SDK._bannerAds[adTag];

        if (window.SDK._isBannerVisible(banner)) {
            // Banner is visible - ensure we're tracking it
            if (!window.SDK._bannerVisibleSince[adTag]) {
                window.SDK._startTrackingShowtime(adTag);
            }

            // Check if it's time to refresh based on showtime
            const currentShowtime = window.SDK._getCurrentShowtime(adTag);
            if (currentShowtime >= MIN_REFRESH_INTERVAL) {
                if (DEBUG_MODE) console.log(`[sdk.js] Banner ${adTag} reached ${Math.floor(currentShowtime / 1000)}s showtime, refreshing...`);

                const bannerType = Object.keys(window.bannerMapping).find(key => window.bannerMapping[key] === adTag);
                if (bannerType !== undefined) {
                    // Reset showtime before refresh
                    window.SDK._resetShowtime(adTag);
                    window.SDK._startTrackingShowtime(adTag);
                    window.SDK._displayBannerWithProviders(parseInt(bannerType), adTag, banner.container, now);
                }
            }
        } else {
            // Banner is not visible - stop tracking if we were
            if (window.SDK._bannerVisibleSince[adTag]) {
                window.SDK._stopTrackingShowtime(adTag);
            }
        }
    });
}, SHOWTIME_CHECK_INTERVAL);

// Handle page visibility changes for showtime tracking
document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
        // Page is hidden - stop tracking all visible banners
        Object.keys(window.SDK._bannerAds).forEach(adTag => {
            if (window.SDK._bannerVisibleSince[adTag]) {
                window.SDK._stopTrackingShowtime(adTag);
            }
        });
    } else if (window.ENABLE_ADS) {
        // Page is visible again - restart tracking for visible banners
        Object.keys(window.SDK._bannerAds).forEach(adTag => {
            const banner = window.SDK._bannerAds[adTag];
            if (window.SDK._isBannerVisible(banner)) {
                window.SDK._startTrackingShowtime(adTag);
            }
        });
    }
});

// Process queued banners after initialization
window.SDK._processQueuedBanners = function () {
    if (DEBUG_MODE && window.SDK._pendingBannerQueue.length > 0) {
        console.log(`[sdk.js] Processing ${window.SDK._pendingBannerQueue.length} queued banner(s)`);
    }

    // Process each queued banner
    const queue = [...window.SDK._pendingBannerQueue];
    window.SDK._pendingBannerQueue = [];

    queue.forEach(({ bannerType, bannerPosition }) => {
        if (DEBUG_MODE) {
            const adTag = window.bannerMapping[bannerType] || bannerType;
            console.log(`[sdk.js] Processing queued banner: ${adTag} at position ${bannerPosition}`);
        }
        // Use SetBanner to ensure debouncing still applies
        window.SDK.SetBanner(bannerType, bannerPosition);
    });
};

// Initialize
(async function () {
    if (DEBUG_MODE) console.log("[sdk.js] Starting SDK initialization...");

    await loadProviders();

    // Mark as initialized
    window.SDK._isInitialized = true;
    if (DEBUG_MODE) console.log("[sdk.js] SDK initialized, providers loaded");

    // Process any queued banners
    window.SDK._processQueuedBanners();

    window.SDK.loadingStart();
})();
