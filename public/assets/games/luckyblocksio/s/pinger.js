// do not include dev-usa-1
const servers = [location.host + '/proxy/luckyblocks/usa-1',
    location.host + '/proxy/luckyblocks/usa-2'
];

function getRandomServer() {
  return servers[Math.floor(Math.random() * servers.length)];
}

async function fetchBestRegion() {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const randomServer = getRandomServer();
    try {
      const response = await fetch(`https://${randomServer}/api/init`);
      if (response.ok) {
        const data = await response.json();
        const bestRegion = data.region; // use the "region" from the response JSON
        console.log(
          `Attempt ${attempt}: Best region from server ${randomServer}: ${bestRegion}`,
        );
        return bestRegion;
      } else {
        console.error(
          `Attempt ${attempt}: Server ${randomServer} responded with status: ${response.status}`,
        );
      }
    } catch (error) {
      console.error(
        `Attempt ${attempt}: Error fetching best region from ${randomServer}:`,
        error,
      );
    }
  }
  console.error("All attempts failed. Falling back to default: USA");
  return "USA";
}

// If on playtest environment, always use DEV server (index 0)
if (window.location.href.includes("playtest.luckyblocks")) {
  console.log("Playtest environment detected. Using DEV server.");
  localStorage.setItem("bestServer", "DEV");
} else {
  const cachedBestServer = localStorage.getItem("bestServer");

  if (!cachedBestServer) {
    fetchBestRegion()
      .then((bestRegion) => {
        console.log(
          "Best region to connect (Saving to localStorage):",
          bestRegion,
        );
        localStorage.setItem("bestServer", bestRegion);
      })
      .catch((error) => {
        console.error("Error during region fetching:", error);
      });
  } else {
    console.log("Using cached best server:", cachedBestServer);
  }
}
