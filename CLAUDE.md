# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Walmart Order Exporter is a Chrome Extension (Manifest V3) that exports Walmart order history to CSV format. It runs on `walmart.com/orders` pages and extracts order data including items, prices, dates, and totals for both online and in-store purchases.

## Architecture

### Extension Components

- **Popup** (`popup/`) - User interface for configuring export options and initiating exports
- **Content Script** (`content/content.js`) - Injected into Walmart order pages; handles data extraction and CSV generation
- **Service Worker** (`background/service-worker.js`) - Message relay between popup and content script

### Data Flow

1. User clicks "Export Orders" in popup
2. Popup sends `START_EXPORT` message to content script via `chrome.tabs.sendMessage`
3. Content script extracts orders from the current page DOM
4. For detailed prices, content script fetches individual order pages and parses `__NEXT_DATA__` JSON
5. Content script generates CSV and triggers download directly via blob URL
6. Progress updates flow back to popup via `chrome.runtime.sendMessage`

### Order Extraction Strategy

The content script uses a layered extraction approach:
1. **Primary**: Parse `data-testid="order-X"` containers on the order list page
2. **Fallback**: Find order links via `a[href*="/orders/"]` selectors
3. **Detail pages**: Parse `__NEXT_DATA__` script tag for item prices when "Fetch item prices" is enabled

Store purchases are detected via `storePurchase=true` URL param or `TC#` pattern in page content.

## Development

### Loading the Extension

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" and select this directory

### Testing Changes

- Popup changes: Close and reopen the popup
- Content script changes: Use the "Reload" button in the popup footer, or reload the Walmart orders page
- Service worker changes: Click the refresh icon on the extension card in `chrome://extensions`

### Icon Requirements

Chrome extensions need PNG icons at three sizes:
- `icons/icon16.png` - Toolbar button
- `icons/icon48.png` - Extensions page
- `icons/icon128.png` - Chrome Web Store

## Key Classes

### `WalmartOrderExporter` (content/content.js)

Main extraction class with methods for:
- `exportOrders(options)` - Entry point for export process
- `extractOrderDataFromListPage()` - Parses visible order list
- `fetchDetailedItems(orderId)` - Gets item prices from order detail page
- `parseStorePurchasePage(doc, orderId)` - Handles in-store receipt format
- `generateCSV(includeItems)` - Produces final CSV output

### `PopupController` (popup/popup.js)

Manages popup UI state and communicates with content script via Chrome messaging API.

## CSV Output Format

Detailed export columns: Order Number, Order Date, Status, Item Name, Item Price, Quantity, Subtotal, Tax, Order Total, Order Type, Associate Discount, Store Location
