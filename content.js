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

  // Returns a random integer in [min, max)
  function jitter(min, max) {
    return Math.floor(min + Math.random() * (max - min));
  }

  function sleep(min, max) {
    return new Promise((r) => setTimeout(r, max === undefined ? min : jitter(min, max)));
  }

  // Smooth-scroll by a random amount, then pause as if reading
  async function humanScroll() {
    const delta = jitter(250, 550);
    try {
      window.scrollBy({ top: delta, behavior: "smooth" });
    } catch (_) {}
    await sleep(700, 1_400);
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

    // Scroll down once — simulates a human reading the page before acting
    await humanScroll();

    // Small reading pause before first interaction
    await sleep(1_200, 2_500);

    // Click expand buttons in multiple rounds
    for (let round = 0; round < 6; round++) {
      const buttons = findExpandButtons();
      if (round > 0 && buttons.length === 0) break;

      for (const btn of buttons) {
        try {
          btn.click();
        } catch (_) {}
        // Brief pause between individual clicks (like a human who clicks once, checks, clicks again)
        await sleep(400, 900);
      }

      if (buttons.length > 0) {
        // Scroll a bit after clicking — looks like reviewing what appeared
        await humanScroll();
      }

      // Wait for new content to load before checking for more buttons
      await sleep(2_200, 4_000);
    }

    // Final scroll to the bottom to trigger any remaining lazy-loaded rows
    await humanScroll();
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
