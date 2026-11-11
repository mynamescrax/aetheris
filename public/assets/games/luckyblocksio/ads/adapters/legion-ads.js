// Legion Ad Provider Module
// Serves banners from the Legion platform ad inventory when the game
// is embedded inside legionsdk.com. Falls through to the next provider otherwise.

(function () {
    const log = (...args) => window.ADS_DEBUG && console.log(...args);

    log("[legion-ads.js] Module loading...");

    window.videoAdProviders = window.videoAdProviders || {};
    window.bannerAdProviders = window.bannerAdProviders || {};

    const LEGION_API_PROD = 'https://api.legionsdk.com';
    const LEGION_API_DEV = 'http://localhost:4000';

    const BANNER_SIZE_MAP = {
        0: '300x250',
        1: '728x90',
        2: '300x600'
    };

    function isOnLegion() {
        if (window.self === window.top) return false;
        try {
            const ref = document.referrer || '';
            return ref.includes('legionsdk.com') || ref.includes('localhost:3000');
        } catch {
            return false;
        }
    }

    function getApiBase() {
        const ref = document.referrer || '';
        if (ref.includes('localhost')) return LEGION_API_DEV;
        return LEGION_API_PROD;
    }

    // Video ads: not supported via Legion yet, fall through
    window.videoAdProviders.legion = {
        showMidroll: function (_onSuccess, onFailure) {
            log('[legion-ads.js] showMidroll - not supported, falling through');
            onFailure();
        },
        showRewarded: function (_onSuccess, onFailure) {
            log('[legion-ads.js] showRewarded - not supported, falling through');
            onFailure();
        }
    };

    window.bannerAdProviders.legion = {
        displayBanner: async function (bannerType, container) {
            log(`[legion-ads.js] displayBanner for type: ${bannerType}`);

            if (!isOnLegion()) {
                log('[legion-ads.js] Not embedded in Legion, skipping');
                return false;
            }

            const size = BANNER_SIZE_MAP[bannerType];
            if (!size) {
                log(`[legion-ads.js] Unknown banner type ${bannerType}`);
                return false;
            }

            const dims = window.bannerDimensions[bannerType];
            if (!dims) {
                log(`[legion-ads.js] No dimensions for banner type ${bannerType}`);
                return false;
            }

            const apiBase = getApiBase();

            try {
                const resp = await fetch(`${apiBase}/v1/ads/serve?size=${size}`);

                if (resp.status === 204 || !resp.ok) {
                    log(`[legion-ads.js] No ad available (status ${resp.status})`);
                    return false;
                }

                const ad = await resp.json();
                if (!ad || !ad.imageUrl) {
                    log('[legion-ads.js] Invalid ad response');
                    return false;
                }

                const imageUrl = ad.imageUrl.startsWith('http')
                    ? ad.imageUrl
                    : `${apiBase}${ad.imageUrl.startsWith('/') ? '' : '/'}${ad.imageUrl}`;

                return await new Promise((resolve) => {
                    const testImg = new Image();
                    testImg.onload = function () {
                        const img = document.createElement('img');
                        img.src = imageUrl;
                        img.style.width = dims.width;
                        img.style.height = dims.height;
                        img.style.display = 'block';
                        img.style.cursor = ad.clickUrl ? 'pointer' : 'default';
                        img.alt = `Legion Ad ${size}`;

                        if (ad.clickUrl) {
                            img.addEventListener('click', function () {
                                log(`[legion-ads.js] Ad clicked (${ad.id}), opening: ${ad.clickUrl}`);
                                fetch(`${apiBase}/v1/ads/click/${ad.id}`, { method: 'POST' }).catch(() => {});
                                window.open(ad.clickUrl, '_blank', 'noopener,noreferrer');
                            });
                        }

                        container.innerHTML = '';
                        container.appendChild(img);
                        log(`[legion-ads.js] Legion ad displayed: ${size} (id: ${ad.id})`);
                        resolve(true);
                    };
                    testImg.onerror = function () {
                        log(`[legion-ads.js] Failed to load ad image: ${imageUrl}`);
                        resolve(false);
                    };
                    testImg.src = imageUrl;
                });
            } catch (err) {
                log('[legion-ads.js] Fetch error:', err);
                return false;
            }
        }
    };

    log("[legion-ads.js] Module loaded successfully");
})();
