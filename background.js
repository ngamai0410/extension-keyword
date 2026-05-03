// ===========================================================================
// Getify Ads Spy — Service Worker (Background)
// Data warehouse: stores captured API responses in chrome.storage.local.
// Database: connects directly to Neon PostgreSQL via HTTP SQL API.
// No local relay server needed.
// ===========================================================================

const MAX_AGE_DAYS = 30;
const STORAGE_KEY = "getify_sessions";
const DB_CONFIG_KEY = "getify_db_config";

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

    // Update badge count
    updateBadge(cleaned.length);
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
// NAVIGATION CACHE CLEARING
// =====================================================================

// Clear the cache and badge when navigating to a new URL on Etsy
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0) {
    handleClearAll(() => {});
  }
}, {url: [{hostContains: 'etsy.com'}]});

// Clear the cache and badge when SPA (client-side routing) navigates to a new URL on Etsy
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId === 0) {
    handleClearAll(() => {});
  }
}, {url: [{hostContains: 'etsy.com'}]});
