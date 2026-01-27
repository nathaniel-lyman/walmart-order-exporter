/**
 * Walmart Order Exporter - Service Worker
 * Handles background tasks and message passing
 */

// Listen for installation
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('Walmart Order Exporter installed');
  } else if (details.reason === 'update') {
    console.log('Walmart Order Exporter updated');
  }
});

// Handle messages between popup and content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Forward progress updates from content script to popup
  if (request.type === 'EXPORT_PROGRESS') {
    // Broadcast to all extension pages (popup)
    chrome.runtime.sendMessage(request).catch(() => {
      // Popup might be closed, ignore error
    });
  }

  return false;
});

// Handle extension icon click when popup is not used
chrome.action.onClicked.addListener(async (tab) => {
  // This only fires if popup is not defined
  // Navigate to Walmart orders if not already there
  if (!tab.url.includes('walmart.com/orders')) {
    chrome.tabs.update(tab.id, {
      url: 'https://www.walmart.com/orders'
    });
  }
});
