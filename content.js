// ===========================================================================
// Getify Ads Spy — Listing Keyword Page Bot
// Runs on Etsy listing keyword stats pages (ISOLATED world).
// Waits for the keyword table to appear, clicks all expand/show-more buttons,
// then signals the background that expansion is done.
// ===========================================================================

(function () {
  "use strict";

  // Matches "See all", "See 50 more", "Show more", "Load more", "+ 12 more", etc.
  const EXPAND_RE =
    /see\s+(all|\d+)|show\s+(all|more|\d+)|load\s+more|view\s+all|\+\s*\d+\s*more/i;

  // Signals that a keyword section is present on the page
  const KEYWORD_SECTION_RE = /keyword|search\s+term|query|stemmed/i;

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function findExpandButtons() {
    return Array.from(
      document.querySelectorAll('button, [role="button"], a')
    ).filter((el) => {
      const text = (el.textContent || "").trim();
      return EXPAND_RE.test(text);
    });
  }

  function keywordSectionExists() {
    return Array.from(
      document.querySelectorAll("h1,h2,h3,h4,th,label,span,div")
    ).some((el) => {
      const own = (el.childNodes[0] && el.childNodes[0].nodeType === 3
        ? el.childNodes[0].textContent
        : el.textContent) || "";
      return KEYWORD_SECTION_RE.test(own.trim());
    });
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // -------------------------------------------------------------------------
  // Main expansion routine
  // -------------------------------------------------------------------------

  async function expandKeywords() {
    // Wait up to 20 s for the keyword section to appear (SPA lazy-renders)
    const deadline = Date.now() + 20_000;
    while (!keywordSectionExists() && Date.now() < deadline) {
      await sleep(600);
    }

    // Click expand buttons in up to 6 rounds, 1.5 s apart
    for (let round = 0; round < 6; round++) {
      const buttons = findExpandButtons();
      if (round > 0 && buttons.length === 0) break;
      for (const btn of buttons) {
        try {
          btn.click();
        } catch (_) {}
      }
      await sleep(1500);
    }

    // Tell the background we are done
    try {
      chrome.runtime.sendMessage({ action: "EXPANSION_DONE" });
    } catch (_) {}
  }

  // -------------------------------------------------------------------------
  // Message listener — background sends EXPAND_KEYWORDS when tab finishes loading
  // -------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "EXPAND_KEYWORDS") {
      expandKeywords();
    }
  });
})();
