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
    return Math.max(min, Math.min(max * 1.5, Math.round(mean + z * stdDev)));
  }

  function sleep(min, max) {
    return new Promise((r) => setTimeout(r, max === undefined ? min : humanJitter(min, max)));
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
      document.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true, cancelable: true,
        clientX: x, clientY: y,
        screenX: x + window.screenX,
        screenY: y + window.screenY,
      }));
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
    const rect = el.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width  * (0.3 + Math.random() * 0.4));
    const y = Math.round(rect.top  + rect.height * (0.3 + Math.random() * 0.4));

    // With 30% probability, hover a nearby unrelated element first — breaks the
    // "always direct path to interactive target" pattern bots exhibit
    await maybeFakeHover(el);
    // Move cursor to the target before pressing — zero-movement clicks are flagged
    await simulateMousePath(x, y);

    const opts = {
      bubbles: true, cancelable: true,
      clientX: x, clientY: y,
      screenX: x + window.screenX,
      screenY: y + window.screenY,
    };
    el.dispatchEvent(new MouseEvent("mouseover",  opts));
    await sleep(80, 180);
    el.dispatchEvent(new MouseEvent("mousedown",  opts));
    await sleep(60, 120);
    el.dispatchEvent(new MouseEvent("mouseup",    opts));
    await sleep(15, 45); // micro-pause between mouseup and click — matches real motor latency
    el.dispatchEvent(new MouseEvent("click",      opts));
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
    const dOpts = {
      bubbles: true, cancelable: true,
      clientX: dx, clientY: dy,
      screenX: dx + window.screenX, screenY: dy + window.screenY,
    };
    decoy.dispatchEvent(new MouseEvent("mouseover", dOpts));
    await sleep(150, 500);
    decoy.dispatchEvent(new MouseEvent("mouseout", dOpts));
    await sleep(80, 220);
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
    // Wait up to ~28 s for the keyword section to appear (SPA lazy-renders)
    const deadline = Date.now() + jitter(24_000, 28_000);
    while (!keywordSectionExists() && Date.now() < deadline) {
      await sleep(900, 1_600);
    }

    // Multi-pass reading scroll before touching anything — simulates a human
    // scanning the page up and down before deciding where to click
    await humanReadingScroll();

    // Small reading pause before first interaction — occasionally simulate a tab switch
    await maybeSimulateFocusBlur();
    await sleep(1_200, 2_500);

    // Click expand buttons in multiple rounds
    for (let round = 0; round < 6; round++) {
      const buttons = findExpandButtons();
      if (round > 0 && buttons.length === 0) break;

      for (const btn of buttons) {
        try {
          await scrollToElement(btn);
          await humanClick(btn);
        } catch (_) {}
        await sleep(400, 900);
      }

      if (buttons.length > 0) {
        // After clicking, scroll down to review new content, then occasionally back up
        await humanScroll();
        if (Math.random() < 0.4) {
          await sleep(400, 800);
          await humanScrollUp();
        }
      }

      // Wait for new content to load before checking for more buttons
      await sleep(2_200, 4_000);
    }

    // Final scroll to the bottom to trigger any remaining lazy-loaded rows
    await humanReadingScroll();
    await sleep(800, 1_500);

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
