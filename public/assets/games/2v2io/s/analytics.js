
// Analytics helper functions for Unity WebGL

// Report scene playtime to GA4
// sceneName: string - The name of the scene (e.g., "map_city")
// gameMode: string - The game mode (e.g., "deathmatch")
// duration: number - Duration in seconds
window.reportScenePlaytime = function (sceneName, gameMode, duration) {
    if (typeof gtag === 'function') {
        gtag('event', 'scene_playtime', {
            'scene_name': sceneName,
            'game_mode': gameMode,
            'duration': duration,
            'value': duration // Useful for "average" metric calculations
        });
        // console.log(`[Analytics] Reported scene playtime: ${sceneName} (${gameMode}) - ${duration}s`);
    } else {
        console.warn("[Analytics] gtag not found, cannot report playtime.");
    }
};

