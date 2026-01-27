/**
 * Walmart Order Exporter - Popup Script
 * Handles UI interactions and communicates with content script
 */

class PopupController {
  constructor() {
    this.isExporting = false;
    this.initElements();
    this.bindEvents();
    this.checkCurrentPage();
  }

  initElements() {
    // Buttons
    this.exportBtn = document.getElementById('exportBtn');
    this.stopBtn = document.getElementById('stopBtn');
    this.reloadBtn = document.getElementById('reloadBtn');

    // Options
    this.includeItemsCheckbox = document.getElementById('includeItems');
    this.fetchItemPricesCheckbox = document.getElementById('fetchItemPrices');
    this.allPagesCheckbox = document.getElementById('allPages');
    this.dateRangeSelect = document.getElementById('dateRange');
    this.orderTypeSelect = document.getElementById('orderType');

    // Progress
    this.progressSection = document.getElementById('progressSection');
    this.progressLabel = document.getElementById('progressLabel');
    this.progressPercent = document.getElementById('progressPercent');
    this.progressFill = document.getElementById('progressFill');
    this.progressDetail = document.getElementById('progressDetail');

    // Results
    this.resultsSection = document.getElementById('resultsSection');
    this.successCard = document.getElementById('successCard');
    this.errorCard = document.getElementById('errorCard');
    this.resultSummary = document.getElementById('resultSummary');
    this.errorMessage = document.getElementById('errorMessage');

    // Banner
    this.pageBanner = document.getElementById('pageBanner');
    this.bannerText = document.getElementById('bannerText');
  }

  bindEvents() {
    this.exportBtn.addEventListener('click', () => this.startExport());
    this.stopBtn.addEventListener('click', () => this.stopExport());
    this.reloadBtn.addEventListener('click', () => this.reloadContentScript());

    // Listen for progress updates from content script
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.type === 'EXPORT_PROGRESS') {
        this.updateProgress(request.data);
      }
    });
  }

  async reloadContentScript() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab.url || !tab.url.includes('walmart.com/orders')) {
        this.showBanner('Navigate to walmart.com/orders first', 'warning');
        return;
      }

      this.reloadBtn.textContent = '↻ Reloading...';
      this.reloadBtn.disabled = true;

      // Inject the content script manually
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/content.js']
      });

      this.showBanner('Extension reloaded! Ready to export.', 'success');
      this.reloadBtn.textContent = '↻ Reload';
      this.reloadBtn.disabled = false;
      this.exportBtn.disabled = false;

      // Hide banner after 2 seconds
      setTimeout(() => this.hideBanner(), 2000);
    } catch (error) {
      console.error('Error reloading:', error);
      this.showBanner('Reload failed: ' + error.message, 'error');
      this.reloadBtn.textContent = '↻ Reload';
      this.reloadBtn.disabled = false;
    }
  }

  async checkCurrentPage() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab.url || !tab.url.includes('walmart.com/orders')) {
        this.showBanner('Navigate to walmart.com/orders to use this extension', 'warning');
        this.exportBtn.disabled = true;
      } else {
        this.hideBanner();
        this.exportBtn.disabled = false;
      }
    } catch (error) {
      console.error('Error checking page:', error);
    }
  }

  showBanner(message, type = 'info') {
    this.bannerText.textContent = message;
    this.pageBanner.className = `status-banner ${type}`;
    this.pageBanner.style.display = 'flex';
  }

  hideBanner() {
    this.pageBanner.style.display = 'none';
  }

  getExportOptions() {
    const dateRangeValue = this.dateRangeSelect.value;
    const isCurrentPageOnly = dateRangeValue === 'current';

    return {
      includeItems: this.includeItemsCheckbox.checked,
      fetchItemPrices: this.fetchItemPricesCheckbox.checked,
      // If "current page only" is selected, override allPages to false
      allPages: isCurrentPageOnly ? false : this.allPagesCheckbox.checked,
      dateRange: isCurrentPageOnly ? 'all' : (dateRangeValue === 'all' ? 'all' : parseInt(dateRangeValue)),
      orderTypeFilter: this.orderTypeSelect.value
    };
  }

  async startExport() {
    if (this.isExporting) return;

    this.isExporting = true;
    this.showExportingState();

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab.url.includes('walmart.com/orders')) {
        throw new Error('Please navigate to walmart.com/orders first');
      }

      const options = this.getExportOptions();

      // Send message to content script
      console.log('[Popup] Sending START_EXPORT with options:', options);
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'START_EXPORT',
        options: options
      });

      console.log('[Popup] Received response:', response);

      if (response && response.success) {
        console.log('[Popup] Export successful, orders:', response.orderCount, 'items:', response.itemCount);
        this.showSuccess(response);
        // Download is triggered by content script, no need to duplicate here
      } else {
        console.log('[Popup] Export failed:', response?.error);
        throw new Error(response?.error || 'Export failed');
      }
    } catch (error) {
      console.error('[Popup] Export error:', error);
      this.showError(error.message);
    } finally {
      this.isExporting = false;
      this.showIdleState();
    }
  }

  async stopExport() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      await chrome.tabs.sendMessage(tab.id, { type: 'STOP_EXPORT' });

      this.isExporting = false;
      this.showIdleState();
      this.updateProgressDetail('Export cancelled by user');
    } catch (error) {
      console.error('Error stopping export:', error);
    }
  }

  showExportingState() {
    this.exportBtn.style.display = 'none';
    this.stopBtn.style.display = 'flex';
    this.progressSection.style.display = 'block';
    this.resultsSection.style.display = 'none';
    this.resetProgress();
  }

  showIdleState() {
    this.exportBtn.style.display = 'flex';
    this.stopBtn.style.display = 'none';
  }

  resetProgress() {
    this.progressFill.style.width = '0%';
    this.progressPercent.textContent = '0%';
    this.progressLabel.textContent = 'Exporting...';
    this.progressDetail.textContent = 'Initializing...';
  }

  updateProgress(data) {
    if (data.percent !== undefined) {
      this.progressFill.style.width = `${data.percent}%`;
      this.progressPercent.textContent = `${Math.round(data.percent)}%`;
    }

    if (data.label) {
      this.progressLabel.textContent = data.label;
    }

    if (data.detail) {
      this.progressDetail.textContent = data.detail;
    }
  }

  updateProgressDetail(detail) {
    this.progressDetail.textContent = detail;
  }

  showSuccess(response) {
    this.resultsSection.style.display = 'block';
    this.successCard.style.display = 'flex';
    this.errorCard.style.display = 'none';
    this.progressSection.style.display = 'none';

    const orderCount = response.orderCount || 0;
    const itemCount = response.itemCount || 0;

    this.resultSummary.textContent = `Exported ${orderCount} orders with ${itemCount} items`;
  }

  showError(message) {
    this.resultsSection.style.display = 'block';
    this.successCard.style.display = 'none';
    this.errorCard.style.display = 'flex';
    this.progressSection.style.display = 'none';

    this.errorMessage.textContent = message;
  }

  generateFilename() {
    const date = new Date().toISOString().split('T')[0];
    return `walmart_orders_${date}.csv`;
  }

  downloadCSV(csvContent, filename) {
    console.log('[Popup] Starting download, CSV length:', csvContent.length, 'filename:', filename);

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    console.log('[Popup] Created blob URL:', url);

    chrome.downloads.download({
      url: url,
      filename: filename,
      saveAs: true
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error('[Popup] Download error:', chrome.runtime.lastError);
      } else {
        console.log('[Popup] Download started, ID:', downloadId);
      }
      // Clean up the URL after download starts
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
}

// Initialize popup controller when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new PopupController();
});
