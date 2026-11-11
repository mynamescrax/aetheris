//v8
document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('unity-canvas');
  if (!canvas) {
    console.error("Canvas element with id='unity-canvas' not found!");
    return;
  }

  // Track lock state
  window.isPointerLocked = false;

  // Utility: Check if pointer lock API is available
  function hasPointerLockAPI() {
    return !!(canvas.requestPointerLock ||
              canvas.webkitRequestPointerLock ||
              canvas.mozRequestPointerLock);
  }

  // Safari detection
  function isSafari() {
    // This UA check excludes Chrome on iOS
    return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  }

  // Called when pointer lock state changes
  function onPointerLockChange() {
    const doc = document;
    const locked = (
      doc.pointerLockElement === canvas ||
      doc.webkitPointerLockElement === canvas ||
      doc.mozPointerLockElement === canvas
    );
    window.isPointerLocked = locked;

    if (locked) {
      console.log("----cursor locking----");
      canvas.style.cursor = "none";
    } else {
      console.log("----cursor unlocking----");
      canvas.style.cursor = "default";
    }

    sendLockStateToUnity(locked);
  }

  // Called when pointer lock errors out
  function onPointerLockError(event) {
    console.error("----pointer lock error----", event);
    sendLockStateToUnity(false);
    // For macOS Safari: add a one-time mousedown fallback if pointer isn't locked.
    if (isSafari() && !window.isPointerLocked) {
      console.log("----Safari fallback: adding one-time mousedown listener for pointer lock----");
      canvas.addEventListener('mousedown', function fallbackMouseDown(e) {
        console.log("----Fallback mousedown triggered, retrying pointer lock----");
        lockPointerNow();
      }, { once: true });
    }
  }

  // Listen for pointer lock changes/errors (all vendor prefixes)
  document.addEventListener('pointerlockchange', onPointerLockChange, false);
  document.addEventListener('webkitpointerlockchange', onPointerLockChange, false);
  document.addEventListener('mozpointerlockchange', onPointerLockChange, false);

  document.addEventListener('pointerlockerror', onPointerLockError, false);
  document.addEventListener('webkitpointerlockerror', onPointerLockError, false);
  document.addEventListener('mozpointerlockerror', onPointerLockError, false);

  // Send pointer lock state back to Unity
  function sendLockStateToUnity(isLocked) {
    if (typeof unityInstance !== 'undefined' && unityInstance.SendMessage) {
      unityInstance.SendMessage('CursorController', 'OnLockChange', isLocked ? 'true' : 'false');
    }
  }

  // Attempt to lock pointer
  async function lockPointerNow() {
    console.log("----attempting pointer lock----");

    if (!hasPointerLockAPI()) {
      console.warn("----Pointer lock API not supported in this browser----");
      sendLockStateToUnity(false);
      return;
    }

    // If Safari, skip the options param
    if (isSafari()) {
      console.log("----Safari detected; skipping unadjustedMovement param----");
      try {
        if (canvas.webkitRequestPointerLock) {
          canvas.webkitRequestPointerLock();
        } else {
          canvas.requestPointerLock();
        }
      } catch (err) {
        console.error("----Safari pointer lock request failed----", err);
        sendLockStateToUnity(false);
      }
    } else {
      // Non-Safari: Try the standard approach with unadjustedMovement
      try {
        if (navigator.permissions && navigator.permissions.query) {
          try {
            const permStatus = await navigator.permissions.query({ name: 'pointer-lock' });
            console.log(`----pointer lock permission state: ${permStatus.state}----`);
          } catch (permError) {
            console.warn("----Permissions API not supported or query failed----", permError);
          }
        }
        if (canvas.requestPointerLock) {
          await canvas.requestPointerLock({ unadjustedMovement: true });
        } else if (canvas.webkitRequestPointerLock) {
          await canvas.webkitRequestPointerLock({ unadjustedMovement: true });
        } else if (canvas.mozRequestPointerLock) {
          await canvas.mozRequestPointerLock({ unadjustedMovement: true });
        }
        console.log("----pointer lock request initiated for non-Safari browser----");
      } catch (err) {
        console.error("----pointer lock request failed (non-Safari)----", err);
        sendLockStateToUnity(false);
      }
    }
  }

  // Attempt to unlock pointer
  function unlockPointerNow() {
    console.log("----attempting pointer unlock----");
    const doc = document;
    if (doc.pointerLockElement === canvas ||
        doc.webkitPointerLockElement === canvas ||
        doc.mozpointerLockElement === canvas) {
      if (doc.exitPointerLock) {
        doc.exitPointerLock();
      } else if (doc.webkitExitPointerLock) {
        doc.webkitExitPointerLock();
      } else if (doc.mozExitPointerLock) {
        doc.mozExitPointerLock();
      }
      console.log("----pointer unlock request sent----");
    } else {
      console.warn("----pointer is not locked to the canvas----");
      sendLockStateToUnity(false);
    }
  }

  // Expose lock/unlock globally for Unity ExternalCall usage
  window.lockPointerNow = lockPointerNow;
  window.unlockPointerNow = unlockPointerNow;

  // Expose a function to change cursor style
  window.setCursor = function setCursor(cursorStyle) {
    if (canvas) {
      canvas.style.cursor = cursorStyle;
    }
  };
});
