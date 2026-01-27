# Walmart Order Exporter

A Chrome extension that exports your Walmart order history to CSV format. Supports both online orders and in-store purchases.

> **Note**: This project is provided as-is and is not actively maintained. It's intended as a starter repository for developers who want to build their own order export tools or learn Chrome extension development.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-green?logo=googlechrome)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
![License](https://img.shields.io/badge/License-MIT-yellow)

## Features

- Export orders to CSV with item-level detail
- Filter by date range (30 days, 3 months, 6 months, 1 year, all time)
- Filter by order type (online, in-store, or both)
- Automatic pagination through order history
- Optional detailed item price fetching
- Support for in-store purchase receipts (TC# transactions)

## Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode** (toggle in top right)
4. Click **Load unpacked**
5. Select the repository folder

## Usage

1. Navigate to [walmart.com/orders](https://www.walmart.com/orders) and sign in
2. Click the extension icon in your toolbar
3. Configure export options:
   - **Include item details**: Export individual items with quantities
   - **Fetch item prices**: Visit each order page to get exact prices (slower)
   - **Export all pages**: Automatically paginate through your order history
   - **Date Range**: Filter orders by time period
   - **Order Type**: Filter by online or in-store purchases
4. Click **Export Orders**
5. CSV file downloads automatically when complete

## Project Structure

```
walmart-order-exporter/
├── manifest.json          # Extension configuration (Manifest V3)
├── background/
│   └── service-worker.js  # Background script for message passing
├── content/
│   └── content.js         # Content script injected into Walmart pages
├── popup/
│   ├── popup.html         # Extension popup UI
│   └── popup.js           # Popup controller logic
├── styles/
│   └── popup.css          # Popup styling
└── icons/
    ├── icon16.png         # Toolbar icon
    ├── icon48.png         # Extensions page icon
    └── icon128.png        # Chrome Web Store icon
```

## How It Works

### Architecture

The extension uses Chrome's Manifest V3 architecture with three main components:

1. **Popup** - The user interface for configuring and triggering exports
2. **Content Script** - Runs on Walmart order pages to extract data from the DOM
3. **Service Worker** - Relays messages between the popup and content script

### Data Extraction

The content script employs multiple strategies to extract order data:

1. **DOM Parsing**: Extracts order summaries from `data-testid="order-X"` containers on the order list page
2. **Next.js Data**: Parses the `__NEXT_DATA__` script tag for structured order information
3. **Fallback Selectors**: Uses various CSS selectors to find order links and containers

For detailed item prices, the extension fetches individual order pages and extracts pricing from the embedded JSON data.

### Store Purchases

In-store purchases are detected by:
- `storePurchase=true` URL parameter
- `TC#` (transaction code) pattern in page content

These are parsed differently to extract receipt-style data including store location.

## CSV Output

### With Item Details

| Column | Description |
|--------|-------------|
| Order Number | Walmart order ID or TC# for store purchases |
| Order Date | Date the order was placed |
| Status | Delivery status or "Store purchase" |
| Item Name | Product name |
| Item Price | Individual item price |
| Quantity | Number of items |
| Subtotal | Order subtotal |
| Tax | Tax amount |
| Order Total | Total charged |
| Order Type | "Online" or "Store" |
| Associate Discount | Employee discount if applicable |
| Store Location | Store name/address for in-store purchases |

### Summary Only

When "Include item details" is unchecked, exports one row per order with an item count instead of individual items.

## Limitations

- Requires manual sign-in to Walmart (extension cannot authenticate)
- Rate limited by Walmart's servers when fetching detailed prices
- DOM structure changes on Walmart's site may break extraction
- Some older orders may have incomplete data

## Development

### Making Changes

- **Popup changes**: Close and reopen the popup to see changes
- **Content script changes**: Click "Reload" in the popup footer or refresh the Walmart page
- **Service worker changes**: Click the refresh icon on `chrome://extensions`

### Debugging

Open the browser console on a Walmart orders page to see extraction logs prefixed with `[Walmart Order Exporter]`.

The content script exposes a debug function:
```javascript
exporter.debugDOMStructure()
```

This outputs diagnostic information about the page structure to help troubleshoot extraction issues.

## Contributing

This repository is provided as a starter template. Feel free to fork and adapt it for your needs. Pull requests are welcome but may not be reviewed promptly.

## Disclaimer

This extension is not affiliated with, endorsed by, or connected to Walmart Inc. Use at your own risk. The extension only accesses your own order data and does not transmit any information to third parties.

## License

MIT License - See [LICENSE](LICENSE) for details.
