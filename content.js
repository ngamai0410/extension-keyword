// ===========================================================================
// Getify Ads Spy — Listing Keyword Page Bot
// Runs on Etsy listing keyword stats pages (ISOLATED world).
// Waits for the keyword table to appear, scrolls naturally, clicks expand
// buttons with human-like timing, then signals the background that it is done.
// ===========================================================================

(function () {
  "use strict";

  // Matches "See all", "See 50 more", "Show more", "Load more", "+ 12 more", etc.
  const EXPAND_RE =
    /see\s+(all|\d+)|show\s+(all|more|\d+)|load\s+more|view\s+all|\+\s*\d+\s*more/i;

  // Signals that a keyword section is present on the page
  const KEYWORD_SECTION_RE = /keyword|search\s+term|query|stemmed/i;

  // -------------------------------------------------------------------------
  // Human-like timing helpers
  // -------------------------------------------------------------------------

  // Returns a random integer in [min, max) — kept for internal use
  function jitter(min, max) {
    return Math.floor(min + Math.random() * (max - min));
  }

  // Gaussian distribution — values cluster around the mean, matching real human variance
  function humanJitter(min, max) {
    const mean = (min + max) / 2;
    const stdDev = (max - min) / 4;
    const u1 = Math.random() || 1e-10;
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.max(min, Math.min(max, Math.round(mean + z * stdDev)));
  }

  function sleep(min, max) {
    return new Promise((r) => setTimeout(r, max === undefined ? min : humanJitter(min, max)));
  }

  // Pause until the window regains focus (or the tab becomes visible). Real users
  // don't click on tabs they're not looking at — anti-bot scripts cross-check
  // document.hasFocus() / visibilityState against input events. Returns true if
  // focus came back, false if the timeout expired (caller should abort gracefully).
  async function waitForFocus(timeoutMs = 60_000) {
    const focused = () =>
      document.hasFocus() && document.visibilityState === "visible";
    if (focused()) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(humanJitter(400, 900));
      if (focused()) {
        // Brief settling pause as if the user is reorienting after switching back
        await sleep(humanJitter(350, 900));
        return true;
      }
    }
    return false;
  }

  // Track real cursor position so trajectory simulation starts from the right place
  const mousePos = {
    x: Math.floor(Math.random() * (window.innerWidth  || 1200)),
    y: Math.floor(Math.random() * (window.innerHeight || 800)),
  };
  document.addEventListener("mousemove", (e) => {
    mousePos.x = e.clientX;
    mousePos.y = e.clientY;
  }, { passive: true });

  // Pointer event constructor (gracefully degrades on browsers without support)
  const PE = typeof PointerEvent !== "undefined" ? PointerEvent : null;

  // Build a base pointer-event init dict matching what real Chromium emits.
  function pointerInit(x, y, { buttons = 0, button = 0, pressure = 0 } = {}) {
    return {
      bubbles: true, cancelable: true,
      clientX: x, clientY: y,
      screenX: x + window.screenX,
      screenY: y + window.screenY,
      pointerType: "mouse",
      pointerId: 1,
      isPrimary: true,
      button, buttons,
      pressure,
      width: 1, height: 1,
    };
  }

  // Dispatch on the topmost element under the pointer — real DOM events bubble
  // from there, not from `document`. Falls back to `document` if no hit.
  function dispatchAtPoint(type, x, y, init, asPointer) {
    const target = document.elementFromPoint(x, y) || document;
    const Ctor = asPointer && PE ? PE : MouseEvent;
    target.dispatchEvent(new Ctor(type, init));
    return target;
  }

  // Move the cursor from its current position to (toX, toY) along a bezier curve.
  // DataDome scores mouse trajectories — straight-line or zero-movement clicks are suspicious.
  async function simulateMousePath(toX, toY) {
    const fromX = mousePos.x;
    const fromY = mousePos.y;
    const dist  = Math.hypot(toX - fromX, toY - fromY);
    if (dist < 2) return;

    const steps = Math.max(6, Math.min(24, Math.floor(dist / 35)));
    // Random control point adds a natural arc to the path
    const cpX = (fromX + toX) / 2 + jitter(-70, 70);
    const cpY = (fromY + toY) / 2 + jitter(-50, 50);

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = Math.round((1 - t) * (1 - t) * fromX + 2 * (1 - t) * t * cpX + t * t * toX);
      const y = Math.round((1 - t) * (1 - t) * fromY + 2 * (1 - t) * t * cpY + t * t * toY);
      // Real Chromium fires pointermove → mousemove on the topmost element under the cursor.
      // Sending only mousemove on `document` (as we did before) is a paired-event mismatch.
      const init = pointerInit(x, y, { button: -1, buttons: 0, pressure: 0 });
      if (PE) dispatchAtPoint("pointermove", x, y, init, true);
      dispatchAtPoint("mousemove", x, y, init, false);
      await sleep(humanJitter(10, 26));
    }

    mousePos.x = toX;
    mousePos.y = toY;
  }

  // Scroll down a random amount, then pause as if reading
  async function humanScroll() {
    const delta = humanJitter(250, 550);
    try { window.scrollBy({ top: delta, behavior: "smooth" }); } catch (_) {}
    await sleep(700, 1_400);
  }

  // Scroll back up a smaller amount — humans frequently re-read content above
  async function humanScrollUp() {
    const delta = humanJitter(100, 280);
    try { window.scrollBy({ top: -delta, behavior: "smooth" }); } catch (_) {}
    await sleep(500, 1_100);
  }

  // Multi-pass reading scroll: scroll down several times with occasional
  // back-up pauses, matching the non-linear pattern of a human reading a page.
  async function humanReadingScroll() {
    const passes = jitter(2, 5); // 2–4 downward passes
    for (let i = 0; i < passes; i++) {
      await humanScroll();
      // ~35% chance to scroll back up before continuing — re-reading behaviour
      if (Math.random() < 0.35) {
        await sleep(300, 800);
        await humanScrollUp();
        await sleep(400, 900);
      }
    }
  }

  // Glance at non-keyword regions (page header, footer) before drilling into
  // the table — a real user gets oriented in the page first, not laser-focused
  // on the data section every time. Each branch is probabilistic so per-listing
  // patterns vary instead of forming a fingerprint of "always do X first".
  async function scrollExploration() {
    // ~45% — glance up at the page header / listing context
    if (Math.random() < 0.45) {
      try { window.scrollTo({ top: jitter(0, 60), behavior: "smooth" }); } catch (_) {}
      await sleep(humanJitter(1_400, 3_200));
    }
    // ~22% — peek at the bottom of the page briefly
    if (Math.random() < 0.22) {
      const total = document.body && document.body.scrollHeight || 0;
      const target = Math.max(0, total - (window.innerHeight || 800) - jitter(40, 200));
      try { window.scrollTo({ top: target, behavior: "smooth" }); } catch (_) {}
      await sleep(humanJitter(900, 2_000));
    }
  }

  // Ease-out cubic scroll to element — avoids the instant "snap" of scrollIntoView
  // which is a strong automation signal.
  async function scrollToElement(el) {
    const rect     = el.getBoundingClientRect();
    const targetY  = window.scrollY + rect.top - Math.floor(window.innerHeight * (0.3 + Math.random() * 0.2));
    const startY   = window.scrollY;
    const distance = targetY - startY;

    if (Math.abs(distance) > 4) {
      const steps = humanJitter(14, 22);
      for (let i = 1; i <= steps; i++) {
        const t     = i / steps;
        const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic — decelerates near target
        window.scrollTo(0, Math.round(startY + distance * eased));
        await sleep(humanJitter(15, 32));
      }
    }

    await sleep(350, 800);
  }

  // Dispatch a full mouse-event sequence with real viewport coordinates and a
  // realistic trajectory leading up to the click.
  async function humanClick(el) {
    driftLock = true;
    try {
      const rect = el.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width  * (0.3 + Math.random() * 0.4));
      const y = Math.round(rect.top  + rect.height * (0.3 + Math.random() * 0.4));

      // With 30% probability, hover a nearby unrelated element first — breaks the
      // "always direct path to interactive target" pattern bots exhibit
      await maybeFakeHover(el);
      // Move cursor to the target before pressing — zero-movement clicks are flagged
      await simulateMousePath(x, y);

      // Modern Chromium fires PointerEvents alongside MouseEvents and varies `buttons`
      // across phases — hover=0, mousedown/pointerdown=1, mouseup/click=0. A handler
      // reading `e.buttons` on `mousedown` and seeing 0 is a paired-event mismatch
      // that doesn't occur in any real browser.
      const hoverInit = pointerInit(x, y, { button: -1, buttons: 0, pressure: 0 });
      // Real Chromium primary-click mousedown/mouseup/click all carry detail=1.
      // Omitting detail makes synthetic events default to 0 — a paired-event
      // mismatch any handler reading e.detail can detect.
      const downInit  = { ...pointerInit(x, y, { button: 0, buttons: 1, pressure: 0.5 }), detail: 1 };
      const upInit    = { ...pointerInit(x, y, { button: 0, buttons: 0, pressure: 0 }),   detail: 1 };

      if (PE) el.dispatchEvent(new PE("pointerover", hoverInit));
      el.dispatchEvent(new MouseEvent("mouseover", hoverInit));
      // "Decide before pressing" pause — real users hover the cursor and verify the
      // target before pressing. Range matches typical motor-cognition latency.
      await sleep(120, 380);
      if (PE) el.dispatchEvent(new PE("pointerdown", downInit));
      el.dispatchEvent(new MouseEvent("mousedown", downInit));
      // Press-release duration: real-user histograms cluster ~80–200 ms.
      // A sub-80 ms minimum lands on the short tail and looks synthetic.
      await sleep(80, 160);
      if (PE) el.dispatchEvent(new PE("pointerup", upInit));
      el.dispatchEvent(new MouseEvent("mouseup", upInit));
      // Real Chromium fires click synchronously after mouseup (~0 ms apart in
      // the same task). A multi-ms forced gap is itself a paired-event
      // mismatch — keep this near zero.
      await sleep(0, 3);
      el.dispatchEvent(new MouseEvent("click", upInit));
    } finally {
      driftLock = false;
    }
  }

  // With 30% probability, hover over an unrelated nearby element before the real
  // target — makes mouse paths look goal-ambiguous, matching real browsing behaviour.
  async function maybeFakeHover(realTarget) {
    if (Math.random() > 0.3) return;
    const rect = realTarget.getBoundingClientRect();
    const candidates = Array.from(
      document.querySelectorAll("a, span, p, li, div")
    ).filter((el) => {
      if (el === realTarget || el.contains(realTarget) || realTarget.contains(el)) return false;
      const r = el.getBoundingClientRect();
      const dx = Math.abs(r.left + r.width / 2 - (rect.left + rect.width / 2));
      const dy = Math.abs(r.top  + r.height / 2 - (rect.top  + rect.height / 2));
      return dx < 300 && dy < 180 && r.width > 10 && r.height > 5;
    });
    if (candidates.length === 0) return;
    const decoy = candidates[Math.floor(Math.random() * candidates.length)];
    const dr = decoy.getBoundingClientRect();
    const dx = Math.round(dr.left + dr.width  * (0.3 + Math.random() * 0.4));
    const dy = Math.round(dr.top  + dr.height * (0.3 + Math.random() * 0.4));
    await simulateMousePath(dx, dy);
    const dInit = pointerInit(dx, dy, { button: -1, buttons: 0, pressure: 0 });
    if (PE) decoy.dispatchEvent(new PE("pointerover", dInit));
    decoy.dispatchEvent(new MouseEvent("mouseover", dInit));
    await sleep(150, 500);
    if (PE) decoy.dispatchEvent(new PE("pointerout", dInit));
    decoy.dispatchEvent(new MouseEvent("mouseout", dInit));
    await sleep(80, 220);
  }

  // -------------------------------------------------------------------------
  // Idle decoy layer — runs in the background during long waits so the cursor
  // is never frozen for 20–30 s while the page loads or while we sleep between
  // expand rounds. Pure stillness across long intervals is itself a signal.
  // -------------------------------------------------------------------------

  // Set by humanClick to suspend drift while a deliberate click sequence is
  // dispatching its own pointer events (avoids interleaved mouse noise).
  let driftLock = false;

  function startIdleDrift() {
    const stop = { stopped: false };
    (async () => {
      while (!stop.stopped) {
        await sleep(humanJitter(2_500, 6_500));
        if (stop.stopped) return;
        if (driftLock) continue;
        // Don't drift while the tab is hidden — real cursors don't move when
        // the user isn't looking, so simulating that is itself suspicious.
        if (!document.hasFocus() || document.visibilityState !== "visible") continue;

        // Clustered amplitude — 70% tiny wiggle (the "I'm reading" jitter),
        // 25% mid drift, 5% wider reposition. Matches real attentional bursts.
        const r = Math.random();
        let dx, dy;
        if      (r < 0.70) { dx = jitter(-18, 18);   dy = jitter(-12, 12); }
        else if (r < 0.95) { dx = jitter(-90, 90);   dy = jitter(-55, 55); }
        else               { dx = jitter(-240, 240); dy = jitter(-150, 150); }

        const w = window.innerWidth  || 1200;
        const h = window.innerHeight ||  800;
        const tx = Math.max(10, Math.min(w - 10, mousePos.x + dx));
        const ty = Math.max(10, Math.min(h - 10, mousePos.y + dy));
        try { await simulateMousePath(tx, ty); } catch (_) {}
      }
    })();
    return () => { stop.stopped = true; };
  }

  // With 15% probability, fire blur then focus on the window — mimics the user
  // briefly switching tabs and coming back.
  async function maybeSimulateFocusBlur() {
    if (Math.random() > 0.15) return;
    window.dispatchEvent(new Event("blur"));
    await sleep(humanJitter(600, 2_500));
    window.dispatchEvent(new Event("focus"));
    await sleep(200, 600);
  }

  // -------------------------------------------------------------------------
  // DOM helpers
  // -------------------------------------------------------------------------

  function findExpandButtons() {
    return Array.from(
      document.querySelectorAll('button, [role="button"], a')
    ).filter((el) => EXPAND_RE.test((el.textContent || "").trim()));
  }

  function keywordSectionExists() {
    return Array.from(
      document.querySelectorAll("h1,h2,h3,h4,th,label,span,div")
    ).some((el) => {
      const text =
        el.childNodes[0] && el.childNodes[0].nodeType === 3
          ? el.childNodes[0].textContent
          : el.textContent;
      return KEYWORD_SECTION_RE.test((text || "").trim());
    });
  }

  // -------------------------------------------------------------------------
  // Main expansion routine
  // -------------------------------------------------------------------------

  async function expandKeywords() {
    // Don't even start if the user isn't looking at the tab — clicking while
    // unfocused is a strong automation signal. Bail out cleanly if focus never
    // returns; background.js's expand-fallback timer will settle on its own.
    if (!(await waitForFocus())) {
      try { chrome.runtime.sendMessage({ action: "EXPANSION_DONE" }); } catch (_) {}
      return;
    }

    // Idle decoy layer — keeps the cursor naturally in motion during waits.
    // Stopped in the finally block so it never outlives this listing's loop.
    const stopDrift = startIdleDrift();

    // One deep reading pause per listing (~25%), fired at a random expand round
    // so the "user paused to study the data" event doesn't always land in the
    // same place across listings.
    let didDeepRead = false;
    async function maybeDeepRead() {
      if (didDeepRead) return;
      if (Math.random() > 0.25) return;
      didDeepRead = true;
      await sleep(humanJitter(5_000, 12_000));
    }

    try {
      // Wait up to ~28 s for the keyword section to appear (SPA lazy-renders)
      const deadline = Date.now() + jitter(24_000, 28_000);
      while (!keywordSectionExists() && Date.now() < deadline) {
        await sleep(900, 1_600);
      }

      // Glance around the page (header / footer) before focusing on the table —
      // breaks the "always immediately scroll into the keyword section" pattern.
      await scrollExploration();

      // Multi-pass reading scroll before touching anything — simulates a human
      // scanning the page up and down before deciding where to click
      await humanReadingScroll();

      // Small reading pause before first interaction — occasionally simulate a tab switch
      await maybeSimulateFocusBlur();
      await sleep(1_200, 2_500);

      // Click expand buttons in multiple rounds — jittered count avoids a fixed
      // "always exactly 6 expansions per listing" signature.
      const maxRounds = jitter(4, 8);
      // Pick a round at which the deep-read pause is allowed to fire — random
      // per listing so it doesn't always trigger on round 0.
      const deepReadRound = jitter(1, maxRounds);
      for (let round = 0; round < maxRounds; round++) {
        const buttons = findExpandButtons();
        if (round > 0 && buttons.length === 0) break;

        // Shuffle so we don't always click in DOM (top-to-bottom) order, and
        // occasionally skip a button to revisit on the next round — a real user
        // doesn't methodically click every "Show more" in document order.
        const order = buttons.slice();
        for (let k = order.length - 1; k > 0; k--) {
          const j = Math.floor(Math.random() * (k + 1));
          [order[k], order[j]] = [order[j], order[k]];
        }
        for (const btn of order) {
          if (Math.random() < 0.1) continue; // ~10% skip — picked up next round
          // Re-check focus before each click — if user switched tabs mid-round,
          // pause until they come back rather than clicking into a hidden tab.
          if (!(await waitForFocus(45_000))) return;
          try {
            await scrollToElement(btn);
            await humanClick(btn);
          } catch (_) {}
          // ~40% of clicks: a longer "reading" pause as if the user is reviewing
          // the rows that just appeared. The remainder uses a short post-click
          // gap so total expansion time stays bounded.
          if (Math.random() < 0.4) {
            await sleep(1_400, 3_200);
          } else {
            await sleep(400, 900);
          }
        }

        if (buttons.length > 0) {
          // After clicking, scroll down to review new content, then occasionally back up
          await humanScroll();
          if (Math.random() < 0.4) {
            await sleep(400, 800);
            await humanScrollUp();
          }
        }

        // On the chosen round, possibly take a long study pause before advancing
        if (round === deepReadRound) await maybeDeepRead();

        // Wait for new content to load before checking for more buttons
        await sleep(2_200, 4_000);
      }

      // Final scroll to the bottom to trigger any remaining lazy-loaded rows
      await humanReadingScroll();
      await sleep(800, 1_500);
    } finally {
      stopDrift();
    }

    try {
      chrome.runtime.sendMessage({ action: "EXPANSION_DONE" });
    } catch (_) {}
  }

  // -------------------------------------------------------------------------
  // Message listener — background sends EXPAND_KEYWORDS when ready
  // -------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "EXPAND_KEYWORDS") {
      expandKeywords();
    }
  });
})();
