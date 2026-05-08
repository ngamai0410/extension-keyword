# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Getify Ads Spy** — a Firefox/Chrome browser extension (Manifest V3) that passively intercepts Etsy Ads API responses, stores them locally, and lets the user export or push them directly to a Neon PostgreSQL database via HTTP SQL. It also includes an automated bot that iterates through a queue of listings, auto-expands keyword tables, and saves keyword + daily stats to the DB.

There is **no build system**, no `package.json`, no bundler. The extension is pure vanilla JS loaded unpacked from this directory.

## Loading the extension (the only "build" step)

1. Open `chrome://extensions` (Chrome/Edge) or `about:debugging` (Firefox).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.

After editing any JS file, click **Reload** on the extension card. Popup changes take effect immediately on next open; service worker (`background.js`) changes require the extension to be reloaded.

## Architecture

Five files form a data pipeline on every Etsy page load:

```
interceptor.js (MAIN world)
  → window.postMessage (camouflaged as React DevTools)
    → bridge.js (ISOLATED world)
        → chrome.runtime.sendMessage({ action: "CAPTURE" })
            → background.js (service worker)
                → chrome.storage.local  ← popup.js reads this
                → Neon HTTP SQL API     ← popup.js and bot trigger this
```

A sixth file handles bot automation on listing keyword pages:

```
background.js bot state machine
  → chrome.tabs.update / tabs.create  (open listing)
    → content.js (ISOLATED, on listing keyword page)
        → EXPANSION_DONE → background.js continues state machine
```

### File responsibilities

| File | World | Role |
|------|-------|------|
| `interceptor.js` | MAIN | Patches `fetch` + `XHR`; sends captured JSON via `postMessage`; spoofs `Function.prototype.toString` to evade anti-bot checks |
| `bridge.js` | ISOLATED | Validates `postMessage` origin/type, decodes compact keys, forwards to service worker via `chrome.runtime.sendMessage` |
| `background.js` | Service Worker | Central orchestrator — persists sessions, handles all DB operations, manages the keyword queue and the bot state machine |
| `content.js` | ISOLATED | Runs on Etsy listing keyword pages; waits for keyword section, clicks expand buttons with human-like timing, scrolls, then fires `EXPANSION_DONE` |
| `popup.js` | Popup | UI controller — reads sessions, runs ETL (`transformToClean`), exports files, triggers DB inserts, displays bot status |
| `config.js` | Background | Provides `APP_CONFIG.VM_NAME` (machine identifier stamped on every DB row as `importer`) |

### Bot state machine

`background.js` maintains a `bot` object that cycles through:

```
idle → opening → expanding → capturing → saving → (done: back to opening, or complete)
                                                 → waiting_user → retry/skip → opening
```

Human-like timing constants defined at the top of `background.js`:
- `BOT_PRE_EXPAND` — delay after tab load before sending `EXPAND_KEYWORDS`
- `BOT_SETTLE` — wait after last keyword API hit before saving
- `BOT_EXPAND_LIMIT` — fallback timeout if expansion never completes
- `BOT_NEXT_PAUSE` — rest between listings

### Database

- **Backend**: Neon PostgreSQL, accessed via HTTP SQL (`POST https://<host>/sql` with `Neon-Connection-String` header — no TCP, no Node.js required).
- **Tables**: `listing_report` (daily per-listing ad stats) and `keyword_report` (per-keyword stats). Keywords require the listing to exist in `listing_report` first.
- **Connection string** is stored in `chrome.storage.local` under `getify_db_config`.

### Storage keys (`chrome.storage.local`)

| Key | Contents |
|-----|----------|
| `getify_sessions` | Array of captured API response entries (auto-cleared on navigation, max 30 days) |
| `getify_db_config` | `{ connectionString }` |
| `getify_keyword_queue_v2` | Array of `{ listing_id, title, status }` queue items |
| `getify_keyword_url_template_v1` | URL template string containing `{listing_id}` |

## Key design constraints

- `interceptor.js` must stay in the **MAIN world** to patch `fetch`/`XHR` before the page's own scripts run. It cannot use `chrome.*` APIs.
- `bridge.js` must stay in the **ISOLATED world** to access `chrome.runtime`. It only receives messages from `interceptor.js` via `postMessage`.
- The message type `__RDT_UPD_a9f3c` is intentionally camouflaged as a React DevTools internal message — do not change it without updating both `interceptor.js` and `bridge.js`.
- `config.js` is listed first in `manifest.json`'s `background.scripts` array so `APP_CONFIG` is defined before `background.js` runs.
- The bot reuses a single tab (navigating it rather than opening new tabs) to mimic natural browsing. The tab ID is tracked in `bot.tabId`.
- Keyword inserts are guarded by a pre-check: all `listing_id`s must already exist in `listing_report`. Inserting keywords before their listing throws an explicit error.

## `temp/` folder

Contains raw JSON exports from past sessions. Ignored by git. Do not commit files from here.
