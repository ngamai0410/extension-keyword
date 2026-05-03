// ===========================================================================
// Getify Ads Spy — MAIN World Interceptor
// Injected via manifest.json "world": "MAIN" at document_start
// NO DOM elements created. NO chrome.* APIs used. Completely invisible.
// ===========================================================================

(function () {
  "use strict";

  // --- CONFIG ---
  var MSG_TYPE = "__RDT_UPD_a9f3c"; // Camouflaged as React DevTools internal update

  // URL patterns that indicate API calls worth capturing
  // TODO: Remove the "TEST MODE" entries after verifying the extension works
  var API_PATTERNS = [
    "/api/v3/",
    "/ads/",
    "/advertising/",
    "/stats/",
    "/analytics/",
    "/marketing/",
    "/promoted-listings/",
    "campaign",
    "promoted",
    "budget",
    "keyword",
    "search_query",
    "performance",
    "impression",
    "click",
    "spend",
    "roas",
  ];

  // URL patterns to ALWAYS ignore (noise reduction)
  var IGNORE_PATTERNS = [
    ".jpg",
    ".png",
    ".gif",
    ".svg",
    ".webp",
    ".css",
    ".woff",
    ".woff2",
    ".ttf",
    "beacon",
    "tracking",
    "pixel",
    "gtm",
    "google-analytics",
    "facebook",
    "datadome",
  ];

  // --- HELPERS ---

  function shouldCapture(url) {
    if (typeof url !== "string") return false;
    var lower = url.toLowerCase();

    // Reject noise first
    for (var i = 0; i < IGNORE_PATTERNS.length; i++) {
      if (lower.indexOf(IGNORE_PATTERNS[i]) !== -1) return false;
    }

    // Accept if matches any API pattern
    for (var j = 0; j < API_PATTERNS.length; j++) {
      if (lower.indexOf(API_PATTERNS[j]) !== -1) return true;
    }

    return false;
  }

  function sendCamouflaged(url, status, body) {
    try {
      window.postMessage(
        {
          type: MSG_TYPE,
          _u: url,
          _s: status,
          _b: body,
          _t: Date.now(),
        },
        "*"
      );
    } catch (e) {
      // Silent fail — never throw errors that could show up in console
    }
  }

  function isJsonResponse(contentType) {
    return (
      contentType &&
      (contentType.indexOf("application/json") !== -1 ||
        contentType.indexOf("text/json") !== -1)
    );
  }

  // --- FETCH INTERCEPTION ---

  var _originalFetch = window.fetch;

  window.fetch = function () {
    var args = arguments;
    var url =
      typeof args[0] === "string"
        ? args[0]
        : args[0] && args[0].url
          ? args[0].url
          : "";

    if (!shouldCapture(url)) {
      return _originalFetch.apply(this, args);
    }

    return _originalFetch.apply(this, args).then(function (response) {
      try {
        var ct = response.headers.get("content-type") || "";
        if (isJsonResponse(ct)) {
          // Clone the response so the page can still read the original
          response
            .clone()
            .text()
            .then(function (bodyText) {
              sendCamouflaged(url, response.status, bodyText);
            });
        }
      } catch (e) {
        // Silent fail
      }
      return response;
    });
  };

  // --- XHR INTERCEPTION ---

  var _originalXHROpen = XMLHttpRequest.prototype.open;
  var _originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._xu = url;
    return _originalXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    var self = this;
    var url = self._xu || "";

    if (shouldCapture(url)) {
      self.addEventListener("load", function () {
        try {
          var ct = self.getResponseHeader("content-type") || "";
          if (isJsonResponse(ct)) {
            sendCamouflaged(url, self.status, self.responseText);
          }
        } catch (e) {
          // Silent fail
        }
      });
    }

    return _originalXHRSend.apply(this, arguments);
  };

  // --- toString() SPOOFING ---
  // DataDome may check: window.fetch.toString() === "function fetch() { [native code] }"
  // We make our patched functions return the exact native string.

  var _originalToString = Function.prototype.toString;
  var _spoofMap = new Map();

  _spoofMap.set(window.fetch, "function fetch() { [native code] }");
  _spoofMap.set(
    XMLHttpRequest.prototype.open,
    "function open() { [native code] }"
  );
  _spoofMap.set(
    XMLHttpRequest.prototype.send,
    "function send() { [native code] }"
  );

  Function.prototype.toString = function () {
    if (_spoofMap.has(this)) {
      return _spoofMap.get(this);
    }
    return _originalToString.call(this);
  };

  // Spoof the toString itself so checking toString.toString() also looks native
  _spoofMap.set(
    Function.prototype.toString,
    "function toString() { [native code] }"
  );

  // --- IFRAME DEFENSE (Phase 2) ---
  // If DataDome creates a fresh iframe to get a pristine fetch reference,
  // we patch fetch inside that iframe immediately upon creation.

  var _originalCreateElement = document.createElement.bind(document);

  document.createElement = function (tagName) {
    var el = _originalCreateElement(tagName);

    if (tagName.toLowerCase() === "iframe") {
      // When the iframe loads, its contentWindow becomes available
      var patchIframeFetch = function () {
        try {
          if (el.contentWindow && el.contentWindow.fetch) {
            var iframeOriginalFetch = el.contentWindow.fetch;
            el.contentWindow.fetch = function () {
              return iframeOriginalFetch.apply(this, arguments);
            };
            // Spoof toString on the iframe's fetch too
            el.contentWindow.fetch.toString = function () {
              return "function fetch() { [native code] }";
            };
          }
        } catch (e) {
          // Cross-origin iframes will throw — that's fine, ignore them
        }
      };

      // Patch when iframe loads
      el.addEventListener("load", patchIframeFetch);
    }

    return el;
  };

  // Spoof createElement toString
  _spoofMap.set(
    document.createElement,
    "function createElement() { [native code] }"
  );
})();
