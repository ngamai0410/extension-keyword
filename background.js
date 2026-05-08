// ===========================================================================
// Getify Ads Spy — Service Worker (Background)
// Data warehouse: stores captured API responses in chrome.storage.local.
// Database: connects directly to Neon PostgreSQL via HTTP SQL API.
// No local relay server needed.
// ===========================================================================

const MAX_AGE_DAYS = 30;
const STORAGE_KEY = "getify_sessions";
const DB_CONFIG_KEY = "getify_db_config";

// --- AUTO-CLEAR ON NAVIGATION ---
// Real browser navigation (link clicks, address bar, back/forward — not reload)
chrome.webNavigation.onCommitted.addListener(
  (details) => {
    if (details.frameId !== 0) return;
    if (details.transitionType === "reload") return;
    handleClearAll(() => { });
  },
  { url: [{ hostContains: "etsy.com" }] }
);

// SPA client-side routing (history.pushState)
chrome.webNavigation.onHistoryStateUpdated.addListener(
  (details) => {
    if (details.frameId !== 0) return;
    handleClearAll(() => { });
  },
  { url: [{ hostContains: "etsy.com" }] }
);

// --- MESSAGE HANDLER ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "CAPTURE") {
    handleCapture(message.data);
    sendResponse({ ok: true });
  } else if (message.action === "GET_ALL") {
    handleGetAll(sendResponse);
    return true; // Keep channel open for async response
  } else if (message.action === "CLEAR_ALL") {
    handleClearAll(sendResponse);
    return true;
  } else if (message.action === "GET_STATS") {
    handleGetStats(sendResponse);
    return true;
  } else if (message.action === "SAVE_DB_CONFIG") {
    handleSaveDbConfig(message.data, sendResponse);
    return true;
  } else if (message.action === "GET_DB_CONFIG") {
    handleGetDbConfig(sendResponse);
    return true;
  } else if (message.action === "TEST_DB_CONNECTION") {
    handleTestDbConnection(message.connectionString, sendResponse);
    return true;
  } else if (message.action === "INSERT_TO_DB") {
    handleInsertToDb(message.rows, message.connectionString, sendResponse);
    return true;
  } else if (message.action === "INSERT_KEYWORDS_TO_DB") {
    handleInsertKeywordsToDb(message.rows, message.connectionString, sendResponse);
    return true;
  } else if (message.action === "QUEUE_GET") {
    queueGet().then((q) => sendResponse({ queue: q }));
    return true;
  } else if (message.action === "QUEUE_SAVE") {
    queueSave(message.queue).then(() => sendResponse({ ok: true }));
    return true;
  } else if (message.action === "QUEUE_ADD") {
    handleQueueAdd(message.listingIds || [], message.urlTemplate || "", message.autoStart, sendResponse);
    return true;
  } else if (message.action === "BOT_START") {
    botStart(message.urlTemplate);
    sendResponse({ ok: true });
  } else if (message.action === "BOT_STOP") {
    botStop();
    sendResponse({ ok: true });
  } else if (message.action === "BOT_STATUS") {
    sendResponse({ bot: botPublicState() });
  } else if (message.action === "EXPANSION_DONE") {
    if (bot.active && bot.state === "expanding") {
      scheduleBotSettle();
    }
    sendResponse({ ok: true });
  } else if (message.action === "BOT_RESUME") {
    handleBotResume(message.decision, sendResponse);
    return true;
  }
});

// =====================================================================
// SESSION CAPTURE (unchanged)
// =====================================================================

async function handleCapture(data) {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const sessions = result[STORAGE_KEY] || [];

    // Parse body to see if it's valid JSON
    let parsedBody = null;
    try {
      parsedBody = JSON.parse(data.body);
    } catch (e) {
      // Not JSON — store as raw text
      parsedBody = data.body;
    }

    const entry = {
      id: generateId(),
      timestamp: new Date(data.timestamp).toISOString(),
      url: data.url,
      status: data.status,
      body: parsedBody,
      sizeBytes: data.sizeBytes,
    };

    sessions.push(entry);

    // Auto-cleanup old entries
    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const cleaned = sessions.filter(
      (s) => new Date(s.timestamp).getTime() > cutoff
    );

    await chrome.storage.local.set({ [STORAGE_KEY]: cleaned });
    updateBadge(cleaned.length);

    // BOT: if keyword data arrived for the current listing, reset the settle timer
    if (bot.active && bot.listingId && parsedBody && typeof parsedBody === "object") {
      const queries = parsedBody.queryStats || parsedBody.queries;
      if (Array.isArray(queries) && queries.length > 0) {
        const bodyId = String(
          (parsedBody.listing && parsedBody.listing.listingId) ||
          parsedBody.listingId ||
          ""
        );
        const urlMatch = (data.url || "").match(/\/(?:listings|querystats)\/(\d+)/);
        const urlId = urlMatch ? urlMatch[1] : "";
        const matches =
          (!bodyId || bodyId === bot.listingId) &&
          (!urlId || urlId === bot.listingId);
        if (matches) scheduleBotSettle();
      }
    }
  } catch (e) {
    console.error("[Getify] Storage write error:", e);
  }
}

async function handleGetAll(sendResponse) {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const sessions = result[STORAGE_KEY] || [];
    sendResponse({ sessions: sessions });
  } catch (e) {
    sendResponse({ sessions: [] });
  }
}

async function handleClearAll(sendResponse) {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: [] });
    updateBadge(0);
    sendResponse({ ok: true });
  } catch (e) {
    sendResponse({ ok: false });
  }
}

async function handleGetStats(sendResponse) {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const sessions = result[STORAGE_KEY] || [];

    let totalSize = 0;
    sessions.forEach((s) => (totalSize += s.sizeBytes || 0));

    sendResponse({
      count: sessions.length,
      totalSizeBytes: totalSize,
      oldestEntry: sessions.length > 0 ? sessions[0].timestamp : null,
      newestEntry:
        sessions.length > 0 ? sessions[sessions.length - 1].timestamp : null,
    });
  } catch (e) {
    sendResponse({ count: 0, totalSizeBytes: 0 });
  }
}

// =====================================================================
// DATABASE CONFIG
// =====================================================================

async function handleSaveDbConfig(data, sendResponse) {
  try {
    await chrome.storage.local.set({
      [DB_CONFIG_KEY]: {
        connectionString: (data.connectionString || "").trim(),
      },
    });
    sendResponse({ ok: true });
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
}

async function handleGetDbConfig(sendResponse) {
  try {
    const result = await chrome.storage.local.get(DB_CONFIG_KEY);
    const config = result[DB_CONFIG_KEY] || {};
    sendResponse({ connectionString: config.connectionString || "" });
  } catch (e) {
    sendResponse({ connectionString: "" });
  }
}

// =====================================================================
// NEON HTTP SQL — Direct PostgreSQL over HTTPS
// No local relay, no Node.js, no TCP. Just fetch().
// Docs: https://neon.tech/docs/serverless/serverless-driver
// =====================================================================

/**
 * Parse a PostgreSQL connection string into its components.
 * Example: postgresql://user:pass@host.neon.tech/dbname?sslmode=require
 */
function parseConnectionString(connStr) {
  try {
    const normalized = connStr.replace(/^postgres(ql)?:\/\//, "https://");
    const url = new URL(normalized);
    return {
      host: url.hostname,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, ""),
      fullString: connStr.trim(),
    };
  } catch (e) {
    return null;
  }
}

/**
 * Execute one or more SQL queries via Neon's SQL-over-HTTP endpoint.
 *
 * Pass a single query object: { query: "...", params: [...] }
 *
 * The Neon HTTP SQL API is at: https://<host>/sql
 * Auth is via the Neon-Connection-String header.
 */
async function neonHttpQuery(connectionString, queryObj) {
  const parsed = parseConnectionString(connectionString);
  if (!parsed) {
    throw new Error("Invalid connection string format");
  }

  const endpoint = `https://${parsed.host}/sql`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Neon-Connection-String": parsed.fullString,
      "Neon-Raw-Text-Output": "true",
    },
    body: JSON.stringify(queryObj),
  });

  const responseText = await response.text();

  if (!response.ok) {
    let errorMsg;
    try {
      const errorJson = JSON.parse(responseText);
      errorMsg = errorJson.message || errorJson.error || responseText;
    } catch (e) {
      errorMsg = responseText;
    }
    throw new Error(`HTTP ${response.status}: ${errorMsg}`);
  }

  let result;
  try {
    result = JSON.parse(responseText);
  } catch (e) {
    throw new Error("Invalid JSON response from Neon: " + responseText.substring(0, 200));
  }

  // Neon can return 200 with error payload — check for it
  if (result && result.message && !result.command) {
    throw new Error(result.message);
  }

  return result;
}

// =====================================================================
// TEST CONNECTION
// =====================================================================

async function handleTestDbConnection(connectionString, sendResponse) {
  try {
    if (!connectionString || !connectionString.trim()) {
      sendResponse({ ok: false, error: "Connection string is empty" });
      return;
    }

    const result = await neonHttpQuery(connectionString, {
      query: "SELECT 1 AS connected",
      params: [],
    });

    sendResponse({ ok: true, result: result });
  } catch (e) {
    sendResponse({ ok: false, error: e.message || String(e) });
  }
}

// =====================================================================
// INSERT LISTING REPORT ROWS
// =====================================================================

function normalizeRow(row) {
  return {
    listing_id: String(row.listing_id || ""),
    title: row.title || null,
    no_vm: row.no_vm || null,
    price: row.price != null ? String(Number(row.price)) : null,
    stock: row.stock != null ? Number(row.stock) : null,
    category: row.category || null,
    lifetime_orders:
      row.lifetime_orders != null ? Number(row.lifetime_orders) : null,
    lifetime_revenue:
      row.lifetime_revenue != null ? String(Number(row.lifetime_revenue)) : null,
    period: String(row.period || ""),
    views: row.views != null ? Number(row.views) : null,
    clicks: row.clicks != null ? Number(row.clicks) : null,
    orders: row.orders != null ? Number(row.orders) : null,
    revenue: row.revenue != null ? String(Number(row.revenue)) : null,
    spend: row.spend != null ? String(Number(row.spend)) : null,
    roas: row.roas != null ? String(Number(row.roas)) : null,
    import_time: row.import_time || null,
    importer: row.importer || null,
  };
}

async function handleInsertToDb(rows, connectionString, sendResponse) {
  try {
    if (!connectionString || !connectionString.trim()) {
      sendResponse({
        ok: false,
        error: "No connection string configured. Open Settings to add one.",
      });
      return;
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      sendResponse({ ok: false, error: "No rows to insert" });
      return;
    }

    const columns = [
      "listing_id",
      "title",
      "no_vm",
      "price",
      "stock",
      "category",
      "lifetime_orders",
      "lifetime_revenue",
      "period",
      "views",
      "clicks",
      "orders",
      "revenue",
      "spend",
      "roas",
      "import_time",
      "importer",
    ];

    const numCols = columns.length; // 17
    const params = [];
    const valuesClauses = [];

    for (let i = 0; i < rows.length; i++) {
      const row = normalizeRow(rows[i]);

      // Validate required fields
      if (!row.listing_id || !row.period) {
        sendResponse({
          ok: false,
          error: `Row ${i + 1} is missing listing_id or period`,
        });
        return;
      }

      const offset = i * numCols;
      const placeholders = columns.map((_, j) => `$${offset + j + 1}`);
      valuesClauses.push(`(${placeholders.join(", ")})`);

      params.push(
        row.listing_id,
        row.title,
        row.no_vm,
        row.price,
        row.stock,
        row.category,
        row.lifetime_orders,
        row.lifetime_revenue,
        row.period,
        row.views,
        row.clicks,
        row.orders,
        row.revenue,
        row.spend,
        row.roas,
        row.import_time,
        row.importer
      );
    }

    const sql = `INSERT INTO listing_report (${columns.join(", ")}) VALUES ${valuesClauses.join(", ")}`;

    // Execute the INSERT
    const insertResult = await neonHttpQuery(connectionString, {
      query: sql,
      params: params,
    });


    // Validate the response has the expected INSERT command
    if (insertResult && insertResult.command && insertResult.command !== "INSERT") {
      throw new Error("Unexpected command in response: " + insertResult.command);
    }

    // Verify by querying the database
    const verifyResult = await neonHttpQuery(connectionString, {
      query: "SELECT count(*)::int AS total FROM listing_report",
      params: [],
    });


    const totalInDb = verifyResult && Array.isArray(verifyResult) && verifyResult[0]
      ? Number(verifyResult[0].total)
      : (verifyResult && verifyResult.rows && verifyResult.rows[0]
        ? Number(verifyResult.rows[0].total)
        : null);

    // Build response
    let inserted = 0;
    if (insertResult && insertResult.rowCount != null) {
      inserted = insertResult.rowCount;
    } else if (insertResult && Array.isArray(insertResult)) {
      // neon() default format returns just an array
      inserted = rows.length;
    } else {
      inserted = rows.length;
    }

    const msg = totalInDb != null
      ? `Inserted ${inserted} rows. Total rows in listing_report: ${totalInDb}`
      : `Inserted ${inserted} rows into listing_report.`;

    sendResponse({ ok: true, inserted: inserted, total: totalInDb, message: msg });
  } catch (e) {
    console.error("[Getify] INSERT error:", e);
    sendResponse({ ok: false, error: e.message || String(e) });
  }
}

// =====================================================================
// INSERT KEYWORD REPORT ROWS
// =====================================================================

function normalizeKeywordRow(row) {
  return {
    listing_id: String(row.listing_id || ""),
    keyword: row.keyword || null,
    no_vm: row.no_vm || null,
    period: String(row.period || ""),
    roas: row.roas != null ? String(Number(row.roas)) : null,
    orders: row.orders != null ? Number(row.orders) : null,
    spend: row.spend != null ? String(Number(row.spend)) : null,
    revenue: row.revenue != null ? String(Number(row.revenue)) : null,
    clicks: row.clicks != null ? Number(row.clicks) : null,
    click_rate: row.click_rate || null,
    views: row.views != null ? Number(row.views) : null,
    import_time: row.import_time || null,
    importer: row.importer || null,
    relevant: row.relevant || null,
  };
}

async function handleInsertKeywordsToDb(rows, connectionString, sendResponse) {
  try {
    if (!connectionString || !connectionString.trim()) {
      sendResponse({
        ok: false,
        error: "No connection string configured. Open Settings to add one.",
      });
      return;
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      sendResponse({ ok: false, error: "No keyword rows to insert" });
      return;
    }

    // Guard: every listing_id in this batch must already exist in listing_report
    const listingIds = [...new Set(rows.map((r) => String(r.listing_id || "")).filter(Boolean))];
    if (listingIds.length > 0) {
      const placeholders = listingIds.map((_, i) => `$${i + 1}`).join(", ");
      const checkResult = await neonHttpQuery(connectionString, {
        query: `SELECT listing_id FROM listing_report WHERE listing_id = ANY(ARRAY[${placeholders}]) GROUP BY listing_id`,
        params: listingIds,
      });
      const foundIds = new Set(
        (Array.isArray(checkResult) ? checkResult : (checkResult.rows || []))
          .map((r) => String(r.listing_id))
      );
      const missing = listingIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        sendResponse({
          ok: false,
          error: `Cannot insert keywords — listing(s) not in listing_report yet: ${missing.join(", ")}. Add them via "Add Listings to DB" first.`,
        });
        return;
      }
    }

    const columns = [
      "listing_id",
      "keyword",
      "no_vm",
      "period",
      "roas",
      "orders",
      "spend",
      "revenue",
      "clicks",
      "click_rate",
      "views",
      "import_time",
      "importer",
      "relevant",
    ];

    const numCols = columns.length; // 14
    const params = [];
    const valuesClauses = [];

    for (let i = 0; i < rows.length; i++) {
      const row = normalizeKeywordRow(rows[i]);

      // Validate required fields
      if (!row.listing_id || !row.keyword || !row.period) {
        sendResponse({
          ok: false,
          error: `Keyword row ${i + 1} is missing listing_id, keyword or period`,
        });
        return;
      }

      const offset = i * numCols;
      const placeholders = columns.map((_, j) => `$${offset + j + 1}`);
      valuesClauses.push(`(${placeholders.join(", ")})`);

      params.push(
        row.listing_id,
        row.keyword,
        row.no_vm,
        row.period,
        row.roas,
        row.orders,
        row.spend,
        row.revenue,
        row.clicks,
        row.click_rate,
        row.views,
        row.import_time,
        row.importer,
        row.relevant
      );
    }

    const sql = `INSERT INTO keyword_report (${columns.join(", ")}) VALUES ${valuesClauses.join(", ")}`;

    // Execute the INSERT
    const insertResult = await neonHttpQuery(connectionString, {
      query: sql,
      params: params,
    });

    // Validate the response has the expected INSERT command
    if (insertResult && insertResult.command && insertResult.command !== "INSERT") {
      throw new Error("Unexpected command in response: " + insertResult.command);
    }

    // Verify by querying the database
    const verifyResult = await neonHttpQuery(connectionString, {
      query: "SELECT count(*)::int AS total FROM keyword_report",
      params: [],
    });

    const totalInDb = verifyResult && Array.isArray(verifyResult) && verifyResult[0]
      ? Number(verifyResult[0].total)
      : (verifyResult && verifyResult.rows && verifyResult.rows[0]
        ? Number(verifyResult.rows[0].total)
        : null);

    // Build response
    let inserted = 0;
    if (insertResult && insertResult.rowCount != null) {
      inserted = insertResult.rowCount;
    } else if (insertResult && Array.isArray(insertResult)) {
      inserted = rows.length;
    } else {
      inserted = rows.length;
    }

    const msg = totalInDb != null
      ? `Inserted ${inserted} rows. Total keywords in DB: ${totalInDb}`
      : `Inserted ${inserted} rows into keyword_report.`;

    sendResponse({ ok: true, inserted: inserted, total: totalInDb, message: msg });
  } catch (e) {
    console.error("[Getify] INSERT keyword error:", e);
    sendResponse({ ok: false, error: e.message || String(e) });
  }
}

// =====================================================================
// HELPERS
// =====================================================================

function generateId() {
  return (
    Date.now().toString(36) + Math.random().toString(36).substring(2, 8)
  );
}

function updateBadge(count) {
  const text = count > 0 ? String(count) : "";
  chrome.action.setBadgeText({ text: text });
  chrome.action.setBadgeBackgroundColor({ color: "#4CAF50" });
}

// Reset badge on extension install/update
chrome.runtime.onInstalled.addListener(() => {
  updateBadge(0);
});

// =====================================================================
// BOT ORCHESTRATOR
// Fully automated keyword harvesting:
//   open tab → expand table → wait for API settle → save to DB → next
// =====================================================================

const QUEUE_KEY = "getify_keyword_queue_v2";

// Human-like timing ranges (all in ms)
const BOT_PRE_EXPAND = [3_000, 6_000];  // wait after page loads before clicking anything
const BOT_SETTLE = [6_000, 10_000];  // wait after last keyword API hit before saving
const BOT_EXPAND_LIMIT = [14_000, 22_000]; // max time given for expansion before giving up
const BOT_NEXT_PAUSE = [4_000, 9_000];  // rest between closing one tab and opening the next

function jitter(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

const bot = {
  active: false,
  state: "idle",    // idle | opening | expanding | capturing | saving | waiting_user | complete
  listingId: null,
  tabId: null,
  settleTimer: null,
  expandFallback: null,
  waitingTimer: null, // auto-skip timer when state === "waiting_user"
  urlTemplate: null,
  connectionString: null,
  errorMsg: null,    // populated when state === "waiting_user"
  errorType: null,   // "no_data" | "db_error" | "no_listing"
};

// --- Queue helpers -------------------------------------------------------

async function queueGet() {
  const r = await chrome.storage.local.get(QUEUE_KEY);
  return r[QUEUE_KEY] || [];
}

async function queueSave(queue) {
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
}

async function handleQueueAdd(listingIds, urlTemplate, autoStart, sendResponse) {
  const queue = await queueGet();
  const existing = new Set(queue.map((q) => String(q.listing_id)));
  let added = 0;
  for (const id of listingIds.map(String)) {
    if (!existing.has(id)) {
      queue.push({ listing_id: id, title: "", status: "pending" });
      existing.add(id);
      added++;
    }
  }
  await queueSave(queue);
  sendResponse({ ok: true, added, total: queue.length });

  // Use the template from the message; fall back to whatever the bot already knows.
  // This ensures autoStart works even after a service worker restart (bot.urlTemplate = null).
  const template = urlTemplate || bot.urlTemplate || "";
  if (autoStart && added > 0 && !bot.active && template.includes("{listing_id}")) {
    botStart(template);
  }
}

// --- Bot state machine --------------------------------------------------

function botPublicState() {
  return {
    active: bot.active,
    state: bot.state,
    listingId: bot.listingId,
    errorMsg: bot.errorMsg,
  };
}

function botNotify(msg) {
  chrome.runtime.sendMessage(msg).catch(() => { });
}

async function botStart(urlTemplate) {
  if (bot.active) return;

  const cfgResult = await chrome.storage.local.get(DB_CONFIG_KEY);
  const conn = ((cfgResult[DB_CONFIG_KEY] || {}).connectionString || "").trim();

  bot.active = true;
  bot.urlTemplate = urlTemplate || bot.urlTemplate || "";
  bot.connectionString = conn;

  // Shuffle pending items so the access order is non-sequential
  const queue = await queueGet();
  const pending = queue.filter((q) => !q.status || q.status === "pending");
  const others = queue.filter((q) => q.status && q.status !== "pending");
  for (let k = pending.length - 1; k > 0; k--) {
    const j = Math.floor(Math.random() * (k + 1));
    [pending[k], pending[j]] = [pending[j], pending[k]];
  }
  await queueSave([...pending, ...others]);

  await botOpenNext();
}

function botStop() {
  clearBotTimers();
  bot.active = false;
  bot.state = "idle";
  bot.listingId = null;
  botNotify({ action: "BOT_STATUS_UPDATE", bot: botPublicState() });
}

async function botOpenNext() {
  if (!bot.active) return;

  const queue = await queueGet();
  const item = queue.find(
    (q) => !q.status || q.status === "pending"
  );

  if (!item) {
    const done = queue.filter((q) => q.status === "done").length;
    bot.active = false;
    bot.state = "complete";
    bot.listingId = null;
    // Close the reused tab now that the queue is exhausted
    if (bot.tabId) {
      try { await chrome.tabs.remove(bot.tabId); } catch (_) { }
      bot.tabId = null;
    }
    botNotify({ action: "BOT_COMPLETE", done, total: queue.length });
    return;
  }

  if (!bot.urlTemplate || !bot.urlTemplate.includes("{listing_id}")) {
    bot.active = false;
    bot.state = "idle";
    botNotify({ action: "BOT_ERROR", error: "Keyword URL template missing {listing_id}" });
    return;
  }

  item.status = "opened";
  item.opened_at = new Date().toISOString();
  await queueSave(queue);

  const url = bot.urlTemplate.replace(
    /\{listing_id\}/g,
    encodeURIComponent(item.listing_id)
  );

  bot.state = "opening";
  bot.listingId = String(item.listing_id);

  try {
    if (bot.tabId) {
      // Reuse the existing tab — just navigate it to the next listing.
      // Etsy sees a normal navigation, not a new tab being created.
      await chrome.tabs.update(bot.tabId, { url });
    } else {
      // First listing, or the tab was closed manually — open a fresh one.
      const tab = await chrome.tabs.create({ url });
      bot.tabId = tab.id;
    }
    botNotify({ action: "BOT_STATUS_UPDATE", bot: botPublicState() });
  } catch (e) {
    // Tab may have been closed unexpectedly — fall back to creating a new one
    try {
      const tab = await chrome.tabs.create({ url });
      bot.tabId = tab.id;
      botNotify({ action: "BOT_STATUS_UPDATE", bot: botPublicState() });
    } catch (e2) {
      bot.active = false;
      bot.state = "idle";
      botNotify({ action: "BOT_ERROR", error: String(e2.message || e2) });
    }
  }
}

function clearBotTimers() {
  if (bot.settleTimer) { clearTimeout(bot.settleTimer); bot.settleTimer = null; }
  if (bot.expandFallback) { clearTimeout(bot.expandFallback); bot.expandFallback = null; }
  if (bot.waitingTimer) { clearTimeout(bot.waitingTimer); bot.waitingTimer = null; }
}

function scheduleBotSettle() {
  if (bot.expandFallback) { clearTimeout(bot.expandFallback); bot.expandFallback = null; }
  if (bot.settleTimer) clearTimeout(bot.settleTimer);
  bot.settleTimer = setTimeout(botSaveAndAdvance, jitter(...BOT_SETTLE));
  bot.state = "capturing";
}

// Auto-skip after 60 min if popup is never reopened to answer the prompt
const BOT_WAITING_TIMEOUT = 60 * 60 * 1000;

function enterWaitingUser(errorMsg, errorType) {
  if (bot.waitingTimer) clearTimeout(bot.waitingTimer);
  bot.state = "waiting_user";
  bot.errorMsg = errorMsg;
  bot.errorType = errorType;
  botNotify({ action: "BOT_ERROR_PROMPT", listingId: bot.listingId, error: errorMsg });

  bot.waitingTimer = setTimeout(async () => {
    if (bot.state !== "waiting_user") return;
    const skipStatus = bot.errorType === "no_data" ? "skipped" : "error";
    bot.errorMsg = null;
    bot.errorType = null;
    bot.waitingTimer = null;
    await botMarkListing(bot.listingId, skipStatus);
    await chrome.storage.local.set({ [STORAGE_KEY]: [] });
    updateBadge(0);
    await botOpenNext();
  }, BOT_WAITING_TIMEOUT);
}

async function botSaveAndAdvance() {
  bot.settleTimer = null;
  if (!bot.active || !bot.listingId) return;

  bot.state = "saving";
  botNotify({ action: "BOT_STATUS_UPDATE", bot: botPublicState() });

  const result = await chrome.storage.local.get(STORAGE_KEY);
  const sessions = result[STORAGE_KEY] || [];
  // Build rows for both daily listings and keywords
  const keywordRows = buildKeywordRowsFromSessions(sessions, bot.listingId);
  const dailyListingRows = buildListingDailyRowsFromSessions(sessions, bot.listingId);

  // No data found — prompt user to retry or skip
  if (keywordRows.length === 0 && dailyListingRows.length === 0) {
    enterWaitingUser(`No data found for listing ${bot.listingId}`, "no_data");
    return;
  }

  let saveOk = true;
  let saveMsg = "";

  try {
    // 1. Insert daily listing stats
    if (dailyListingRows.length > 0) {
      const listingRes = await new Promise((resolve) =>
        handleInsertToDb(dailyListingRows, bot.connectionString, resolve)
      );
      if (!listingRes.ok) {
        saveOk = false;
        saveMsg = "Listing DB error: " + (listingRes.error || "Unknown");
      }
    }

    // 2. Insert keyword stats
    if (saveOk && keywordRows.length > 0) {
      const kwRes = await new Promise((resolve) =>
        handleInsertKeywordsToDb(keywordRows, bot.connectionString, resolve)
      );
      if (!kwRes.ok) {
        saveOk = false;
        saveMsg = "Keyword DB error: " + (kwRes.error || "Unknown");
      }
    }
  } catch (e) {
    saveOk = false;
    saveMsg = String(e.message || e) || "Unknown database error";
  }

  // DB / network error — prompt user to retry or skip
  if (!saveOk) {
    enterWaitingUser(saveMsg, "db_error");
    return;
  }

  await botMarkListing(bot.listingId, "done");

  botNotify({
    action: "BOT_LISTING_SAVED",
    listingId: bot.listingId,
    keywordRows: keywordRows.length,
    listingRows: dailyListingRows.length,
    ok: saveOk,
    message: saveMsg,
  });

  // Tab is kept open and reused for the next listing (see botOpenNext)

  // Clear sessions so next listing starts fresh
  await chrome.storage.local.set({ [STORAGE_KEY]: [] });
  updateBadge(0);

  // Human-like pause before moving to the next listing
  await new Promise((r) => setTimeout(r, jitter(...BOT_NEXT_PAUSE)));

  await botOpenNext();
}

async function handleBotResume(decision, sendResponse) {
  sendResponse({ ok: true });
  if (bot.waitingTimer) { clearTimeout(bot.waitingTimer); bot.waitingTimer = null; }
  const errorType = bot.errorType || "db_error";
  bot.errorMsg = null;
  bot.errorType = null;

  if (decision === "retry") {
    bot.state = "opening";
    await botMarkListing(bot.listingId, "pending");
    await botOpenNext();
  } else {
    // no_data  → "skipped"  (page genuinely had no keywords)
    // no_listing → "error"  (listing not in DB — needs manual action)
    // db_error → "error"   (DB/network failure)
    const skipStatus = errorType === "no_data" ? "skipped" : "error";
    await botMarkListing(bot.listingId, skipStatus);
    await chrome.storage.local.set({ [STORAGE_KEY]: [] });
    updateBadge(0);
    await new Promise((r) => setTimeout(r, jitter(...BOT_NEXT_PAUSE)));
    await botOpenNext();
  }
}

async function botMarkListing(listingId, status) {
  const queue = await queueGet();
  const item = queue.find((q) => String(q.listing_id) === String(listingId));
  if (item) {
    item.status = status;
    if (status === "done") item.saved_at = new Date().toISOString();
    await queueSave(queue);
  }
}

// --- Row builders (runs in background) ---

function buildListingDailyRowsFromSessions(sessions, targetListingId) {
  const rows = [];
  const importTime = new Date().toISOString();
  const vmName = typeof APP_CONFIG !== "undefined" ? APP_CONFIG.VM_NAME : null;

  for (const entry of sessions) {
    const body = entry.body;
    if (!body || typeof body !== "object") continue;

    // Check if it has graphStats and listing metadata
    if (body.listing && body.graphStats && Array.isArray(body.graphStats)) {
      const listing = body.listing;
      const listingIdStr = String(listing.listingId || targetListingId || "");

      if (listingIdStr && targetListingId && listingIdStr !== String(targetListingId)) continue;

      for (const stat of body.graphStats) {
        // Convert timestamp to YYYY-MM-DD
        const ts = stat.timestamp > 9999999999 ? stat.timestamp : stat.timestamp * 1000;
        const dateObj = new Date(ts);
        const yyyy = dateObj.getFullYear();
        const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
        const dd = String(dateObj.getDate()).padStart(2, '0');
        const period = `${yyyy}-${mm}-${dd}`;

        let roasVal = stat.roas;
        if (typeof roasVal === 'object' && roasVal !== null && roasVal.parsedValue != null) {
          roasVal = roasVal.parsedValue;
        }

        const spendCents = stat.spentTotal || 0;
        const revenueCents = stat.revenue || 0;
        const priceCents = listing.priceInt || 0;

        rows.push({
          listing_id: listingIdStr,
          title: listing.title || "",
          no_vm: vmName,
          price: (priceCents / 100).toFixed(2),
          stock: listing.quantity != null ? Number(listing.quantity) : null,
          category: listing.sectionName || null,
          lifetime_orders: null,
          lifetime_revenue: null,
          period: period,
          views: stat.impressionCount || 0,
          clicks: stat.clickCount || 0,
          orders: stat.conversions || 0,
          revenue: (revenueCents / 100).toFixed(2),
          spend: (spendCents / 100).toFixed(2),
          roas: Number(roasVal || 0).toFixed(2),
          import_time: importTime,
          importer: "getify_bot_daily"
        });
      }
    }
  }

  // Deduplicate rows by period in case of multiple API calls for the same listing
  const dedupeMap = new Map();
  for (const row of rows) {
    dedupeMap.set(row.period, row); // Latest data overwrites older data
  }
  return Array.from(dedupeMap.values());
}

function buildKeywordRowsFromSessions(sessions, targetListingId) {
  const rows = [];
  const importTime = new Date().toISOString();
  const vmName = typeof APP_CONFIG !== "undefined" ? APP_CONFIG.VM_NAME : null;

  for (const entry of sessions) {
    const url = entry.url || "";
    const body = entry.body;
    if (!body || typeof body !== "object") continue;

    const queries = body.queryStats || body.queries;
    if (!Array.isArray(queries) || queries.length === 0) continue;

    let sessionListingId = String(
      (body.listing && body.listing.listingId) || body.listingId || ""
    );
    if (!sessionListingId) {
      const m = url.match(/\/(?:listings|querystats)\/(\d+)/);
      if (m) sessionListingId = m[1];
    }
    if (!sessionListingId) sessionListingId = targetListingId || "";

    if (
      sessionListingId &&
      targetListingId &&
      sessionListingId !== String(targetListingId)
    )
      continue;

    let start = body.startDate || null;
    let end = body.endDate || null;
    if (!start) {
      const m = url.match(/[?&]start_date=([^&]+)/);
      if (m) start = decodeURIComponent(m[1]).split(",")[0].trim();
    }
    if (!end) {
      const m = url.match(/[?&]end_date=([^&]+)/);
      if (m) end = decodeURIComponent(m[1]).split(",")[0].trim();
    }

    const startFmt = start ? String(start).replace(/-/g, "/") : null;
    const endFmt = end ? String(end).replace(/-/g, "/") : null;
    const period =
      startFmt && endFmt ? `${startFmt}-${endFmt}` : "custom_default";

    for (const q of queries) {
      if (!q.stemmedQuery) continue;
      rows.push({
        listing_id: sessionListingId,
        keyword: q.stemmedQuery,
        no_vm: vmName,
        period,
        roas: q.roas || 0,
        orders: q.orderCount || 0,
        spend: q.cost || 0,
        revenue: q.revenue || 0,
        clicks: q.clickCount || 0,
        click_rate: String(q.clickRate || 0),
        views: q.impressionCounts || 0,
        import_time: importTime,
        importer: "getify_bot",
        relevant: q.isRelevant != null ? String(q.isRelevant) : null,
      });
    }
  }

  return rows;
}

// --- Tab lifecycle listeners --------------------------------------------

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!bot.active || tabId !== bot.tabId) return;
  if (changeInfo.status !== "complete") return;

  bot.state = "expanding";

  // Human-like: pause before touching the page (simulates reading / orienting)
  const preWait = jitter(...BOT_PRE_EXPAND);

  setTimeout(() => {
    if (!bot.active || bot.tabId !== tabId) return;

    chrome.tabs.sendMessage(tabId, { action: "EXPAND_KEYWORDS" }).catch(() => {
      scheduleBotSettle();
    });

    // Fallback: give up waiting for expansion after a randomised window
    bot.expandFallback = setTimeout(() => {
      if (bot.active && bot.tabId === tabId && bot.state === "expanding") {
        scheduleBotSettle();
      }
    }, jitter(...BOT_EXPAND_LIMIT));
  }, preWait);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!bot.active || tabId !== bot.tabId) return;
  // User closed the tab manually — clear it so botOpenNext opens a new one
  bot.tabId = null;
  clearBotTimers();
  setTimeout(() => {
    if (bot.active && bot.listingId) botSaveAndAdvance();
  }, 800);
});

