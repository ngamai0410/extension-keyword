// ===========================================================================
// Getify Ads Spy — ISOLATED World Bridge
// Receives camouflaged postMessages from MAIN world interceptor,
// validates them, decodes obfuscated keys, and relays to Service Worker.
// ===========================================================================

(function () {
  "use strict";

  var MSG_TYPE = "__RDT_UPD_a9f3c"; // Must match interceptor.js

  window.addEventListener("message", function (event) {
    // Security: only accept messages from our own window (same frame)
    if (event.source !== window) return;

    // Security: only accept messages with our camouflaged type
    if (!event.data || event.data.type !== MSG_TYPE) return;

    // Decode obfuscated keys back to readable names
    var payload = {
      url: event.data._u || "",
      status: event.data._s || 0,
      body: event.data._b || "",
      timestamp: event.data._t || Date.now(),
    };

    // Validate: must have a URL and a body
    if (!payload.url || !payload.body) return;

    // Attempt to parse the body as JSON for size estimation
    var sizeBytes = 0;
    try {
      sizeBytes = new Blob([payload.body]).size;
    } catch (e) {
      sizeBytes = payload.body.length || 0;
    }

    // Forward to Service Worker
    try {
      chrome.runtime.sendMessage({
        action: "CAPTURE",
        data: {
          url: payload.url,
          status: payload.status,
          body: payload.body,
          timestamp: payload.timestamp,
          sizeBytes: sizeBytes,
        },
      });
    } catch (e) {
      // Extension context may be invalidated if extension was reloaded
    }
  });
})();
