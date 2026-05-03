# Getify Ads Spy

Browser extension for manually collecting Etsy Ads listing and keyword report data from the signed-in Etsy Ads dashboard.

## What it does

- Captures relevant Etsy Ads JSON responses while you browse Etsy.
- Stores captured responses locally in the browser.
- Exports raw JSON, cleaned JSON, and listing CSV.
- Builds `listing_report` and `keyword_report` rows for Neon/PostgreSQL.
- Provides a manual keyword queue so listings can be opened one at a time with human control.

## Privacy

Captured Etsy data is stored locally in the browser. The `temp/` folder is ignored and should not be committed because it may contain shop, listing, and performance data.

## Install

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select this folder.

## Manual Keyword Queue

Use **Refresh** to build a queue from captured listings, then use **Open Next** to open one listing at a time. The URL template must include `{listing_id}`.
