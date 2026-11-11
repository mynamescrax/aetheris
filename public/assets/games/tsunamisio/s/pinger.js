// do not include dev-usa-1
const servers = [
    'usa-1.tsunamis.io',
    'usa-2.tsunamis.io',
    'usa-3.tsunamis.io'
];

// Regions the game server actually supports. If we get something else, remap it.
const REGION_MAP = {
    'USA': 'USA',
    'EUROPE': 'USA', // game has no EUROPE pool, fall back to USA
    'ASIA': 'ASIA',
};

function getRandomServer() {
    return servers[Math.floor(Math.random() * servers.length)];
}

async function fetchBestRegion() {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const randomServer = getRandomServer();
        try {
            const response = await fetch(`/tsunamis/${randomServer.split('.')[0]}/api/init`);
            if (response.ok) {
                const data = await response.json();
                const raw = data.region;
                const bestRegion = REGION_MAP[raw] || 'USA';
                console.log(`Attempt ${attempt}: Best region from server ${randomServer}: ${raw} -> ${bestRegion}`);
                return bestRegion;
            } else {
                console.error(`Attempt ${attempt}: Server ${randomServer} responded with status: ${response.status}`);
            }
        } catch (error) {
            console.error(`Attempt ${attempt}: Error fetching best region from ${randomServer}:`, error);
        }
    }
    console.error('All attempts failed. Falling back to default: USA');
    return 'USA';
}

// If on playtest environment, always use DEV server
if (window.location.href.includes('playtest.tsunamis')) {
    console.log('Playtest environment detected. Using DEV server.');
    localStorage.setItem('bestServer', 'DEV');
} else {
    // Always re-fetch — don't trust a cached EUROPE value from a previous session
    localStorage.removeItem('bestServer');
    fetchBestRegion().then(bestRegion => {
        console.log('Best region to connect (Saving to localStorage):', bestRegion);
        localStorage.setItem('bestServer', bestRegion);
    }).catch(error => {
        console.error('Error during region fetching:', error);
        localStorage.setItem('bestServer', 'USA');
    });
}