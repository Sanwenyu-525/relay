// CSP permits this bundled external script. The first message establishes script
// execution independently from whether Tauri exposes an invoke bridge to the frame.
const targetOrigin = window.location.origin;
window.parent.postMessage({ type: 'relay-p00-frame-probe-loaded' }, targetOrigin);

void (async () => {
  let invoke;
  try {
    invoke = window.__TAURI_INTERNALS__?.invoke;
  } catch {
    window.parent.postMessage(
      {
        type: 'relay-p00-frame-probe-bridge',
        bridge_available: false,
      },
      targetOrigin,
    );
    window.parent.postMessage(
      {
        type: 'relay-p00-frame-probe-result',
        bootstrap_invocation_attempted: false,
        bootstrap_succeeded: false,
      },
      targetOrigin,
    );
    return;
  }

  const bridgeAvailable = typeof invoke === 'function';
  window.parent.postMessage(
    {
      type: 'relay-p00-frame-probe-bridge',
      bridge_available: bridgeAvailable,
    },
    targetOrigin,
  );
  if (!bridgeAvailable) {
    window.parent.postMessage(
      {
        type: 'relay-p00-frame-probe-result',
        bootstrap_invocation_attempted: false,
        bootstrap_succeeded: false,
      },
      targetOrigin,
    );
    return;
  }

  window.parent.postMessage(
    {
      type: 'relay-p00-frame-probe-invocation',
      bootstrap_invocation_attempted: true,
    },
    targetOrigin,
  );
  try {
    await invoke('desktop_bootstrap');
    window.parent.postMessage(
      {
        type: 'relay-p00-frame-probe-result',
        bootstrap_invocation_attempted: true,
        bootstrap_succeeded: true,
      },
      targetOrigin,
    );
  } catch {
    window.parent.postMessage(
      {
        type: 'relay-p00-frame-probe-result',
        bootstrap_invocation_attempted: true,
        bootstrap_succeeded: false,
      },
      targetOrigin,
    );
  }
})();
