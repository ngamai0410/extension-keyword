// ===========================================================================
// Getify Ads Spy — MAIN World Interceptor
// Injected via manifest.json "world": "MAIN" at document_start
// NO DOM elements created. NO chrome.* APIs used. Completely invisible.
// ===========================================================================

(function () {
  "use strict";

  // --- navigator.webdriver MASK ---
  // Normal Chrome reports `false`, headless/automation reports `true`. Force `false`
  // and make the property look like the native getter so probes that read
  // `Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver').get.toString()`
  // also see "[native code]". The getter reference is captured here and added to
  // _spoofMap further down (after the map is created).
  var _webdriverGetter = null;
  try {
    Object.defineProperty(Navigator.prototype, "webdriver", {
      get: function () { return false; },
      configurable: true,
      enumerable: true,
    });
    _webdriverGetter = Object.getOwnPropertyDescriptor(Navigator.prototype, "webdriver").get;
  } catch (_) {}

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
  // WeakMap avoids stamping a `_xu` own property on every XHR instance, which would
  // be visible to Object.getOwnPropertyNames(xhr) — a known automation signal.
  var _xhrUrls = new WeakMap();

  XMLHttpRequest.prototype.open = function (method, url) {
    _xhrUrls.set(this, url);
    return _originalXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    var self = this;
    var url = _xhrUrls.get(self) || "";

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

  // Spoof the webdriver getter installed at the top of this IIFE
  if (_webdriverGetter) {
    _spoofMap.set(_webdriverGetter, "function get webdriver() { [native code] }");
  }

  // --- PERFORMANCE.NOW() JITTER ---
  // Automation timing is too precise — add small noise to match real browser variance.
  // Spec requires the value to be monotonically non-decreasing, so we clamp every
  // result against the last one returned. A regression here is a strong automation tell.
  var _origPerfNow = performance.now.bind(performance);
  var _perfLast = 0;
  performance.now = function () {
    var v = _origPerfNow() + (Math.random() * 4 - 2);
    if (v <= _perfLast) v = _perfLast + Math.random() * 0.02;
    _perfLast = v;
    return v;
  };
  _spoofMap.set(performance.now, "function now() { [native code] }");

  // --- CANVAS FINGERPRINT NOISE ---
  // DataDome draws shapes on an off-screen canvas and hashes pixel data via getImageData.
  // Flipping 1 count per 1024 pixels makes the hash session-unique with no visible change.
  // Seed must persist across reloads — real devices have a perfectly stable canvas
  // hash, and a hash that drifts on every page load is itself the bot signal we
  // were trying to avoid. Mirror the audio-seed persistence pattern.
  var _canvasNoiseSeed;
  try {
    var _canvasKey = "eu_pref_c1";
    var _storedCanvas = localStorage.getItem(_canvasKey);
    _canvasNoiseSeed = _storedCanvas != null ? (parseInt(_storedCanvas, 10) & 0xFF) : NaN;
    if (!Number.isFinite(_canvasNoiseSeed)) {
      _canvasNoiseSeed = Math.floor(Math.random() * 256);
      localStorage.setItem(_canvasKey, String(_canvasNoiseSeed));
    }
  } catch (_) {
    _canvasNoiseSeed = Math.floor(Math.random() * 256);
  }
  var _origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function (x, y, w, h) {
    var data = _origGetImageData.call(this, x, y, w, h);
    var len = data.data.length;
    if (len > 0) {
      // Spacing scales with buffer length so favicon-sized canvases still get touched.
      var step = Math.max(1, Math.min(1024, len >> 2));
      for (var i = _canvasNoiseSeed % len; i < len; i += step) {
        data.data[i] = (data.data[i] + 1) & 0xFF;
      }
    }
    return data;
  };
  _spoofMap.set(
    CanvasRenderingContext2D.prototype.getImageData,
    "function getImageData() { [native code] }"
  );

  // --- AUDIO CONTEXT FINGERPRINT NOISE ---
  // Fingerprinters read oscillator output via getFloatFrequencyData.
  // Sub-threshold noise (< 0.0001 dB) prevents a stable hash across sessions.
  // Noise must be deterministic for a given (seed, index) pair — otherwise
  // consecutive calls on identical audio state would return different arrays,
  // which real browsers never do.
  try {
    // Seed must be stable per-origin per-profile; real audio fingerprints don't drift
    // across reloads. localStorage gives us that persistence without a chrome.* call.
    // Storage key avoids the bot-distinctive __rdt_* / __react_* / dunder
    // patterns that anti-bot scripts probe for; mimics a generic app-pref key.
    var _audioSeed;
    var _audioKey = "eu_pref_a1";
    try {
      var stored = localStorage.getItem(_audioKey);
      _audioSeed = stored ? (stored | 0) >>> 0 : 0;
      if (!_audioSeed) {
        _audioSeed = (Math.random() * 0xFFFFFFFF) >>> 0;
        localStorage.setItem(_audioKey, String(_audioSeed));
      }
    } catch (_) {
      _audioSeed = (Math.random() * 0xFFFFFFFF) >>> 0;
    }
    var _origGetFloatFreqData = AnalyserNode.prototype.getFloatFrequencyData;
    AnalyserNode.prototype.getFloatFrequencyData = function (array) {
      _origGetFloatFreqData.call(this, array);
      for (var i = 0; i < array.length; i += 64) {
        // Deterministic LCG-style noise from (seed, index) — same input → same output.
        var n = (_audioSeed ^ (i * 2654435761)) >>> 0;
        array[i] += ((n / 0xFFFFFFFF) - 0.5) * 0.0001;
      }
    };
    _spoofMap.set(
      AnalyserNode.prototype.getFloatFrequencyData,
      "function getFloatFrequencyData() { [native code] }"
    );
  } catch (_) {}

  // --- WEBGL FINGERPRINT NOISE ---
  // DataDome reads UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL via the
  // WEBGL_debug_renderer_info extension. With canvas now noised, leaving WebGL
  // pristine creates an asymmetric fingerprint (one surface noised, one not) —
  // which itself is anomalous compared to a real device. Append a stable-per-
  // profile suffix so the WebGL hash is consistent across reloads (matching real
  // device behaviour) but not pristine across installs.
  try {
    var _webglKey = "eu_pref_w1";
    var _webglSuffix;
    try {
      var _storedW = localStorage.getItem(_webglKey);
      if (_storedW) {
        _webglSuffix = _storedW;
      } else {
        // Tiny invisible suffix — a single trailing space is a no-op visually
        // but flips the string hash deterministically per profile.
        _webglSuffix = (Math.random() < 0.5) ? "" : " ";
        localStorage.setItem(_webglKey, _webglSuffix);
      }
    } catch (_) {
      _webglSuffix = "";
    }

    var UNMASKED_VENDOR  = 0x9245; // 37445
    var UNMASKED_RENDERER = 0x9246; // 37446

    function _patchWebGLGetParameter(proto) {
      if (!proto || !proto.getParameter) return;
      var orig = proto.getParameter;
      var patched = function (param) {
        var value = orig.call(this, param);
        if (typeof value === "string" && _webglSuffix &&
            (param === UNMASKED_VENDOR || param === UNMASKED_RENDERER)) {
          return value + _webglSuffix;
        }
        return value;
      };
      proto.getParameter = patched;
      _spoofMap.set(patched, "function getParameter() { [native code] }");
    }

    if (typeof WebGLRenderingContext !== "undefined") {
      _patchWebGLGetParameter(WebGLRenderingContext.prototype);
    }
    if (typeof WebGL2RenderingContext !== "undefined") {
      _patchWebGLGetParameter(WebGL2RenderingContext.prototype);
    }
  } catch (_) {}

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
          var w = el.contentWindow;
          if (!w || !w.fetch) return;
          var iframeOriginalFetch = w.fetch;
          var iframePatchedFetch = function () {
            return iframeOriginalFetch.apply(this, arguments);
          };
          w.fetch = iframePatchedFetch;
          // Override Function.prototype.toString in the iframe instead of stamping a
          // `toString` own property on the wrapper — the latter is enumerable via
          // Object.getOwnPropertyNames(fetch) and is itself a bot signal.
          // The wrapper must also short-circuit on itself, otherwise
          // `iframe.contentWindow.Function.prototype.toString.toString()` falls through
          // to the native toString and returns the wrapper's JS source — exposing the
          // patch directly.
          var iframeOrigToString = w.Function.prototype.toString;
          var iframeNewToString = function () {
            if (this === iframePatchedFetch) return "function fetch() { [native code] }";
            if (this === iframeNewToString)  return "function toString() { [native code] }";
            return iframeOrigToString.call(this);
          };
          w.Function.prototype.toString = iframeNewToString;
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
