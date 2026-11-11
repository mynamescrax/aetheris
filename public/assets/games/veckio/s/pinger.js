const servers = [
    location.host + '/proxy/veck-usa-1',
    location.host + '/proxy/veck-usa-2',
    location.host + '/proxy/veck-usa-3',
    location.host + '/proxy/veck-usa-4',
    location.host + '/proxy/veck-usa-5',
    location.host + '/proxy/veck-fra-1',
    location.host + '/proxy/veck-fra-2',
    location.host + '/proxy/veck-fra-3',
    location.host + '/proxy/veck-asia-1',
    location.host + '/proxy/veck-asia-2',
];

function getRandomServer() {
    return servers[Math.floor(Math.random() * servers.length)];
}

async function fetchBestRegion() {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const randomServer = getRandomServer();
        try {
            const response = await fetch('https://' + randomServer + '/api/init');
            if (response.ok) {
                const data = await response.json();
                const bestRegion = data.region;
                console.log('Attempt ' + attempt + ': Best region from ' + randomServer + ': ' + bestRegion);
                return bestRegion;
            }
        } catch (error) {
            console.error('Attempt ' + attempt + ': Error from ' + randomServer, error);
        }
    }
    return 'USA';
}

localStorage.removeItem('bestServer');
fetchBestRegion().then(bestRegion => {
    console.log('Best region:', bestRegion);
    localStorage.setItem('bestServer', bestRegion);
}).catch(() => {
    localStorage.setItem('bestServer', 'USA');
});
