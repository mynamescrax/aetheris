//fingerprint
/*
window.deviceId = localStorage.getItem("device_id");
if (!window.deviceId) {
  const script = document.createElement('script');
  script.src = "https://openfpcdn.io/fingerprintjs/v3";
  script.async = true;
  script.onload = () => {
    FingerprintJS.load()
      .then(fp => fp.get())
      .then(result => {
        window.deviceId = result.visitorId;
        localStorage.setItem("device_id", window.deviceId);
      })
      .catch(() => {
        window.deviceId = crypto.randomUUID();
        localStorage.setItem("device_id", window.deviceId);
      });
  };
  script.onerror = () => {
    window.deviceId = crypto.randomUUID();
    localStorage.setItem("device_id", window.deviceId);
  };
  document.head.appendChild(script);
}
*/
//fingerprint-end


//iframe-detection
try {
  window.iframed = window.self !== window.top;
} catch (e) {
  window.iframed = true;
}
//iframe-detection-end

const useKeyboardApiOnFullscreen = true;

function setURLHash(param) {
  var hash = String(param);
  if (typeof history.replaceState === 'function') {
      if (hash) {
          history.replaceState(null, null, '#' + encodeURIComponent(hash));
      } else {
          history.replaceState(null, null, window.location.pathname + window.location.search);
      }
  } else {
      if (hash) {
          window.location.hash = encodeURIComponent(hash);
      } else {
          window.location.hash = '';
      }
  }
}



function getURLHash() {
    var hash = window.location.hash ? window.location.hash.substring(1) : null;
    return hash ? decodeURIComponent(hash) : null;
}

window.alert = function() {
    console.log('Blocked alert');
};

window.confirm = function() {
    console.log('Blocked confirm');
    return false;
};

window.prompt = function() {
    console.log('Blocked prompt');
    return null;
};

window.toggleFullscreen = toggleFullscreen;

function toggleFullscreen() {
  if (!document.fullscreenElement &&    // Standard browsers
      !document.mozFullScreenElement && // Firefox
      !document.webkitFullscreenElement && // Chrome, Safari, Opera
      !document.msFullscreenElement) {   // IE/Edge
    // Enter fullscreen mode
    enterFullScreenMode();
  } else {
    // Exit fullscreen mode
    exitFullscreenMode();
  }
}

window.enterFullScreenMode = enterFullScreenMode;

function enterFullScreenMode(){
  var elem = document.documentElement;
  if (elem.requestFullscreen) {
    elem.requestFullscreen();
  } else if (elem.mozRequestFullScreen) {
    elem.mozRequestFullScreen();
  } else if (elem.webkitRequestFullscreen) {
    elem.webkitRequestFullscreen();
  } else if (elem.msRequestFullscreen) {
    elem.msRequestFullscreen();
  }

  // Lock screen orientation
  if (screen.orientation && screen.orientation.lock) {
    screen.orientation.lock('landscape').catch(() => { /* Ignore errors */ });
  }

  // Use Keyboard Lock API if enabled and supported
  if (useKeyboardApiOnFullscreen && 'keyboard' in navigator && 'lock' in navigator.keyboard) {
    // Lock the ESC key immediately after entering fullscreen
    navigator.keyboard.lock(['Escape']).then(() => {
      console.log('ESC key locked.');
    }).catch(err => {
      console.error('Failed to lock keyboard:', err);
    });
  }
}
function exitFullscreenMode(){
  if (document.exitFullscreen) {
    document.exitFullscreen();
  } else if (document.mozCancelFullScreen) {
    document.mozCancelFullScreen();
  } else if (document.webkitExitFullscreen) {
    document.webkitExitFullscreen();
  } else if (document.msExitFullscreen) {
    document.msExitFullscreen();
  }

  // Unlock the keyboard
  if (useKeyboardApiOnFullscreen && 'keyboard' in navigator && 'unlock' in navigator.keyboard) {
    navigator.keyboard.unlock();
    console.log('Keyboard unlocked.');
  }
}

document.addEventListener('keydown', function(event) {
  if (event.key === 'Escape') {
    if (document.pointerLockElement) {
      document.exitPointerLock();
      console.log('Pointer unlocked due to ESC key press.');
    }
  }
});


window.addEventListener('beforeunload', function (e) {
  
  //if (!window.isPointerLocked)
  //  return;

  e.preventDefault();
  e.returnValue = '';
  return '';
});


function goToWindow(windowName) {
  const currentPath = window.location.pathname;
  const newPath = `/${windowName}`;
  if (currentPath === newPath) {
    return;
  }
  history.pushState({}, '', newPath);
}

window.addEventListener('popstate', function(event) {
  sendPopState();
});

function sendPopState() {
  unityInstance.SendMessage('BrowserHistoryManager', 'PopState', window.location.pathname);
}

async function setClipboard(stringToSetAsClipboard) {
  try {
      await navigator.clipboard.writeText(stringToSetAsClipboard);
      console.log('Text copied to clipboard successfully!');
  } catch (err) {
      console.error('Failed to copy text: ', err);
  }
}

function getClipboard() {
  navigator.clipboard.readText()
      .then((clipboardContent) => {
          unityInstanceWrapper.sendMessage('MainManager', 'OnGotClipboard', clipboardContent);
      })
      .catch((error) => {
          console.error('Clipboard access error:', error);
      });
}


// Prevent default scrolling behavior
window.addEventListener("wheel", (event) => event.preventDefault(), {
  passive: false,
});

// Prevent default actions for specific keys
window.addEventListener("keydown", (event) => {
  const key = event.key;
  const ctrlPressed = event.ctrlKey || event.metaKey; // For Mac compatibility

  // Prevent default actions for ArrowUp, ArrowDown, Space, Escape, and Ctrl+W
  if (
      ["ArrowUp", "ArrowDown"].includes(key) ||
      key === "Escape" ||
      (ctrlPressed && key.toLowerCase() === "w")
  ) {
      event.preventDefault();
  }
});


// Rare situation where the GPU resets
window.addEventListener("webglcontextlost", function (event) {
  event.preventDefault();
  console.warn("WebGL context lost. Reloading...");

  // Prevent unload blocker
  window.onbeforeunload = null;

  setTimeout(() => location.reload(), 100);
});
