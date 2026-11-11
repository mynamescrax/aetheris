// Exit intent detection based on mouse movement patterns
let lastMousePosition = { x: 0, y: 0 };
let lastMouseMoveTime = 0;
let lastActivityTime = Date.now();
let exitIntentDetected = false;
let cornerDetectionTimeout = null;
let afkTimeout = null;

// Configuration
const CORNER_THRESHOLD = 50; // pixels from corner to consider it a corner
const MOVEMENT_THRESHOLD = 3; // minimum pixels to consider it a movement
const TIME_THRESHOLD = 3000; // 3 seconds to detect slow movement
const SLOW_MOVEMENT_THRESHOLD = 100; // pixels per second to consider it slow movement
const AFK_THRESHOLD = 240000; // 4 minutes in milliseconds

// Check if device is a touch-only mobile device
function isTouchOnlyDevice() {
    // Check if device has touch capability
    const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    
    // Check if device is a mobile device (excluding tablets and laptops with touch)
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    
    // Check if device has a keyboard (laptops/desktops)
    const hasKeyboard = navigator.keyboard !== undefined;
    
    // Device is touch-only if it has touch, is mobile, and doesn't have a keyboard
    return hasTouch && isMobile && !hasKeyboard;
}

function sendExitIntentToUnity() {
    if (typeof unityInstance !== 'undefined') {
        unityInstance.SendMessage('WebUtils', 'OnExitIntent');
    }
}

function initExitIntentDetection() {
    // Only initialize if not a touch-only device
    if (isTouchOnlyDevice()) {
        console.log("[exit-intent] Touch-only device detected, exit intent detection disabled");
        return;
    }

    console.log("[exit-intent] Desktop device detected, exit intent detection enabled");
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseleave', handleMouseLeave);
    document.addEventListener('keydown', handleActivity);
    document.addEventListener('click', handleActivity);
    
    // Start AFK timer
    resetAFKTimer();
}

function handleActivity() {
    lastActivityTime = Date.now();
    resetAFKTimer();
}

function resetAFKTimer() {
    // Clear existing AFK timeout if any
    if (afkTimeout) {
        clearTimeout(afkTimeout);
    }
    
    // Set new AFK timeout
    afkTimeout = setTimeout(() => {
        if (!exitIntentDetected) {
            exitIntentDetected = true;
            console.log("[exit-intent] AFK exit intent detected after 4 minutes of inactivity");
            sendExitIntentToUnity();
        }
    }, AFK_THRESHOLD);
}

function handleMouseMove(e) {
    const currentTime = Date.now();
    const timeDiff = currentTime - lastMouseMoveTime;
    
    // Update last activity time
    lastActivityTime = currentTime;
    resetAFKTimer();
    
    // Calculate movement speed
    const distance = Math.sqrt(
        Math.pow(e.clientX - lastMousePosition.x, 2) + 
        Math.pow(e.clientY - lastMousePosition.y, 2)
    );
    const speed = distance / (timeDiff / 1000); // pixels per second

    // Check if mouse is in a corner and moving slowly
    const isInCorner = isMouseInCorner(e.clientX, e.clientY);
    const isMovingSlowly = speed < SLOW_MOVEMENT_THRESHOLD && distance > MOVEMENT_THRESHOLD;

    if (isInCorner && isMovingSlowly && !exitIntentDetected) {
        if (!cornerDetectionTimeout) {
            cornerDetectionTimeout = setTimeout(() => {
                if (isMouseInCorner(e.clientX, e.clientY)) {
                    exitIntentDetected = true;
                    console.log("[exit-intent] Corner exit intent detected - mouse moved slowly to corner for 3 seconds");
                    sendExitIntentToUnity();
                }
            }, TIME_THRESHOLD);
        }
    } else if (!isInCorner || !isMovingSlowly) {
        // Reset detection if mouse moves out of corner or moves too fast
        if (cornerDetectionTimeout) {
            clearTimeout(cornerDetectionTimeout);
            cornerDetectionTimeout = null;
        }
        exitIntentDetected = false;
    }

    // Update last position and time
    lastMousePosition = { x: e.clientX, y: e.clientY };
    lastMouseMoveTime = currentTime;
}

function handleMouseLeave(e) {
    // If mouse leaves through the top, consider it an exit intent
    if (e.clientY <= 0) {
        console.log("[exit-intent] Mouse left through top of window");
        sendExitIntentToUnity();
    }
}

function isMouseInCorner(x, y) {
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;

    // Check top-left corner
    if (x <= CORNER_THRESHOLD && y <= CORNER_THRESHOLD) {
        return true;
    }
    
    // Check top-right corner
    if (x >= windowWidth - CORNER_THRESHOLD && y <= CORNER_THRESHOLD) {
        return true;
    }

    return false;
}

// Initialize when the script loads
initExitIntentDetection(); 
