// Local Ads Fallback Provider Module
// This module provides local image fallbacks for ads
// 
// To enable clickable banners, set URLs in LOCAL_BANNER_LINKS:
// - Set to a URL string to make the banner clickable
// - Set to null to disable click functionality
// - Example: 0: 'https://example.com', 1: null, 2: 'https://another-site.com'

(function () {
    console.log("[local-ads.js] Module loading...");

    // Ensure global providers exist
    window.videoAdProviders = window.videoAdProviders || {};
    window.bannerAdProviders = window.bannerAdProviders || {};

    // Local banner image paths (adblock-safe names)
    const LOCAL_BANNER_IMAGES = {
        0: 'ads/local-ads-assets/a.png', // 300x250
        1: 'ads/local-ads-assets/b.png', // 728x90
        2: 'ads/local-ads-assets/c.png'  // 300x600
    };

    // Optional banner links (set to null to disable click functionality)
    const LOCAL_BANNER_LINKS = {
        0: 'https://fallzone.io/?utm_source=2v2&utm_medium=banner&utm_campaign=crosspromo', // 300x250
        1: 'https://veck.io/?utm_source=2v2&utm_medium=banner&utm_campaign=crosspromo', // 728x90 
        2: 'https://fallzone.io/?utm_source=2v2&utm_medium=banner&utm_campaign=crosspromo'  // 300x600
    };

    // Video ad provider implementation (simulated)
    window.videoAdProviders.local = {
        showMidroll: function (onSuccess, onFailure) {
            console.log(`[local-ads.js] showMidroll called - failing immediately`);
            onFailure();
        },

        showRewarded: function (onSuccess, onFailure) {
            console.log(`[local-ads.js] showRewarded called - failing immediately`);
            onFailure();
        }
    };

    // Banner ad provider implementation
    window.bannerAdProviders.local = {
        displayBanner: async function (bannerType, container) {
            console.log(`[local-ads.js] displayBanner for type: ${bannerType}`);

            const imagePath = LOCAL_BANNER_IMAGES[bannerType];
            if (!imagePath) {
                console.log(`[local-ads.js] No local image for banner type ${bannerType}`);
                return false;
            }

            // Get dimensions from global bannerDimensions
            const dims = window.bannerDimensions[bannerType];
            if (!dims) {
                console.log(`[local-ads.js] No dimensions for banner type ${bannerType}`);
                return false;
            }

            // Preload image and resolve true on success, false on failure
            return await new Promise((resolve) => {
                const testImg = new Image();
                testImg.onload = function () {
                    const img = document.createElement('img');
                    img.src = imagePath;
                    img.style.width = dims.width;
                    img.style.height = dims.height;
                    img.style.display = 'block';
                    img.style.cursor = 'pointer';
                    img.alt = `Local Banner ${dims.width}x${dims.height}`;

                    // Add click handler if link is configured
                    const bannerLink = LOCAL_BANNER_LINKS[bannerType];
                    if (bannerLink) {
                        img.addEventListener('click', function () {
                            console.log(`[local-ads.js] Banner clicked, opening: ${bannerLink}`);
                            window.open(bannerLink, '_blank', 'noopener,noreferrer');
                        });
                    } else {
                        // Still show pointer cursor but no click action
                        img.style.cursor = 'default';
                    }

                    container.innerHTML = '';
                    container.appendChild(img);
                    console.log(`[local-ads.js] Local banner displayed: ${imagePath}${bannerLink ? ` (clickable: ${bannerLink})` : ' (no link)'}`);
                    resolve(true);
                };
                testImg.onerror = function () {
                    console.log('[local-ads.js] Local image blocked/missing');
                    resolve(false);
                };
                testImg.src = imagePath;
            });
        }
    };

    console.log("[local-ads.js] Module loaded successfully");
})();
