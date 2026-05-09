// ===========================================================================
// Getify Ads Spy — Popup Logic
// Reads captured sessions from storage, renders UI, handles export/clear.
// ===========================================================================

document.addEventListener("DOMContentLoaded", () => {
  // --- SETTINGS ELEMENTS ---
  const settingsPanel = document.getElementById("settings-panel");
  const settingsToggle = document.getElementById("settings-toggle");
  const settingsArrow = document.getElementById("settings-arrow");
  const settingsBody = document.getElementById("settings-body");
  const inputConnString = document.getElementById("input-conn-string");
  const btnSaveConfig = document.getElementById("btn-save-config");
  const btnTestConn = document.getElementById("btn-test-conn");
  const btnToggleVisibility = document.getElementById("btn-toggle-visibility");
  const btnSettings = document.getElementById("btn-settings");
  const settingsStatus = document.getElementById("settings-status");

  const btnExportClean = document.getElementById("btn-export-clean");
  const btnExport = document.getElementById("btn-export");
  const btnExportCsv = document.getElementById("btn-export-csv");
  const btnAddDb = document.getElementById("btn-add-db");
  const btnAddDbKeywords = document.getElementById("btn-add-db-keywords");
  const btnClear = document.getElementById("btn-clear");
  const sessionList = document.getElementById("session-list");
  const emptyState = document.getElementById("empty-state");
  const statsLine = document.getElementById("stats-line");
  const dbStatus = document.getElementById("db-status");
  const queueSummary = document.getElementById("queue-summary");
  const keywordQueueList = document.getElementById("keyword-queue-list");
  const inputKeywordUrlTemplate = document.getElementById("input-keyword-url-template");
  const btnRefreshQueue = document.getElementById("btn-refresh-queue");
  const btnOpenNextKeyword = document.getElementById("btn-open-next-keyword");
  const btnMarkKeywordDone = document.getElementById("btn-mark-keyword-done");
  const btnResetKeywordQueue = document.getElementById("btn-reset-keyword-queue");

  const KEYWORD_TEMPLATE_STORAGE_KEY = "getify_keyword_url_template_v1";
  const DEFAULT_KEYWORD_URL_TEMPLATE =
    "https://www.etsy.com/your/shops/me/advertising/listings/{listing_id}";

  let allSessions = [];
  let keywordQueue = [];
  let botRunning = false;
  let currentPageType = "other"; // dashboard | keywords | etsy_other | other

  // --- LOAD DATA ---

  function loadData() {
    chrome.runtime.sendMessage({ action: "GET_ALL" }, (response) => {
      allSessions = (response && response.sessions) || [];
      renderSessions();
      updateStats();
      syncCapturedKeywordStatuses();
      renderKeywordQueue();
    });
  }

  // --- RENDER ---

  function renderSessions() {
    // Clear existing cards (keep empty state)
    const cards = sessionList.querySelectorAll(".session-card");
    cards.forEach((c) => c.remove());

    if (allSessions.length === 0) {
      emptyState.style.display = "block";
      btnExportClean.disabled = true;
      btnExport.disabled = true;
      btnExportCsv.disabled = true;
      btnAddDb.disabled = true;
      btnAddDbKeywords.disabled = true;
      btnClear.disabled = true;
      applyPageContext(currentPageType);
      return;
    }

    emptyState.style.display = "none";
    btnExportClean.disabled = false;
    btnExport.disabled = false;
    btnExportCsv.disabled = false;
    btnAddDb.disabled = false;
    btnAddDbKeywords.disabled = false;
    btnClear.disabled = false;
    setDbStatus("Ready to insert.", "info");
    applyPageContext(currentPageType);

    // Render newest first
    const reversed = [...allSessions].reverse();

    reversed.forEach((session) => {
      const card = document.createElement("div");
      card.className = "session-card";

      // Shorten URL for display
      const shortUrl = shortenUrl(session.url);
      const time = formatTime(session.timestamp);
      const size = formatBytes(session.sizeBytes || 0);
      const isError = session.status >= 400;

      card.innerHTML = `
        <div class="session-url">${escapeHtml(shortUrl)}</div>
        <div class="session-meta">
          <span class="session-status ${isError ? "error" : ""}">
            ${session.status}
          </span>
          <span>${size}</span>
          <span>${time}</span>
        </div>
        <div class="session-body" id="body-${session.id}"></div>
      `;

      // Toggle body preview on click
      card.addEventListener("click", () => {
        const bodyEl = document.getElementById(`body-${session.id}`);
        const isVisible = bodyEl.classList.contains("visible");

        if (isVisible) {
          bodyEl.classList.remove("visible");
          card.classList.remove("expanded");
        } else {
          // Lazy-render body content (performance optimization)
          if (!bodyEl.textContent) {
            const bodyStr =
              typeof session.body === "object"
                ? JSON.stringify(session.body, null, 2)
                : String(session.body);
            bodyEl.textContent = bodyStr.substring(0, 5000); // Cap at 5KB for display
            if (bodyStr.length > 5000) {
              bodyEl.textContent += "\n\n... (truncated, export for full data)";
            }
          }
          bodyEl.classList.add("visible");
          card.classList.add("expanded");
        }
      });

      sessionList.appendChild(card);
    });
  }

  function updateStats() {
    chrome.runtime.sendMessage({ action: "GET_STATS" }, (response) => {
      if (!response) return;
      const count = response.count || 0;
      const size = formatBytes(response.totalSizeBytes || 0);
      statsLine.textContent = `${count} captured responses (${size} total)`;
    });
  }

  // =====================================================================
  // ETL — Clean Data Transformer
  // Converts raw intercepted API responses into structured analytics JSON
  // =====================================================================

  function transformToClean(sessions) {
    const result = {
      metadata: {
        exported_at: new Date().toISOString(),
        source: "Getify Ads Spy Extension",
        raw_responses_count: sessions.length,
        date_range: {
          start: null,
          end: null,
        },
        total_promoted_listings: 0,
      },
      campaign: {},
      shop_stats: {},
      listings: [],
      listing_report_rows: [],
      keywords: [],
      keyword_report_rows: [],
      revenue_attribution: [],
      shop_info: {},
      trending_queries: [],
      shop_sections: [],
    };

    // Temporary map to deduplicate listings across multiple etsyads responses
    // (e.g., first load shows 15, user clicks "Show 50" fires a second call)
    const listingsMap = new Map();

    for (const entry of sessions) {
      const url = entry.url || "";
      const body = entry.body;
      if (!body || typeof body !== "object") continue;

      const hasEtsyAdsShape =
        !!body.campaign ||
        !!body.campaignShopStats ||
        !!body.campaignListingsStats;
      const hasListingsShape = hasListingStatsShape(body);
      const hasAttributionShape =
        Array.isArray(body.attributionEvents) && body.attributionEvents.length > 0;

      if (hasEtsyAdsShape || url.indexOf("etsyads") !== -1) {
        processEtsyAds(body, result, listingsMap);
      } else if (hasListingsShape || url.indexOf("prolist/stats/listings") !== -1) {
        // "Show 50" / sort / filter fires this separate endpoint
        processProlistStats(body, listingsMap);
      }

      if ((body && (body.queryStats || body.queries)) || url.indexOf("querystats") !== -1) {
        processKeywordStats(body, result, url);
      }

      if (body.listing && body.graphStats && Array.isArray(body.graphStats)) {
        processListingDailyStats(body, result, url);
      }

      if (hasAttributionShape || url.indexOf("revenue/attribution") !== -1) {
        processAttribution(body, result);
      }

      if (url.indexOf("tax-season-module-data") !== -1) {
        result.shop_info.previous_year_gross_sales =
          body.formattedLegalGrossSalesFromPreviousYear || null;
        result.shop_info.previous_year_sales_count =
          body.formattedSalesCountFromPreviousYear || null;
      } else if (url.indexOf("sanction-resident") !== -1) {
        result.shop_info.legal_name = body.legalName || null;
        result.shop_info.address = body.address || null;
      }

      mergeCampaign(result.campaign, extractCampaignPatch(body));

      hydrateSummaryFromBody(body, result);
      hydrateDateRangeFromUrl(url, result);

      // Best-effort: pull these fields even if endpoint URL changes.
      if (!result.shop_info.legal_name && body.legalName) {
        result.shop_info.legal_name = body.legalName;
      }
      if (!result.shop_info.address && body.address) {
        result.shop_info.address = body.address;
      }
      if (
        Array.isArray(body.trendingQueries) &&
        body.trendingQueries.length > 0
      ) {
        result.trending_queries = body.trendingQueries;
      }
    }

    result.revenue_attribution = dedupeRevenueAttribution(result.revenue_attribution);

    // Convert deduplicated map to sorted array (by spend descending)
    result.listings = Array.from(listingsMap.values()).sort(
      (a, b) => b.stats.spend_cents - a.stats.spend_cents
    );

    fillDerivedSummary(result);

    // Pre-build rows aligned with DB table listing_report
    // We concatenate aggregate rows (if any) and daily rows (if any)
    const aggregateListingRows = buildListingReportRows(result);
    const dailyListingRows = result.listing_daily_rows || [];

    // Deduplicate daily rows just in case
    const dailyDedupeMap = new Map();
    for (const row of dailyListingRows) {
      dailyDedupeMap.set(`${row.listing_id}_${row.period}`, row);
    }
    const deduplicatedDailyRows = Array.from(dailyDedupeMap.values());

    // If we have daily rows for a listing, we might not want the aggregate row for that same listing?
    // Usually, saving both is fine since the period differs ('YYYY/MM/DD-YYYY/MM/DD' vs 'YYYY-MM-DD').
    result.listing_report_rows = [...aggregateListingRows, ...deduplicatedDailyRows];

    // Pre-build rows aligned with DB table keyword_report
    result.keyword_report_rows = buildKeywordReportRows(result);

    // Keep export lean and avoid duplicate row-level data.
    delete result.listings;
    delete result.listing_daily_rows;
    delete result.keywords;

    return result;
  }

  function buildListingReportRows(cleanData, options) {
    const opts = options || {};
    const importer = opts.importer || "getify_json";

    const metadataRange =
      (cleanData.metadata && cleanData.metadata.date_range) || {};
    const shopRange =
      (cleanData.shop_stats && cleanData.shop_stats.date_range) || {};

    const start = metadataRange.start || shopRange.start || null;
    const end = metadataRange.end || shopRange.end || null;

    // listing_report.period is NOT NULL in schema.
    // Required format: YYYY/MM/DD-YYYY/MM/DD
    const startFmt = start ? String(start).replace(/-/g, "/") : null;
    const endFmt = end ? String(end).replace(/-/g, "/") : null;
    const period = startFmt && endFmt ? `${startFmt}-${endFmt}` : "custom_default";

    const rows = [];
    const listings = cleanData.listings || [];
    const importTime = cleanData.metadata && cleanData.metadata.exported_at
      ? cleanData.metadata.exported_at
      : new Date().toISOString();

    const vmName = typeof APP_CONFIG !== 'undefined' ? APP_CONFIG.VM_NAME : null;
    for (const item of listings) {
      const stats = item.stats || {};
      rows.push({
        listing_id: String(item.listing_id || ""),
        title: item.title || "",
        no_vm: vmName,
        price: centsToDecimal(item.price_cents || 0),
        stock: toInt(item.quantity),
        category: item.section || null,
        lifetime_orders: null, // not present in current captured payload
        lifetime_revenue: null, // not present in current captured payload
        period: period,
        views: toInt(stats.impressions != null ? stats.impressions : stats.impression),
        clicks: toInt(stats.clicks != null ? stats.clicks : stats.clickCount),
        orders: toInt(stats.conversions != null ? stats.conversions : stats.orders),
        revenue: centsToDecimal(
          stats.revenue_cents != null ? stats.revenue_cents : stats.revenue
        ),
        spend: centsToDecimal(
          stats.spend_cents != null ? stats.spend_cents : stats.spend
        ),
        roas: toFixedNumber(stats.roas, 2),
        import_time: importTime,
        importer: importer,
      });
    }

    return rows;
  }

  function buildKeywordReportRows(cleanData, options) {
    const opts = options || {};
    const importer = opts.importer || "getify_json";

    const rows = [];
    const keywords = cleanData.keywords || [];
    const importTime = cleanData.metadata && cleanData.metadata.exported_at
      ? cleanData.metadata.exported_at
      : new Date().toISOString();

    const vmName = typeof APP_CONFIG !== 'undefined' ? APP_CONFIG.VM_NAME : null;
    for (const item of keywords) {
      rows.push({
        listing_id: String(item.listing_id || ""),
        keyword: item.keyword || "",
        no_vm: vmName,
        period: item.period || "custom_default",
        roas: toFixedNumber(item.roas, 2),
        orders: toInt(item.orders),
        spend: centsToDecimal(item.spend),
        revenue: centsToDecimal(item.revenue),
        clicks: toInt(item.clicks),
        click_rate: String(item.click_rate || "0"),
        views: toInt(item.views),
        import_time: importTime,
        importer: importer,
        relevant: item.relevant != null ? String(item.relevant) : null,
      });
    }

    return rows;
  }

  function processKeywordStats(body, result, url) {
    const queries = body && (body.queryStats || body.queries);
    if (!queries || !Array.isArray(queries)) return;

    let listingIdStr = "";
    if (body.listing && body.listing.listingId) {
      listingIdStr = String(body.listing.listingId);
    } else if (body.listingId) {
      listingIdStr = String(body.listingId);
    } else {
      // Try to extract from URL if not in body
      const match = url.match(/\/(?:listings|querystats)\/(\d+)/);
      if (match) {
        listingIdStr = match[1];
      }
    }

    let start = body.startDate || null;
    let end = body.endDate || null;
    if (!start) {
      const startMatch = url.match(/[?&]start_date=([^&]+)/);
      if (startMatch) start = decodeURIComponent(startMatch[1]).split(',')[0].trim();
    }
    if (!end) {
      const endMatch = url.match(/[?&]end_date=([^&]+)/);
      if (endMatch) end = decodeURIComponent(endMatch[1]).split(',')[0].trim();
      else if (start) {
        // Fallback to today's date if end date is missing in the URL
        const today = new Date();
        const yyyy = today.getFullYear();
        const mm = String(today.getMonth() + 1).padStart(2, '0');
        const dd = String(today.getDate()).padStart(2, '0');
        end = `${yyyy}/${mm}/${dd}`;
      }
    }

    const startFmt = start ? String(start).replace(/-/g, "/") : null;
    const endFmt = end ? String(end).replace(/-/g, "/") : null;
    const period = startFmt && endFmt ? `${startFmt}-${endFmt}` : "custom_default";

    for (const q of queries) {
      if (!q.stemmedQuery) continue;

      result.keywords.push({
        listing_id: listingIdStr,
        keyword: q.stemmedQuery,
        period: period,
        roas: q.roas || 0,
        orders: q.orderCount || 0,
        spend: q.cost || 0,
        revenue: q.revenue || 0,
        clicks: q.clickCount || 0,
        click_rate: q.clickRate || 0,
        views: q.impressionCounts || 0,
        relevant: q.isRelevant != null ? String(q.isRelevant) : null
      });
    }
  }

  function processListingDailyStats(body, result, url) {
    if (!result.listing_daily_rows) result.listing_daily_rows = [];

    const listing = body.listing;
    const listingIdStr = String(listing.listingId || "");
    const importTime = result.metadata.exported_at || new Date().toISOString();
    const vmName = typeof APP_CONFIG !== "undefined" ? APP_CONFIG.VM_NAME : null;

    for (const stat of body.graphStats) {
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

      result.listing_daily_rows.push({
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
        importer: "getify_json_daily"
      });
    }
  }

  function processEtsyAds(body, result, listingsMap) {
    // Campaign overview
    const campaign = body.campaign || {};
    mergeCampaign(result.campaign, {
      daily_budget:
        campaign.totalDailyBudgetFormatted || campaign.dailyBudgetFormatted || null,
      daily_budget_cents:
        campaign.totalDailyBudget != null
          ? toInt(campaign.totalDailyBudget)
          : campaign.dailyBudget != null
            ? toInt(campaign.dailyBudget)
            : null,
      is_active:
        campaign.isActive != null ? Boolean(campaign.isActive) : null,
      status: campaign.status != null ? toInt(campaign.status) : null,
    });

    // Shop-level aggregate stats
    const shopStats = body.campaignShopStats || {};
    const total = shopStats.totalStats || {};
    result.shop_stats = {
      date_range: {
        start: shopStats.startDate || null,
        end: shopStats.endDate || null,
      },
      impressions: total.impressionCount || 0,
      clicks: total.clickCount || 0,
      click_rate_pct: total.clickRate || 0,
      spend_cents: total.spentTotal || 0,
      spend_formatted: formatCents(total.spentTotal || 0),
      conversions: total.conversions || 0,
      revenue_cents: total.revenue || 0,
      revenue_formatted: formatCents(total.revenue || 0),
      roas: total.roas || 0,
    };

    // Per-listing stats — merge into Map (deduplicates across responses)
    const listingStats = body.campaignListingsStats || {};
    const listingsRaw = listingStats.listings || [];

    result.metadata.date_range = {
      start: listingStats.startDate || null,
      end: listingStats.endDate || null,
    };
    result.metadata.total_promoted_listings =
      listingStats.filteredListingCount || 0;

    for (const item of listingsRaw) {
      const listing = item.listing || {};
      const stats = item.totalStats || {};
      const id = listing.listingId;
      if (!id) continue;

      // Map.set overwrites older entries → latest data wins
      listingsMap.set(id, {
        listing_id: id,
        title: listing.title || "",
        image_url: listing.imageUrlFullxfull || null,
        price_cents: listing.priceInt || 0,
        price_formatted: formatCents(listing.priceInt || 0),
        currency: listing.currencyCode || "USD",
        is_promoted: listing.isPromoted || false,
        section: listing.sectionName || null,
        tags: listing.tags || [],
        quantity: listing.quantity || 0,
        stats: {
          impressions: stats.impressionCount || 0,
          clicks: stats.clickCount || 0,
          click_rate_pct: stats.clickRate || 0,
          spend_cents: stats.spentTotal || 0,
          spend_formatted: formatCents(stats.spentTotal || 0),
          conversions: stats.conversions || 0,
          revenue_cents: stats.revenue || 0,
          revenue_formatted: formatCents(stats.revenue || 0),
          roas: stats.roas || 0,
        },
      });
    }

    // Trending queries
    if (Array.isArray(body.trendingQueries)) {
      result.trending_queries = body.trendingQueries;
    }

    // Shop sections
    const shopSections = listingStats.shopSections || [];
    result.shop_sections = shopSections.map((s) => ({
      id: s.shopSectionId || 0,
      title: s.title || "",
      listing_count: s.activeListingCount || 0,
    }));
  }

  function processProlistStats(body, listingsMap) {
    // /prolist/stats/listings returns listing data when user changes
    // page size (Show 50), sort order, or filters.
    // Auto-detect structure: could be {listings:[...]}, {results:[...]},
    // or the body itself could be an array.
    let listingsRaw = [];

    if (Array.isArray(body)) {
      listingsRaw = body;
    } else if (Array.isArray(body.listings)) {
      listingsRaw = body.listings;
    } else if (Array.isArray(body.results)) {
      listingsRaw = body.results;
    } else {
      // Try all array-valued keys as fallback
      for (const key of Object.keys(body)) {
        if (Array.isArray(body[key]) && body[key].length > 0 &&
          typeof body[key][0] === "object" && body[key][0] !== null) {
          const first = body[key][0];
          // Check if items look like listing objects
          if (first.listing || first.listingId || first.totalStats) {
            listingsRaw = body[key];
            break;
          }
        }
      }
    }

    for (const item of listingsRaw) {
      // Handle both {listing: {...}, totalStats: {...}} and flat structure
      const listing = item.listing || item;
      const stats = item.totalStats || item.stats || {};
      const id = listing.listingId || listing.listing_id;
      if (!id) continue;

      listingsMap.set(id, {
        listing_id: id,
        title: listing.title || "",
        image_url: listing.imageUrlFullxfull || listing.image_url || null,
        price_cents: listing.priceInt || listing.price_cents || 0,
        price_formatted: formatCents(listing.priceInt || listing.price_cents || 0),
        currency: listing.currencyCode || listing.currency || "USD",
        is_promoted: listing.isPromoted != null ? listing.isPromoted : true,
        section: listing.sectionName || listing.section || null,
        tags: listing.tags || [],
        quantity: listing.quantity || 0,
        stats: {
          impressions: stats.impressionCount || stats.impressions || 0,
          clicks: stats.clickCount || stats.clicks || 0,
          click_rate_pct: stats.clickRate || stats.click_rate_pct || 0,
          spend_cents: stats.spentTotal || stats.spend_cents || 0,
          spend_formatted: formatCents(stats.spentTotal || stats.spend_cents || 0),
          conversions: stats.conversions || 0,
          revenue_cents: stats.revenue || stats.revenue_cents || 0,
          revenue_formatted: formatCents(stats.revenue || stats.revenue_cents || 0),
          roas: stats.roas || 0,
        },
      });
    }
  }

  function processAttribution(body, result) {
    const events = body.attributionEvents || [];
    if (!Array.isArray(events)) return;

    for (const event of events) {
      result.revenue_attribution.push({
        listing_id: event.adListingId || event.listingId || null,
        title: event.adListingTitle || event.title || "",
        image_url: event.adListingImageUrl || null,
        purchase_date: event.purchaseDate || null,
        click_date: event.clickDate || null,
        revenue_cents: event.revenue || 0,
        revenue_formatted: event.formattedRevenue || formatCents(event.revenue || 0),
        order_id: event.receiptId || null,
        currency: event.currencyCode || "USD",
        items_purchased: event.numberOfItemsPurchased || 0,
      });
    }
  }

  function hasListingStatsShape(body) {
    if (!body || typeof body !== "object") return false;
    if (Array.isArray(body)) return true;
    if (Array.isArray(body.listings) || Array.isArray(body.results)) return true;
    for (const key of Object.keys(body)) {
      const value = body[key];
      if (
        Array.isArray(value) &&
        value.length > 0 &&
        typeof value[0] === "object" &&
        value[0] !== null
      ) {
        const first = value[0];
        if (first.listing || first.listingId || first.totalStats) {
          return true;
        }
      }
    }
    return false;
  }

  function fillDerivedSummary(result) {
    const listings = result.listings || [];
    if (listings.length === 0) return;

    if (!result.metadata || typeof result.metadata !== "object") {
      result.metadata = {};
    }
    if (!result.metadata.date_range) {
      result.metadata.date_range = { start: null, end: null };
    }
    if (!result.metadata.total_promoted_listings) {
      result.metadata.total_promoted_listings = listings.length;
    }

    if (!result.metadata.date_range.start || !result.metadata.date_range.end) {
      const inferredRange = inferDateRangeFromAttribution(result.revenue_attribution || []);
      if (inferredRange.start && !result.metadata.date_range.start) {
        result.metadata.date_range.start = inferredRange.start;
      }
      if (inferredRange.end && !result.metadata.date_range.end) {
        result.metadata.date_range.end = inferredRange.end;
      }
    }

    if (!result.campaign || Object.keys(result.campaign).length === 0) {
      result.campaign = {
        daily_budget: null,
        daily_budget_cents: null,
        is_active: null,
        status: null,
      };
    }

    // Fill remaining campaign gaps using already available campaign values + shop stats.
    const campaign = result.campaign;
    if (campaign.daily_budget_cents == null && campaign.daily_budget) {
      campaign.daily_budget_cents = parseMoneyToCents(campaign.daily_budget);
    }
    if (campaign.daily_budget == null && campaign.daily_budget_cents != null) {
      campaign.daily_budget = formatCents(toInt(campaign.daily_budget_cents));
    }
    if (campaign.is_active == null && result.shop_stats && toInt(result.shop_stats.spend_cents) > 0) {
      campaign.is_active = true;
    }
    if (campaign.status == null && campaign.is_active != null) {
      campaign.status = campaign.is_active ? 1 : 0;
    }

    if (!result.shop_stats || Object.keys(result.shop_stats).length === 0) {
      let impressions = 0;
      let clicks = 0;
      let spend = 0;
      let conversions = 0;
      let revenue = 0;

      for (const item of listings) {
        const stats = item.stats || {};
        impressions += toInt(stats.impressions);
        clicks += toInt(stats.clicks);
        spend += toInt(stats.spend_cents);
        conversions += toInt(stats.conversions);
        revenue += toInt(stats.revenue_cents);
      }

      const ctr = impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0;
      const roas = spend > 0 ? Number((revenue / spend).toFixed(2)) : 0;
      const start = result.metadata && result.metadata.date_range ? result.metadata.date_range.start : null;
      const end = result.metadata && result.metadata.date_range ? result.metadata.date_range.end : null;

      result.shop_stats = {
        date_range: {
          start: start || null,
          end: end || null,
        },
        impressions: impressions,
        clicks: clicks,
        click_rate_pct: ctr,
        spend_cents: spend,
        spend_formatted: formatCents(spend),
        conversions: conversions,
        revenue_cents: revenue,
        revenue_formatted: formatCents(revenue),
        roas: roas,
      };
    }

    // Keep shop_stats.date_range aligned with metadata when shop stats payload has null range.
    if (result.shop_stats && typeof result.shop_stats === "object") {
      if (!result.shop_stats.date_range) {
        result.shop_stats.date_range = { start: null, end: null };
      }

      const metaStart = result.metadata.date_range.start || null;
      const metaEnd = result.metadata.date_range.end || null;

      if (!result.shop_stats.date_range.start && metaStart) {
        result.shop_stats.date_range.start = metaStart;
      }
      if (!result.shop_stats.date_range.end && metaEnd) {
        result.shop_stats.date_range.end = metaEnd;
      }
    }

    if (!Array.isArray(result.shop_sections) || result.shop_sections.length === 0) {
      const sectionMap = new Map();
      for (const item of listings) {
        const title = (item.section || "No Section").trim() || "No Section";
        sectionMap.set(title, (sectionMap.get(title) || 0) + 1);
      }
      result.shop_sections = Array.from(sectionMap.entries()).map(([title, count]) => ({
        id: 0,
        title: title,
        listing_count: count,
      }));
    }
  }

  function hydrateSummaryFromBody(body, result) {
    mergeCampaign(result.campaign, extractCampaignPatch(body));

    const shopStatsNode = findFirstObject(body, (obj) => {
      return (
        obj &&
        typeof obj === "object" &&
        obj.totalStats &&
        typeof obj.totalStats === "object"
      );
    });

    if (shopStatsNode && (!result.shop_stats || Object.keys(result.shop_stats).length === 0)) {
      const total = shopStatsNode.totalStats || {};
      result.shop_stats = {
        date_range: {
          start: shopStatsNode.startDate || null,
          end: shopStatsNode.endDate || null,
        },
        impressions: toInt(total.impressionCount),
        clicks: toInt(total.clickCount),
        click_rate_pct: toNumber(total.clickRate),
        spend_cents: toInt(total.spentTotal),
        spend_formatted: formatCents(toInt(total.spentTotal)),
        conversions: toInt(total.conversions),
        revenue_cents: toInt(total.revenue),
        revenue_formatted: formatCents(toInt(total.revenue)),
        roas: toFixedNumber(total.roas, 2),
      };
    }

    const listingStatsNode = findFirstObject(body, (obj) => {
      return (
        obj &&
        typeof obj === "object" &&
        Array.isArray(obj.listings) &&
        (
          Object.prototype.hasOwnProperty.call(obj, "startDate") ||
          Object.prototype.hasOwnProperty.call(obj, "endDate") ||
          Object.prototype.hasOwnProperty.call(obj, "filteredListingCount")
        )
      );
    });

    if (listingStatsNode) {
      const start = listingStatsNode.startDate || null;
      const end = listingStatsNode.endDate || null;
      if (start && !result.metadata.date_range.start) {
        result.metadata.date_range.start = start;
      }
      if (end && !result.metadata.date_range.end) {
        result.metadata.date_range.end = end;
      }
      if (
        listingStatsNode.filteredListingCount != null &&
        !result.metadata.total_promoted_listings
      ) {
        result.metadata.total_promoted_listings = toInt(
          listingStatsNode.filteredListingCount
        );
      }
    }
  }

  function extractCampaignPatch(body) {
    const campaignNode = findFirstObject(body, (obj) => {
      return (
        obj &&
        typeof obj === "object" &&
        (
          Object.prototype.hasOwnProperty.call(obj, "totalDailyBudget") ||
          Object.prototype.hasOwnProperty.call(obj, "totalDailyBudgetFormatted") ||
          Object.prototype.hasOwnProperty.call(obj, "dailyBudget") ||
          Object.prototype.hasOwnProperty.call(obj, "daily_budget") ||
          Object.prototype.hasOwnProperty.call(obj, "budget") ||
          Object.prototype.hasOwnProperty.call(obj, "isActive") ||
          Object.prototype.hasOwnProperty.call(obj, "is_active") ||
          Object.prototype.hasOwnProperty.call(obj, "status")
        )
      );
    });

    if (!campaignNode) {
      return {
        daily_budget: null,
        daily_budget_cents: null,
        is_active: null,
        status: null,
      };
    }

    const formattedBudget =
      campaignNode.totalDailyBudgetFormatted ||
      campaignNode.dailyBudgetFormatted ||
      campaignNode.daily_budget_formatted ||
      null;

    const budgetCentsRaw =
      campaignNode.totalDailyBudget != null
        ? campaignNode.totalDailyBudget
        : campaignNode.dailyBudget != null
          ? campaignNode.dailyBudget
          : campaignNode.daily_budget != null
            ? campaignNode.daily_budget
            : campaignNode.budget != null
              ? campaignNode.budget
              : null;

    const isActiveRaw =
      campaignNode.isActive != null
        ? campaignNode.isActive
        : campaignNode.is_active != null
          ? campaignNode.is_active
          : null;

    return {
      daily_budget: formattedBudget,
      daily_budget_cents:
        budgetCentsRaw != null
          ? typeof budgetCentsRaw === "string"
            ? parseMoneyToCents(budgetCentsRaw)
            : toInt(budgetCentsRaw)
          : null,
      is_active: isActiveRaw != null ? Boolean(isActiveRaw) : null,
      status:
        campaignNode.status != null ? toInt(campaignNode.status) : null,
    };
  }

  function mergeCampaign(target, patch) {
    if (!target || typeof target !== "object") return;
    if (!patch || typeof patch !== "object") return;

    if (!Object.prototype.hasOwnProperty.call(target, "daily_budget")) {
      target.daily_budget = null;
    }
    if (!Object.prototype.hasOwnProperty.call(target, "daily_budget_cents")) {
      target.daily_budget_cents = null;
    }
    if (!Object.prototype.hasOwnProperty.call(target, "is_active")) {
      target.is_active = null;
    }
    if (!Object.prototype.hasOwnProperty.call(target, "status")) {
      target.status = null;
    }

    if (target.daily_budget == null && patch.daily_budget != null) {
      target.daily_budget = patch.daily_budget;
    }
    if (target.daily_budget_cents == null && patch.daily_budget_cents != null) {
      target.daily_budget_cents = patch.daily_budget_cents;
    }
    if (target.is_active == null && patch.is_active != null) {
      target.is_active = patch.is_active;
    }
    if (target.status == null && patch.status != null) {
      target.status = patch.status;
    }
  }

  function parseMoneyToCents(value) {
    if (value == null) return null;
    const raw = String(value).trim();
    if (!raw) return null;

    // Handle "$50.00", "50", "50.5", and "5000" (already cents-like integer).
    const cleaned = raw.replace(/[^0-9.,-]/g, "").replace(/,/g, "");
    if (!cleaned) return null;

    const num = Number(cleaned);
    if (!Number.isFinite(num)) return null;

    if (num > 1000 && cleaned.indexOf(".") === -1) {
      return Math.trunc(num);
    }

    return Math.round(num * 100);
  }

  function hydrateDateRangeFromUrl(url, result) {
    if (!url || typeof url !== "string") return;
    if (
      result.metadata &&
      result.metadata.date_range &&
      result.metadata.date_range.start &&
      result.metadata.date_range.end
    ) {
      return;
    }

    try {
      const parsed = new URL(url, "https://www.etsy.com");
      const start =
        parsed.searchParams.get("start_date") ||
        parsed.searchParams.get("startDate") ||
        parsed.searchParams.get("from") ||
        parsed.searchParams.get("start");
      const end =
        parsed.searchParams.get("end_date") ||
        parsed.searchParams.get("endDate") ||
        parsed.searchParams.get("to") ||
        parsed.searchParams.get("end");

      const startIso = toIsoDateOnly(start);
      const endIso = toIsoDateOnly(end);

      if (!result.metadata.date_range) {
        result.metadata.date_range = { start: null, end: null };
      }
      if (startIso && !result.metadata.date_range.start) {
        result.metadata.date_range.start = startIso;
      }
      if (endIso && !result.metadata.date_range.end) {
        result.metadata.date_range.end = endIso;
      }
    } catch (e) {
      // Ignore malformed URLs
    }
  }

  function dedupeRevenueAttribution(events) {
    const list = Array.isArray(events) ? events : [];
    const seen = new Set();
    const deduped = [];

    for (const event of list) {
      const key = [
        event.order_id || "",
        event.listing_id || "",
        event.purchase_date || "",
        event.click_date || "",
        event.revenue_cents || 0,
      ].join("|");

      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(event);
    }

    return deduped;
  }

  function inferDateRangeFromAttribution(events) {
    let min = null;
    let max = null;

    for (const event of events) {
      const purchase = toDate(event.purchase_date);
      const click = toDate(event.click_date);
      const candidates = [purchase, click].filter(Boolean);

      for (const d of candidates) {
        if (!min || d < min) min = d;
        if (!max || d > max) max = d;
      }
    }

    return {
      start: min ? toIsoDateOnly(min.toISOString()) : null,
      end: max ? toIsoDateOnly(max.toISOString()) : null,
    };
  }

  function toDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function toIsoDateOnly(value) {
    if (!value) return null;
    const str = String(value);
    const iso = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

    const d = new Date(str);
    if (Number.isNaN(d.getTime())) return null;

    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function findFirstObject(value, predicate) {
    if (!value || typeof value !== "object") return null;
    if (predicate(value)) return value;

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findFirstObject(item, predicate);
        if (found) return found;
      }
      return null;
    }

    for (const key of Object.keys(value)) {
      const found = findFirstObject(value[key], predicate);
      if (found) return found;
    }

    return null;
  }

  function formatCents(cents) {
    if (typeof cents !== "number") return "$0.00";
    return "$" + (cents / 100).toFixed(2);
  }

  function centsToDecimal(cents) {
    return Number((Number(cents || 0) / 100).toFixed(2));
  }

  function toInt(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }

  function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function toFixedNumber(value, digits) {
    const n = toNumber(value);
    return Number(n.toFixed(digits));
  }

  // =====================================================================
  // PAGE CONTEXT — show only relevant controls per page type
  // =====================================================================

  function detectPageType(url) {
    if (!url || !url.includes("etsy.com")) return "other";
    if (/\/advertising\/listings\/\d+/.test(url)) return "keywords";
    if (/\/advertising/.test(url)) return "dashboard";
    return "etsy_other";
  }

  function hasKeywordData() {
    return allSessions.some((s) => {
      const b = s.body;
      return (
        b &&
        typeof b === "object" &&
        ((Array.isArray(b.queryStats) && b.queryStats.length > 0) ||
          (Array.isArray(b.queries) && b.queries.length > 0))
      );
    });
  }

  function show(el) { if (el) el.style.display = ""; }
  function hide(el) { if (el) el.style.display = "none"; }
  function showIf(el, cond) { cond ? show(el) : hide(el); }

  function applyPageContext(pageType) {
    const isDashboard = pageType === "dashboard";
    const isKeywords = pageType === "keywords";
    const hasData = allSessions.length > 0;
    const hasKwData = hasKeywordData();
    const hasQueue = keywordQueue.length > 0;

    // --- Top action buttons ---
    // Dashboard: only show Add Listings to DB as the primary action.
    // Queue and bot panels reveal themselves after a successful insert.
    showIf(btnExportClean, hasData && !isDashboard);
    showIf(btnExport, hasData && !isKeywords && !isDashboard);
    showIf(btnExportCsv, hasData && isDashboard && hasQueue);
    showIf(btnAddDb, hasData && isDashboard);
    showIf(btnAddDbKeywords, isKeywords && hasKwData);
    showIf(btnClear, hasData && !isDashboard);
    // Settings button always visible

    // --- Keyword Queue panel ---
    // Only shown once the queue has been populated (after Add Listings to DB).
    const queuePanel = document.getElementById("queue-panel");
    showIf(queuePanel, hasQueue);

    // Inside queue panel: context-specific controls
    showIf(btnRefreshQueue, isDashboard);
    showIf(document.getElementById("queue-template-row"), isDashboard);
    showIf(document.getElementById("queue-actions-row"), isDashboard);

    // --- Bot panel ---
    // Only shown once the queue exists or the bot is already running.
    const botPanelEl = document.getElementById("bot-panel");
    showIf(botPanelEl, hasQueue || botRunning);

    // --- Page badge ---
    const badge = document.getElementById("page-badge");
    if (badge) {
      const MAP = {
        dashboard: ["Ads Dashboard", "dashboard"],
        keywords: ["Keyword Stats", "keywords"],
        etsy_other: ["Etsy", "etsy"],
        other: ["Outside Etsy", "other"],
      };
      const [label, cls] = MAP[pageType] || ["Unknown", "other"];
      badge.textContent = label;
      badge.className = "page-badge " + cls;
      show(badge);
    }

    // --- Contextual db-status hint when no data ---
    if (!hasData) {
      if (isDashboard) {
        setDbStatus("On the Ads Dashboard — scroll the listing table to capture data.", "info");
      } else if (isKeywords) {
        setDbStatus("Keyword page detected — waiting for API data to load.", "info");
      } else {
        setDbStatus("Navigate to your Etsy Ads Dashboard to capture listing data.", "info");
      }
    }
  }

  function initPageContext(cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const url = (tabs && tabs[0] && tabs[0].url) || "";
      currentPageType = detectPageType(url);
      applyPageContext(currentPageType);
      if (cb) cb();
    });
  }

  // =====================================================================
  // MANUAL KEYWORD QUEUE
  // =====================================================================

  function buildKeywordQueueFromSessions() {
    const cleanData = transformToClean(allSessions);
    const rows = cleanData.listing_report_rows || [];
    const existingById = new Map(keywordQueue.map((item) => [String(item.listing_id), item]));
    const capturedIds = getCapturedKeywordListingIds();
    const nextQueue = [];
    const seen = new Set();

    for (const row of rows) {
      const listingId = String(row.listing_id || "").trim();
      if (!listingId || seen.has(listingId)) continue;
      seen.add(listingId);

      const existing = existingById.get(listingId) || {};
      const captured = capturedIds.has(listingId);
      nextQueue.push({
        listing_id: listingId,
        title: row.title || existing.title || "",
        status: captured ? "done" : existing.status || "pending",
        opened_at: existing.opened_at || null,
        captured_at: captured ? existing.captured_at || new Date().toISOString() : existing.captured_at || null,
      });
    }

    keywordQueue = nextQueue;
    saveKeywordQueue();
    renderKeywordQueue();
  }

  function syncCapturedKeywordStatuses() {
    if (!Array.isArray(keywordQueue) || keywordQueue.length === 0) return;

    const capturedIds = getCapturedKeywordListingIds();
    let changed = false;
    for (const item of keywordQueue) {
      const listingId = String(item.listing_id || "");
      if (capturedIds.has(listingId) && item.status !== "done") {
        item.status = "done";
        item.captured_at = new Date().toISOString();
        changed = true;
      }
    }

    if (changed) {
      saveKeywordQueue();
    }
  }

  function getCapturedKeywordListingIds() {
    const ids = new Set();

    for (const entry of allSessions) {
      const url = entry.url || "";
      const body = entry.body;
      const hasKeywordStats =
        (body && typeof body === "object" && Array.isArray(body.queryStats)) ||
        url.indexOf("querystats") !== -1;

      if (!hasKeywordStats) continue;

      if (body && body.listingId) {
        ids.add(String(body.listingId));
        continue;
      }

      if (body && body.listing && body.listing.listingId) {
        ids.add(String(body.listing.listingId));
        continue;
      }

      const match = url.match(/\/querystats\/(\d+)/);
      if (match) {
        ids.add(match[1]);
      }
    }

    return ids;
  }

  function renderKeywordQueue() {
    const total = keywordQueue.length;
    const done = keywordQueue.filter((item) => item.status === "done").length;
    const opened = keywordQueue.filter((item) => item.status === "opened").length;
    const pending = total - done - opened;

    if (total === 0) {
      queueSummary.textContent = "No queue yet. Capture listings, then click Refresh.";
    } else {
      queueSummary.textContent = `${done}/${total} done, ${opened} opened, ${pending} pending.`;
    }

    btnOpenNextKeyword.disabled = total === 0 || !!getCurrentKeywordItem() || !getNextKeywordItem();
    btnMarkKeywordDone.disabled = !getCurrentKeywordItem();
    btnResetKeywordQueue.disabled = total === 0;

    keywordQueueList.innerHTML = "";
    const visibleItems = keywordQueue.slice(0, 8);
    for (const item of visibleItems) {
      const row = document.createElement("div");
      row.className = "queue-item";
      row.innerHTML = `
        <div class="queue-id">${escapeHtml(String(item.listing_id || ""))}</div>
        <div class="queue-name">${escapeHtml(item.title || "Untitled listing")}</div>
        <div class="queue-status ${escapeHtml(item.status || "pending")}">${escapeHtml(item.status || "pending")}</div>
      `;
      keywordQueueList.appendChild(row);
    }

    if (keywordQueue.length > visibleItems.length) {
      const more = document.createElement("div");
      more.className = "queue-item";
      more.innerHTML = `
        <div class="queue-id">...</div>
        <div class="queue-name">${keywordQueue.length - visibleItems.length} more listings</div>
        <div class="queue-status"></div>
      `;
      keywordQueueList.appendChild(more);
    }
  }

  function getNextKeywordItem() {
    return keywordQueue.find((item) => item.status === "pending" || !item.status);
  }

  function getCurrentKeywordItem() {
    return keywordQueue.find((item) => item.status === "opened");
  }

  function openNextKeywordListing() {
    const item = getNextKeywordItem();
    if (!item) return;

    const template = getKeywordUrlTemplate();
    if (template.indexOf("{listing_id}") === -1) {
      setDbStatus("Keyword URL template must include {listing_id}.", "error");
      inputKeywordUrlTemplate.focus();
      return;
    }

    item.status = "opened";
    item.opened_at = new Date().toISOString();
    saveKeywordQueue();
    renderKeywordQueue();

    const url = template.replace(/\{listing_id\}/g, encodeURIComponent(item.listing_id));
    window.open(url, "_blank", "noopener");
  }

  function markCurrentKeywordDone() {
    const item = getCurrentKeywordItem();
    if (!item) return;

    item.status = "done";
    item.captured_at = new Date().toISOString();
    saveKeywordQueue();
    renderKeywordQueue();
  }

  function resetKeywordQueue() {
    if (!confirm("Reset keyword queue progress? Captured API data will stay in storage.")) return;
    keywordQueue = [];
    saveKeywordQueue();
    renderKeywordQueue();
  }

  function saveKeywordQueue() {
    chrome.runtime.sendMessage({ action: "QUEUE_SAVE", queue: keywordQueue });
  }

  function getKeywordUrlTemplate() {
    const value = inputKeywordUrlTemplate.value.trim();
    return value || DEFAULT_KEYWORD_URL_TEMPLATE;
  }

  function loadKeywordUrlTemplate() {
    chrome.storage.local.get(KEYWORD_TEMPLATE_STORAGE_KEY, (result) => {
      inputKeywordUrlTemplate.value =
        result[KEYWORD_TEMPLATE_STORAGE_KEY] || DEFAULT_KEYWORD_URL_TEMPLATE;
    });
  }

  function saveKeywordUrlTemplate() {
    chrome.storage.local.set({ [KEYWORD_TEMPLATE_STORAGE_KEY]: getKeywordUrlTemplate() });
  }

  // --- EXPORT CLEAN JSON ---

  btnExportClean.addEventListener("click", () => {
    if (allSessions.length === 0) return;

    const cleanData = transformToClean(allSessions);
    const blob = new Blob([JSON.stringify(cleanData, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

    const a = document.createElement("a");
    a.href = url;
    a.download = `etsy-ads-clean-${ts}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // --- EXPORT RAW JSON ---

  btnExport.addEventListener("click", () => {
    if (allSessions.length === 0) return;

    const blob = new Blob([JSON.stringify(allSessions, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

    const a = document.createElement("a");
    a.href = url;
    a.download = `getify-ads-export-${ts}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // --- EXPORT CSV ---

  btnExportCsv.addEventListener("click", () => {
    if (allSessions.length === 0) return;

    const cleanData = transformToClean(allSessions);
    const rows = cleanData.listing_report_rows || [];
    if (rows.length === 0) return;

    const headers = [
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

    const csvRows = rows.map((r) => {
      return headers
        .map((key) => csvCell(r[key]))
        .join(",");
    });

    const csv = [headers.join(","), ...csvRows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

    const a = document.createElement("a");
    a.href = url;
    a.download = `listing_report-${ts}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // --- ADD TO DB (Direct Neon HTTP SQL — no local relay) ---

  btnAddDb.addEventListener("click", async () => {
    if (allSessions.length === 0) return;

    const cleanData = transformToClean(allSessions);
    const rows = cleanData.listing_report_rows || [];

    if (rows.length === 0) {
      setDbStatus("No listing_report_rows found to insert.", "error");
      return;
    }

    // Get connection string from storage
    const config = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "GET_DB_CONFIG" }, resolve);
    });

    const connStr = config && config.connectionString ? config.connectionString : "";
    if (!connStr) {
      setDbStatus(
        "No connection string configured. Click Settings to add your Neon connection string.",
        "error"
      );
      // Auto-open settings panel
      settingsBody.classList.add("visible");
      settingsArrow.classList.add("open");
      return;
    }

    const originalLabel = btnAddDb.textContent;
    btnAddDb.disabled = true;
    btnAddDb.textContent = "Adding to DB...";
    setDbStatus(`Sending ${rows.length} rows to Neon database...`, "info");

    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { action: "INSERT_TO_DB", rows: rows, connectionString: connStr },
          resolve
        );
      });

      if (!response || !response.ok) {
        throw new Error(
          response && response.error ? response.error : "Insert failed"
        );
      }

      const inserted = response.inserted || 0;
      const statusMsg = response.message
        ? response.message
        : `Inserted ${inserted} rows into listing_report.`;
      setDbStatus(statusMsg, "success");

      // Auto-build keyword queue from the captured sessions so the
      // queue panel and bot panel appear immediately after insert.
      buildKeywordQueueFromSessions();
      applyPageContext(currentPageType);
    } catch (error) {
      setDbStatus(
        "Database insert failed: " +
        String(error && error.message ? error.message : error),
        "error"
      );
    } finally {
      btnAddDb.textContent = originalLabel;
      btnAddDb.disabled = allSessions.length === 0;
    }
  });

  // --- ADD KEYWORDS TO DB ---
  btnAddDbKeywords.addEventListener("click", async () => {
    if (allSessions.length === 0) return;

    const cleanData = transformToClean(allSessions);
    const rows = cleanData.keyword_report_rows || [];

    if (rows.length === 0) {
      setDbStatus("No keyword_report_rows found to insert.", "error");
      return;
    }

    // Get connection string from storage
    const config = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "GET_DB_CONFIG" }, resolve);
    });

    const connStr = config && config.connectionString ? config.connectionString : "";
    if (!connStr) {
      setDbStatus(
        "No connection string configured. Click Settings to add your Neon connection string.",
        "error"
      );
      settingsBody.classList.add("visible");
      settingsArrow.classList.add("open");
      return;
    }

    const originalLabel = btnAddDbKeywords.textContent;
    btnAddDbKeywords.disabled = true;
    btnAddDbKeywords.textContent = "Adding Keywords...";
    setDbStatus(`Sending ${rows.length} keyword rows to Neon database...`, "info");

    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { action: "INSERT_KEYWORDS_TO_DB", rows: rows, connectionString: connStr },
          resolve
        );
      });

      if (!response || !response.ok) {
        throw new Error(
          response && response.error ? response.error : "Insert failed"
        );
      }

      const inserted = response.inserted || 0;
      const statusMsg = response.message
        ? response.message
        : `Inserted ${inserted} rows into keyword_report.`;
      setDbStatus(statusMsg, "success");
    } catch (error) {
      setDbStatus(String(error && error.message ? error.message : error), "error");
    } finally {
      btnAddDbKeywords.textContent = originalLabel;
      btnAddDbKeywords.disabled = allSessions.length === 0;
    }
  });

  // --- CLEAR ---

  btnClear.addEventListener("click", () => {
    if (!confirm("Delete all captured data? This cannot be undone.")) return;

    chrome.runtime.sendMessage({ action: "CLEAR_ALL" }, () => {
      allSessions = [];
      renderSessions();
      updateStats();
    });
  });

  // --- HELPERS ---

  function shortenUrl(url) {
    try {
      const u = new URL(url, "https://www.etsy.com");
      return u.pathname + u.search;
    } catch (e) {
      // Relative URL
      return url.length > 80 ? url.substring(0, 80) + "..." : url;
    }
  }

  function formatTime(isoString) {
    try {
      const d = new Date(isoString);
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch (e) {
      return "??:??";
    }
  }

  function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function csvCell(value) {
    if (value == null) return "";
    const str = String(value);
    return `"${str.replace(/"/g, '""')}"`;
  }

  function setDbStatus(message, type) {
    dbStatus.textContent = message;
    dbStatus.classList.remove("success", "error");
    if (type === "success") {
      dbStatus.classList.add("success");
    } else if (type === "error") {
      dbStatus.classList.add("error");
    }
  }

  // =====================================================================
  // SETTINGS PANEL
  // =====================================================================

  // Toggle settings panel
  settingsToggle.addEventListener("click", () => {
    const isOpen = settingsBody.classList.contains("visible");
    settingsBody.classList.toggle("visible");
    settingsArrow.classList.toggle("open");
  });

  // Settings button in controls bar
  btnSettings.addEventListener("click", () => {
    const isOpen = settingsBody.classList.contains("visible");
    settingsBody.classList.toggle("visible");
    settingsArrow.classList.toggle("open");
    if (!isOpen) {
      inputConnString.focus();
    }
  });

  // Toggle connection string visibility
  btnToggleVisibility.addEventListener("click", () => {
    if (inputConnString.type === "password") {
      inputConnString.type = "text";
      btnToggleVisibility.textContent = "Hide";
    } else {
      inputConnString.type = "password";
      btnToggleVisibility.textContent = "👁️";
    }
  });

  // Save connection string
  btnSaveConfig.addEventListener("click", () => {
    const connStr = inputConnString.value.trim();
    if (!connStr) {
      setSettingsStatus("Connection string cannot be empty.", "error");
      return;
    }

    if (!connStr.startsWith("postgres")) {
      setSettingsStatus("Must start with postgresql:// or postgres://", "error");
      return;
    }

    chrome.runtime.sendMessage(
      { action: "SAVE_DB_CONFIG", data: { connectionString: connStr } },
      (response) => {
        if (response && response.ok) {
          setSettingsStatus("Connection string saved.", "success");
          setDbStatus("Ready to insert listing_report_rows.", "info");
        } else {
          setSettingsStatus(
            "Failed to save: " + (response && response.error ? response.error : "unknown error"),
            "error"
          );
        }
      }
    );
  });

  // Test connection
  btnTestConn.addEventListener("click", () => {
    const connStr = inputConnString.value.trim();
    if (!connStr) {
      setSettingsStatus("Enter a connection string first.", "error");
      return;
    }

    btnTestConn.disabled = true;
    btnTestConn.textContent = "Testing...";
    setSettingsStatus("Connecting to Neon...", "info");

    chrome.runtime.sendMessage(
      { action: "TEST_DB_CONNECTION", connectionString: connStr },
      (response) => {
        btnTestConn.disabled = false;
        btnTestConn.textContent = "Test Connection";

        if (response && response.ok) {
          setSettingsStatus("Connected to Neon successfully.", "success");
        } else {
          setSettingsStatus(
            "Connection failed: " +
            (response && response.error ? response.error : "unknown error"),
            "error"
          );
        }
      }
    );
  });

  function setSettingsStatus(message, type) {
    settingsStatus.textContent = message;
    settingsStatus.classList.remove("success", "error", "info");
    settingsStatus.classList.add("visible");
    if (type) {
      settingsStatus.classList.add(type);
    }
  }

  // =====================================================================
  // KEYWORD QUEUE EVENTS
  // =====================================================================

  btnRefreshQueue.addEventListener("click", () => {
    if (allSessions.length === 0) {
      setDbStatus("Capture listing data first, then refresh the keyword queue.", "error");
      return;
    }

    buildKeywordQueueFromSessions();
    setDbStatus("Keyword queue refreshed from captured listings.", "success");
  });

  btnOpenNextKeyword.addEventListener("click", () => {
    saveKeywordUrlTemplate();
    openNextKeywordListing();
  });

  btnMarkKeywordDone.addEventListener("click", () => {
    markCurrentKeywordDone();
  });

  btnResetKeywordQueue.addEventListener("click", () => {
    resetKeywordQueue();
  });

  inputKeywordUrlTemplate.addEventListener("change", () => {
    saveKeywordUrlTemplate();
  });

  // Load saved connection string on popup open
  function loadDbConfig() {
    chrome.runtime.sendMessage({ action: "GET_DB_CONFIG" }, (response) => {
      if (response && response.connectionString) {
        inputConnString.value = response.connectionString;
      }
    });
  }

  // =====================================================================
  // BOT UI
  // =====================================================================

  const btnBotToggle = document.getElementById("btn-bot-toggle");
  const botStatusText = document.getElementById("bot-status-text");
  const botProgressEl = document.getElementById("bot-progress");
  const botCurrentEl = document.getElementById("bot-current");
  const botProgressFill = document.getElementById("bot-progress-fill");
  const botCompletePanel = document.getElementById("bot-complete-panel");
  const errorPromptPanel = document.getElementById("error-prompt-panel");
  const errorPromptMsg = document.getElementById("error-prompt-msg");
  const btnBotRetry = document.getElementById("btn-bot-retry");
  const btnBotNext = document.getElementById("btn-bot-next");

  function showErrorPrompt(listingId, errorText) {
    errorPromptMsg.textContent = `Listing ${listingId}: ${errorText}`;
    errorPromptPanel.style.display = "block";
    botCompletePanel.style.display = "none";
  }

  function hideErrorPrompt() {
    errorPromptPanel.style.display = "none";
  }

  let breakTickerId = null;
  let lastBotState = null;

  function stopBreakTicker() {
    if (breakTickerId != null) {
      clearInterval(breakTickerId);
      breakTickerId = null;
    }
  }

  function formatBreakRemaining(breakUntil) {
    const ms = Math.max(0, breakUntil - Date.now());
    const totalSec = Math.ceil(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function renderRunningLabel(state) {
    if (state.state === "break" && state.breakUntil) {
      const remaining = formatBreakRemaining(state.breakUntil);
      botStatusText.textContent = `Running… (break — ${remaining} left)`;
      return;
    }
    botStatusText.textContent = state.listingId
      ? `Running… listing ${state.listingId} (${state.state})`
      : `Running… (${state.state})`;
  }

  function updateBotUI(state) {
    botRunning = state.active;
    lastBotState = state;

    if (state.state === "waiting_user") {
      stopBreakTicker();
      btnBotToggle.textContent = "Stop Bot";
      btnBotToggle.className = "btn btn-bot-stop";
      botStatusText.textContent = `Paused — save error on listing ${state.listingId}`;
      botStatusText.className = "bot-status-text error";
      botProgressEl.style.display = "block";
      showErrorPrompt(state.listingId, state.errorMsg || "Unknown error");
      return;
    }

    hideErrorPrompt();

    if (state.active) {
      btnBotToggle.textContent = "Stop Bot";
      btnBotToggle.className = "btn btn-bot-stop";
      renderRunningLabel(state);
      botStatusText.className = "bot-status-text running";
      botProgressEl.style.display = "block";
      botCompletePanel.style.display = "none";

      if (state.state === "break" && state.breakUntil) {
        if (breakTickerId == null) {
          breakTickerId = setInterval(() => {
            if (!lastBotState || lastBotState.state !== "break" || !lastBotState.breakUntil) {
              stopBreakTicker();
              return;
            }
            renderRunningLabel(lastBotState);
            if (Date.now() >= lastBotState.breakUntil) {
              stopBreakTicker();
            }
          }, 1000);
        }
      } else {
        stopBreakTicker();
      }
    } else if (state.state === "complete") {
      stopBreakTicker();
      btnBotToggle.textContent = "Start Bot";
      btnBotToggle.className = "btn btn-bot-start";
      botStatusText.textContent = "All listings processed";
      botStatusText.className = "bot-status-text complete";
      botProgressEl.style.display = "none";
      botCompletePanel.style.display = "block";
    } else {
      stopBreakTicker();
      btnBotToggle.textContent = "Start Bot";
      btnBotToggle.className = "btn btn-bot-start";
      botStatusText.textContent = "Idle — click Start to run automatically";
      botStatusText.className = "bot-status-text";
      botProgressEl.style.display = "none";
      botCompletePanel.style.display = "none";
    }
  }

  function refreshBotProgress() {
    const total = keywordQueue.length;
    const done = keywordQueue.filter((q) => q.status === "done").length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    botProgressFill.style.width = pct + "%";
  }

  btnBotToggle.addEventListener("click", () => {
    if (botRunning) {
      chrome.runtime.sendMessage({ action: "BOT_STOP" });
      updateBotUI({ active: false, state: "idle", listingId: null });
      return;
    }

    const template = getKeywordUrlTemplate();
    if (!template.includes("{listing_id}")) {
      setDbStatus("Set the Keyword URL Template with {listing_id} first.", "error");
      return;
    }
    const pending = keywordQueue.filter(
      (q) => !q.status || q.status === "pending" || q.status === "error"
    );
    if (pending.length === 0) {
      setDbStatus("No pending listings. Click Refresh to build the queue first.", "error");
      return;
    }

    saveKeywordUrlTemplate();
    chrome.runtime.sendMessage({ action: "BOT_START", urlTemplate: template });
    updateBotUI({ active: true, state: "opening", listingId: null });
  });

  btnBotRetry.addEventListener("click", () => {
    hideErrorPrompt();
    chrome.runtime.sendMessage({ action: "BOT_RESUME", decision: "retry" });
    botStatusText.textContent = "Retrying…";
    botStatusText.className = "bot-status-text running";
  });

  btnBotNext.addEventListener("click", () => {
    hideErrorPrompt();
    chrome.runtime.sendMessage({ action: "BOT_RESUME", decision: "next" });
    botStatusText.textContent = "Skipping — moving to next listing…";
    botStatusText.className = "bot-status-text running";
  });

  function parseListingIds(raw) {
    return raw
      .split(/[\n,\s]+/)
      .map((s) => {
        s = s.trim();
        const urlMatch = s.match(/\/listings\/(\d+)/);
        if (urlMatch) return urlMatch[1];
        if (/^\d{6,12}$/.test(s)) return s;
        return null;
      })
      .filter(Boolean);
  }

  // --- Receive live updates from the background bot ---
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "BOT_STATUS_UPDATE") {
      updateBotUI(message.bot || {});
      chrome.runtime.sendMessage({ action: "QUEUE_GET" }, (r) => {
        keywordQueue = (r && r.queue) || keywordQueue;
        renderKeywordQueue();
        refreshBotProgress();
        if (message.bot && message.bot.listingId) {
          botCurrentEl.textContent = `Listing ${message.bot.listingId}`;
        }
      });
    } else if (message.action === "BOT_COMPLETE") {
      updateBotUI({ active: false, state: "complete", listingId: null });
      setDbStatus(
        `Bot complete — ${message.done}/${message.total} listings saved.`,
        "success"
      );
      chrome.runtime.sendMessage({ action: "QUEUE_GET" }, (r) => {
        keywordQueue = (r && r.queue) || keywordQueue;
        renderKeywordQueue();
        refreshBotProgress();
      });
    } else if (message.action === "BOT_LISTING_SAVED") {
      let msg;
      let statusKind = "success";
      let badge = "saved";
      if (message.ok) {
        const parts = [];
        if (message.keywordRows > 0) parts.push(`${message.keywordRows} keywords`);
        if (message.listingRows > 0) parts.push(`${message.listingRows} daily rows`);
        if (parts.length === 0) {
          // Distinguish between "captured nothing" and "captured keywords but
          // listing not yet in listing_report" so the user can act on each.
          if (message.fkSkip) {
            msg = `Skipped listing ${message.listingId} — captured ${message.capturedKeywords} keywords but listing not yet in listing_report (run "Add Listings to DB" first)`;
          } else if (message.capturedKeywords > 0 || message.capturedListings > 0) {
            msg = `Skipped listing ${message.listingId} — captured ${message.capturedKeywords} kw / ${message.capturedListings} daily but nothing was saved`;
          } else {
            msg = `Skipped listing ${message.listingId} — no data captured`;
          }
          statusKind = "info";
          badge = "skipped";
        } else {
          msg = `Saved ${parts.join(" + ")} for listing ${message.listingId}`;
        }
      } else {
        msg = `Error on listing ${message.listingId}: ${message.message}`;
        statusKind = "error";
        badge = "error";
      }
      setDbStatus(msg, statusKind);
      botCurrentEl.textContent = `Listing ${message.listingId} — ${badge}`;
      refreshBotProgress();
    } else if (message.action === "BOT_ERROR") {
      setDbStatus("Bot error: " + message.error, "error");
      updateBotUI({ active: false, state: "idle", listingId: null });
    } else if (message.action === "BOT_ERROR_PROMPT") {
      showErrorPrompt(message.listingId, message.error);
      botRunning = true;
      btnBotToggle.textContent = "Stop Bot";
      btnBotToggle.className = "btn btn-bot-stop";
      botStatusText.textContent = `Paused — save error on listing ${message.listingId}`;
      botStatusText.className = "bot-status-text error";
      setDbStatus("Save failed: " + message.error, "error");
    }
  });

  function loadBotStatus() {
    chrome.runtime.sendMessage({ action: "BOT_STATUS" }, (res) => {
      if (!res || !res.bot) return;
      updateBotUI(res.bot);
      if (res.bot.state === "waiting_user") {
        setDbStatus("Save failed: " + (res.bot.errorMsg || "Unknown error"), "error");
      }
    });
  }

  // --- INIT ---
  // Detect page type first so applyPageContext has the correct value
  // when loadData renders sessions — avoids a double-render with "other" type.
  loadKeywordUrlTemplate();
  loadDbConfig();
  loadBotStatus();
  chrome.runtime.sendMessage({ action: "QUEUE_GET" }, (r) => {
    keywordQueue = (r && r.queue) || [];
    renderKeywordQueue();
    refreshBotProgress();
    initPageContext(() => loadData());
  });
});
