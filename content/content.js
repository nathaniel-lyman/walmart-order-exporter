/**
 * Walmart Order Exporter - Content Script
 * Runs on walmart.com/orders pages to extract order data
 */

class WalmartOrderExporter {
  constructor() {
    this.orders = [];
    this.isExporting = false;
    this.totalOrders = 0;
    this.processedOrders = 0;
  }

  /**
   * Send progress update to popup
   */
  sendProgress(data) {
    chrome.runtime.sendMessage({
      type: 'EXPORT_PROGRESS',
      data: data
    });
  }

  /**
   * Check if a URL or document represents a store purchase
   */
  isStorePurchase(url, doc = null) {
    // Check URL for storePurchase parameter
    if (url && url.includes('storePurchase=true')) {
      return true;
    }

    // Check page content for TC# pattern (store purchase transaction code)
    if (doc) {
      const mainContent = doc.querySelector('main');
      if (mainContent) {
        const pageText = mainContent.innerText;
        if (/TC#\s*[\d-]+/.test(pageText)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Extract store location from store purchase page
   */
  extractStoreLocation(doc, pageText) {
    const storeLocation = {
      name: '',
      address: ''
    };

    // Look for store name - typically appears as "Store name" followed by address
    // Common patterns: "Walmart Supercenter", "Walmart Neighborhood Market", etc.
    const storeNameMatch = pageText.match(/(Walmart\s+(?:Supercenter|Neighborhood Market|Store|Express)(?:\s+#\d+)?)/i);
    if (storeNameMatch) {
      storeLocation.name = storeNameMatch[1].trim();
    }

    // Try to find store address - look for city, state zip pattern near store info
    const addressMatch = pageText.match(/(\d+[^,]+,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?)/i);
    if (addressMatch) {
      storeLocation.address = addressMatch[1].trim();
    }

    // Alternative: look for "Purchased at" or similar patterns
    const purchasedAtMatch = pageText.match(/(?:Purchased at|Store:?)\s*([^\n]+)/i);
    if (purchasedAtMatch && !storeLocation.name) {
      storeLocation.name = purchasedAtMatch[1].trim();
    }

    return storeLocation;
  }

  /**
   * Parse store purchase page HTML
   */
  parseStorePurchasePage(doc, orderId) {
    const mainContent = doc.querySelector('main');
    if (!mainContent) {
      return {
        orderId,
        orderNumber: orderId,
        orderType: 'store',
        orderDate: 'Unknown',
        status: 'Store purchase',
        items: [],
        subtotal: '',
        tax: '',
        total: '',
        associateDiscount: '',
        driverTip: '',
        deliveryFee: '',
        expressFee: '',
        storeLocation: { name: '', address: '' }
      };
    }

    const pageText = mainContent.innerText;

    // Extract TC# (Transaction Code) as order number
    const tcMatch = pageText.match(/TC#\s*([\d-]+)/);
    const orderNumber = tcMatch ? `TC# ${tcMatch[1]}` : orderId;

    // Extract order date
    const dateMatch = pageText.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}/i);
    const orderDate = dateMatch ? dateMatch[0] : 'Unknown';

    // Status is always "Store purchase" for in-store orders
    const status = 'Store purchase';

    // Extract items - try __NEXT_DATA__ first (most reliable, has prices)
    let items = [];
    const nextDataScript = doc.querySelector('script#__NEXT_DATA__');
    if (nextDataScript) {
      try {
        const nextData = JSON.parse(nextDataScript.textContent);
        items = this.extractItemsFromNextData(nextData, orderId);
        console.log('[Walmart Order Exporter] Store purchase: extracted', items.length, 'items from __NEXT_DATA__');
      } catch (e) {
        console.log('[Walmart Order Exporter] Store purchase: __NEXT_DATA__ parse failed:', e.message);
      }
    }

    // Fallback to DOM-based approach
    if (items.length === 0) {
      items = this.extractItemsFromDOM(doc);
    }

    // Final fallback to receipt-style parsing
    if (items.length === 0) {
      items = this.extractItemsFromReceipt(doc, pageText);
    }

    // Extract totals
    const subtotalMatch = pageText.match(/Subtotal\s*\$?([\d,]+\.\d{2})/);
    const taxMatch = pageText.match(/Tax\s*\$?([\d,]+\.\d{2})/);
    const totalMatch = pageText.match(/Total\s*\$?([\d,]+\.\d{2})/);

    // Extract associate discount if present
    const discountMatch = pageText.match(/Associate discount\s*[-−]?\$?([\d,]+\.\d{2})/i);
    const associateDiscount = discountMatch ? `-$${discountMatch[1]}` : '';

    // Extract store location
    const storeLocation = this.extractStoreLocation(doc, pageText);

    return {
      orderId,
      orderNumber,
      orderType: 'store',
      orderDate,
      status,
      items,
      subtotal: subtotalMatch ? `$${subtotalMatch[1]}` : '',
      tax: taxMatch ? `$${taxMatch[1]}` : '',
      total: totalMatch ? `$${totalMatch[1]}` : '',
      associateDiscount,
      driverTip: '',
      deliveryFee: '',
      expressFee: '',
      storeLocation
    };
  }

  /**
   * Extract items from receipt-style format (fallback for store purchases)
   */
  extractItemsFromReceipt(doc, pageText) {
    const items = [];
    const seen = new Set();

    // Look for product links first (same as online orders)
    const productLinks = doc.querySelectorAll('a[href*="/ip/"]');

    productLinks.forEach(link => {
      const name = link.textContent?.trim();
      if (name && name.length > 5 && name.length < 300 && !seen.has(name) && this.isValidProductName(name)) {
        let price = '';
        let quantity = 1;

        // Traverse up to find price
        let container = link;
        for (let i = 0; i < 20 && container; i++) {
          container = container.parentElement;
          if (container) {
            const containerText = container.innerText || '';
            const priceMatch = containerText.match(/\$(\d+\.\d{2})/);
            if (priceMatch) {
              price = `$${priceMatch[1]}`;
            }
            const qtyMatch = containerText.match(/Qty\s*(\d+)/i);
            if (qtyMatch) {
              quantity = parseInt(qtyMatch[1]);
            }
            if (price) break;
          }
        }

        seen.add(name);
        items.push({
          name,
          quantity,
          price,
          priceValue: price ? parseFloat(price.replace('$', '')) : 0
        });
      }
    });

    // If still no items, try to parse text-based receipt format
    // Receipt items often appear as "Item name   $X.XX" or similar patterns
    if (items.length === 0) {
      const lines = pageText.split('\n');
      for (const line of lines) {
        // Match lines that look like: "Product Name  $12.34" or "Product Name $12.34 Qty 2"
        const itemMatch = line.match(/^(.{10,80})\s+\$(\d+\.\d{2})(?:\s*(?:Qty\s*)?(\d+))?/);
        if (itemMatch) {
          const name = itemMatch[1].trim();
          if (this.isValidProductName(name) && !seen.has(name)) {
            seen.add(name);
            items.push({
              name,
              quantity: itemMatch[3] ? parseInt(itemMatch[3]) : 1,
              price: `$${itemMatch[2]}`,
              priceValue: parseFloat(itemMatch[2])
            });
          }
        }
      }
    }

    return items;
  }

  /**
   * Extract order data directly from the visible order list page
   * This is more reliable than fetching individual pages since content is already rendered
   */
  extractOrderDataFromListPage() {
    const orders = [];
    const seenOrderIds = new Set();

    // Primary method: Find order containers by data-testid pattern (order-0, order-1, etc.)
    const orderContainers = document.querySelectorAll('[data-testid]');
    const validOrderContainers = Array.from(orderContainers).filter(el =>
      /^order-\d+$/.test(el.dataset.testid)
    );

    console.log('[Walmart Order Exporter] Found', validOrderContainers.length, 'order containers via data-testid');

    if (validOrderContainers.length > 0) {
      // Use the new DOM structure with data-testid="order-X"
      validOrderContainers.forEach(container => {
        // Find order ID from any link within the container
        const orderLink = container.querySelector('a[href*="/orders/"]');
        if (!orderLink) return;

        const match = orderLink.href.match(/\/orders\/(\d+)/);
        if (!match || seenOrderIds.has(match[1])) return;

        const orderId = match[1];
        seenOrderIds.add(orderId);

        const containerText = container.innerText || '';

        // Extract order date and status
        let orderDate = 'Unknown';
        let status = 'Unknown';

        // Check for delivery status patterns
        if (containerText.includes('Arrives today')) {
          status = 'Arrives today';
          orderDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        } else if (containerText.includes('Arrives by')) {
          const arrivesMatch = containerText.match(/Arrives by\s+(\w+,\s+\w+\s+\d+)/i);
          if (arrivesMatch) {
            status = 'Arrives by ' + arrivesMatch[1];
          }
          const dateMatch = containerText.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}/i);
          if (dateMatch) {
            orderDate = dateMatch[0] + ', ' + new Date().getFullYear();
          }
        } else if (containerText.includes('Delivered on')) {
          status = 'Delivered';
          const dateMatch = containerText.match(/Delivered on\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})/i);
          if (dateMatch) {
            orderDate = `${dateMatch[1]} ${dateMatch[2]}, ${new Date().getFullYear()}`;
          }
        } else if (containerText.includes('Delivered')) {
          status = 'Delivered';
          const dateMatch = containerText.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})/i);
          if (dateMatch) {
            orderDate = `${dateMatch[1]} ${dateMatch[2]}, ${new Date().getFullYear()}`;
          }
        } else if (containerText.includes('Preparing')) {
          status = 'Preparing';
        } else if (containerText.includes('On the way')) {
          status = 'On the way';
        } else if (containerText.includes('Store purchase')) {
          status = 'Store purchase';
        }

        // Extract order total
        const totalMatch = containerText.match(/Order total \$([\d,]+\.\d{2})/);
        const total = totalMatch ? `$${totalMatch[1]}` : '';

        // Extract items from image alt texts
        const items = this.extractItemsFromOrderContainer(container);

        // Determine if this is a store purchase
        const isStore = containerText.includes('Store purchase') || containerText.includes('TC#');

        orders.push({
          orderId,
          orderNumber: orderId,
          orderType: isStore ? 'store' : 'online',
          orderDate,
          status,
          items,
          subtotal: '',
          tax: '',
          total,
          associateDiscount: '',
          driverTip: '',
          deliveryFee: '',
          expressFee: '',
          storeLocation: { name: '', address: '' }
        });

        console.log('[Walmart Order Exporter] Extracted order', orderId, '- status:', status, 'date:', orderDate, 'items:', items.length, 'total:', total);
      });
    }

    // Fallback: Try the legacy method with return links if no orders found
    if (orders.length === 0) {
      console.log('[Walmart Order Exporter] No orders found via data-testid, trying return links fallback');
      const returnLinks = document.querySelectorAll('a[href*="/orders/"][href*="/returns"]');
      console.log('[Walmart Order Exporter] Found', returnLinks.length, 'return links');

      returnLinks.forEach(returnLink => {
        const match = returnLink.href.match(/\/orders\/(\d+)\/returns/);
        if (!match || seenOrderIds.has(match[1])) return;

        const orderId = match[1];
        seenOrderIds.add(orderId);

        // Try to find the order container by traversing up
        let orderContainer = this.findOrderContainer(returnLink);
        const containerText = orderContainer?.innerText || '';

        // Extract status and date
        let orderDate = 'Unknown';
        let status = 'Unknown';

        if (containerText.includes('Arrives today')) {
          status = 'Arrives today';
          orderDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        } else if (containerText.includes('Arrives by')) {
          const arrivesMatch = containerText.match(/Arrives by\s+(\w+,\s+\w+\s+\d+)/i);
          if (arrivesMatch) status = 'Arrives by ' + arrivesMatch[1];
        } else if (containerText.includes('Delivered')) {
          status = 'Delivered';
        } else if (containerText.includes('Store purchase')) {
          status = 'Store purchase';
        }

        const totalMatch = containerText.match(/Order total \$([\d,]+\.\d{2})/);
        const total = totalMatch ? `$${totalMatch[1]}` : '';

        const items = this.extractItemsFromOrderContainer(orderContainer);
        const isStore = containerText.includes('Store purchase') || containerText.includes('TC#');

        orders.push({
          orderId,
          orderNumber: orderId,
          orderType: isStore ? 'store' : 'online',
          orderDate,
          status,
          items,
          subtotal: '',
          tax: '',
          total,
          associateDiscount: '',
          driverTip: '',
          deliveryFee: '',
          expressFee: '',
          storeLocation: { name: '', address: '' }
        });

        console.log('[Walmart Order Exporter] Extracted order (fallback)', orderId);
      });
    }

    console.log('[Walmart Order Exporter] Extracted', orders.length, 'orders from list page');
    return orders;
  }

  /**
   * Find the order container element by traversing up from a child element
   * Looks for data-testid pattern or common container indicators
   */
  findOrderContainer(element) {
    let el = element;
    for (let i = 0; i < 15 && el; i++) {
      el = el.parentElement;
      if (!el) break;

      // Check for data-testid matching order-X pattern
      if (el.dataset?.testid && /^order-\d+$/.test(el.dataset.testid)) {
        return el;
      }

      // Check for common container indicators
      if (el.dataset?.testid?.includes('order') ||
          el.className?.includes('order') ||
          (el.tagName === 'SECTION' && el.innerText?.includes('Order total'))) {
        return el;
      }
    }

    // Fallback: return the element 5-6 levels up which often contains order info
    el = element;
    for (let i = 0; i < 6 && el?.parentElement; i++) {
      el = el.parentElement;
    }
    return el;
  }

  /**
   * Debug function to help diagnose DOM structure issues
   * Call from browser console: exporter.debugDOMStructure()
   */
  debugDOMStructure() {
    console.log('=== Walmart Order Exporter Debug ===');

    // Check for __NEXT_DATA__
    const nextDataScript = document.querySelector('script#__NEXT_DATA__');
    if (nextDataScript) {
      try {
        const data = JSON.parse(nextDataScript.textContent);
        console.log('__NEXT_DATA__ found, pageProps keys:', Object.keys(data?.props?.pageProps || {}));
      } catch (e) {
        console.log('__NEXT_DATA__ parse error:', e.message);
      }
    } else {
      console.log('No __NEXT_DATA__ script found');
    }

    // Check for order containers by data-testid
    const orderContainers = Array.from(document.querySelectorAll('[data-testid]'))
      .filter(el => /^order-\d+$/.test(el.dataset.testid));
    console.log('Order containers (data-testid="order-X"):', orderContainers.length);
    orderContainers.forEach(el => {
      const link = el.querySelector('a[href*="/orders/"]');
      const images = el.querySelectorAll('img[alt]').length;
      const hasTotal = el.innerText?.includes('Order total');
      console.log(`  - ${el.dataset.testid}: link=${link?.href?.match(/\d+/)?.[0] || 'none'}, images=${images}, hasTotal=${hasTotal}`);
    });

    // Check for return links (legacy selector)
    const returnLinks = document.querySelectorAll('a[href*="/orders/"][href*="/returns"]');
    console.log('Return links (legacy selector):', returnLinks.length);
    returnLinks.forEach(link => {
      const match = link.href.match(/\/orders\/(\d+)/);
      console.log(`  - Order ID: ${match ? match[1] : 'unknown'}`);
    });

    // Check for any order-related links
    const allOrderLinks = document.querySelectorAll('a[href*="/orders/"]');
    console.log('All /orders/ links:', allOrderLinks.length);

    // Check for View details buttons
    const viewDetailsButtons = Array.from(document.querySelectorAll('button'))
      .filter(b => b.textContent?.includes('View details'));
    console.log('View details buttons:', viewDetailsButtons.length);

    // List all data-testid values related to orders
    const orderTestIds = Array.from(document.querySelectorAll('[data-testid]'))
      .map(el => el.dataset.testid)
      .filter(id => id.toLowerCase().includes('order'));
    console.log('Order-related testids:', [...new Set(orderTestIds)]);

    console.log('=== End Debug ===');

    return {
      nextDataFound: !!nextDataScript,
      orderContainers: orderContainers.length,
      returnLinks: returnLinks.length,
      allOrderLinks: allOrderLinks.length,
      viewDetailsButtons: viewDetailsButtons.length
    };
  }

  /**
   * Fetch detailed item info from order detail page (includes prices)
   */
  async fetchDetailedItems(orderId, isStore = false) {
    try {
      const orderUrl = `https://www.walmart.com/orders/${orderId}${isStore ? '?storePurchase=true' : ''}`;
      console.log('[Walmart Order Exporter] Fetching detailed items for order:', orderId);

      const response = await fetch(orderUrl, {
        credentials: 'include',
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });

      if (!response.ok) {
        console.log('[Walmart Order Exporter] Failed to fetch order page:', response.status);
        return null;
      }

      const html = await response.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      // Look for __NEXT_DATA__ which contains the order details
      const nextDataScript = doc.querySelector('script#__NEXT_DATA__');
      if (!nextDataScript) {
        console.log('[Walmart Order Exporter] No __NEXT_DATA__ found');
        return null;
      }

      const nextData = JSON.parse(nextDataScript.textContent);
      const items = this.extractItemsFromNextData(nextData, orderId);

      console.log('[Walmart Order Exporter] Extracted', items.length, 'detailed items for order', orderId);

      // Extract order metadata (date, subtotal, tax, fees, discounts) for all orders
      const orderMeta = this.extractOrderMetaFromNextData(nextData);
      if (orderMeta) {
        console.log('[Walmart Order Exporter] Extracted order metadata:', orderMeta);
      }

      return { items, orderMeta };
    } catch (error) {
      console.error('[Walmart Order Exporter] Error fetching detailed items:', error);
      return null;
    }
  }

  /**
   * Extract items from Next.js data structure
   */
  extractItemsFromNextData(nextData, orderId) {
    const items = [];
    const seen = new Set();

    try {
      // Navigate through the Next.js data structure to find order items
      const pageProps = nextData?.props?.pageProps;
      if (!pageProps) return items;

      // Try different possible paths to find order groups/items
      // Current Walmart structure (2024+): pageProps.initialData.data.order.groups_2101
      const possibleGroupPaths = [
        pageProps?.initialData?.data?.order?.groups_2101,
        pageProps?.initialData?.data?.order?.orderGroups,
        pageProps?.initialData?.orderGroups,
        pageProps?.orderDetails?.orderGroups,
        pageProps?.order?.orderGroups,
        pageProps?.orderGroups
      ];

      for (const orderGroups of possibleGroupPaths) {
        if (!orderGroups || !Array.isArray(orderGroups)) continue;

        console.log('[Walmart Order Exporter] Found order groups:', orderGroups.length);

        for (const group of orderGroups) {
          const lineItems = group?.items || group?.lineItems || [];

          for (const lineItem of lineItems) {
            // Current Walmart structure: item has productInfo.name and priceInfo.linePrice
            const productInfo = lineItem?.productInfo || lineItem?.item || lineItem?.product || lineItem;
            const name = productInfo?.name || productInfo?.productName || lineItem?.name || lineItem?.description || '';

            if (!name || seen.has(name)) continue;
            seen.add(name);

            // Extract price - try various structures
            let price = 0;
            let priceStr = '';

            // Current Walmart structure: priceInfo.linePrice.value
            const priceInfo = lineItem?.priceInfo;
            if (priceInfo?.linePrice) {
              if (typeof priceInfo.linePrice === 'object') {
                price = priceInfo.linePrice.value || priceInfo.linePrice.amount || 0;
                priceStr = priceInfo.linePrice.displayValue || '';
              } else if (typeof priceInfo.linePrice === 'number') {
                price = priceInfo.linePrice;
              }
            }

            // Fallback: try linePrice directly on lineItem
            if (!price) {
              const linePrice = lineItem?.linePrice || lineItem?.price || lineItem?.chargeAmount;
              if (linePrice) {
                if (typeof linePrice === 'number') {
                  price = linePrice;
                } else if (typeof linePrice === 'object') {
                  price = linePrice?.value || linePrice?.amount || linePrice?.price || 0;
                } else if (typeof linePrice === 'string') {
                  price = parseFloat(linePrice.replace(/[$,]/g, '')) || 0;
                }
              }
            }

            // Fallback: try unit price
            if (!price) {
              const unitPrice = productInfo?.price || productInfo?.salePrice || lineItem?.unitPrice;
              if (unitPrice) {
                if (typeof unitPrice === 'number') {
                  price = unitPrice;
                } else if (typeof unitPrice === 'object') {
                  price = unitPrice?.value || unitPrice?.amount || unitPrice?.price || 0;
                }
              }
            }

            if (price > 0 && !priceStr) {
              priceStr = `$${price.toFixed(2)}`;
            }

            const quantity = lineItem?.quantity || productInfo?.quantity || 1;

            items.push({
              name,
              quantity,
              price: priceStr,
              priceValue: price
            });

            console.log('[Walmart Order Exporter] Detailed item:', name.substring(0, 40), 'price:', priceStr, 'qty:', quantity);
          }
        }

        // If we found items, stop trying other paths
        if (items.length > 0) break;
      }

      // If no items found via orderGroups, try looking for items directly
      if (items.length === 0) {
        const directItems = pageProps?.initialData?.data?.order?.items ||
                           pageProps?.orderDetails?.items ||
                           pageProps?.items || [];
        for (const item of directItems) {
          const name = item?.productInfo?.name || item?.name || item?.productName || '';
          if (!name || seen.has(name)) continue;
          seen.add(name);

          let price = 0;
          if (item?.priceInfo?.linePrice) {
            price = item.priceInfo.linePrice.value || item.priceInfo.linePrice.amount || 0;
          } else if (item?.price || item?.linePrice) {
            const p = item.price || item.linePrice;
            price = typeof p === 'object' ? (p?.value || p?.amount || 0) : (typeof p === 'number' ? p : 0);
          }

          items.push({
            name,
            quantity: item?.quantity || 1,
            price: price > 0 ? `$${price.toFixed(2)}` : '',
            priceValue: price
          });
        }
      }
    } catch (error) {
      console.error('[Walmart Order Exporter] Error parsing Next.js data:', error);
    }

    return items;
  }

  /**
   * Extract order metadata (date, subtotal, tax, fees, discounts) from Next.js data structure
   * Used for orders where list page extraction may miss these fields
   * Primary data source: order.priceDetails (confirmed via browser inspection)
   */
  extractOrderMetaFromNextData(nextData) {
    try {
      const pageProps = nextData?.props?.pageProps;
      if (!pageProps) return null;

      // Try different paths to find order data
      const order = pageProps?.initialData?.data?.order ||
                    pageProps?.orderDetails ||
                    pageProps?.order;

      if (!order) return null;

      const meta = {};

      // Extract order date
      if (order.orderDate) {
        meta.orderDate = order.orderDate;
      }

      // Use priceDetails (primary - confirmed via browser inspection) or orderSummary (fallback)
      const priceDetails = order.priceDetails || order.orderSummary || order.summary;
      if (priceDetails) {
        // Subtotal
        if (priceDetails.subTotal !== undefined) {
          meta.subtotal = this.extractDisplayValue(priceDetails.subTotal);
        } else if (priceDetails.subtotal !== undefined) {
          meta.subtotal = this.extractDisplayValue(priceDetails.subtotal);
        }

        // Tax
        if (priceDetails.taxTotal !== undefined) {
          meta.tax = this.extractDisplayValue(priceDetails.taxTotal);
        } else if (priceDetails.tax !== undefined) {
          meta.tax = this.extractDisplayValue(priceDetails.tax);
        }

        // Total
        if (priceDetails.grandTotal !== undefined) {
          meta.total = this.extractDisplayValue(priceDetails.grandTotal);
        } else if (priceDetails.total !== undefined) {
          meta.total = this.extractDisplayValue(priceDetails.total);
        }

        // Driver Tip
        if (priceDetails.driverTip) {
          meta.driverTip = this.extractDisplayValue(priceDetails.driverTip);
        }

        // Associate Discount (from discounts array)
        if (priceDetails.discounts && Array.isArray(priceDetails.discounts)) {
          const assocDiscount = priceDetails.discounts.find(d =>
            d.label?.toLowerCase().includes('associate') ||
            d.label?.toLowerCase().includes('employee')
          );
          if (assocDiscount) {
            meta.associateDiscount = this.extractDisplayValue(assocDiscount);
          }
        }

        // Delivery Fee and Express Fee (from fees array)
        if (priceDetails.fees && Array.isArray(priceDetails.fees)) {
          // Look for delivery fee (various possible labels)
          const deliveryFee = priceDetails.fees.find(f =>
            /delivery/i.test(f.label) && !/express/i.test(f.label)
          );
          if (deliveryFee) {
            meta.deliveryFee = this.extractDisplayValue(deliveryFee);
          }

          // Look for express fee
          const expressFee = priceDetails.fees.find(f =>
            /express/i.test(f.label)
          );
          if (expressFee) {
            meta.expressFee = this.extractDisplayValue(expressFee);
          }
        }
      }

      return Object.keys(meta).length > 0 ? meta : null;
    } catch (error) {
      console.error('[Walmart Order Exporter] Error extracting order meta:', error);
      return null;
    }
  }

  /**
   * Extract display value from price detail object or primitive
   * Handles structures like {label, value, displayValue} or plain numbers/strings
   */
  extractDisplayValue(priceObj) {
    if (priceObj === null || priceObj === undefined) return '';

    // If it's already a string, return it (possibly add $ if missing)
    if (typeof priceObj === 'string') {
      return priceObj.startsWith('$') || priceObj.startsWith('-$') ? priceObj : `$${priceObj}`;
    }

    // If it's a number, format it
    if (typeof priceObj === 'number') {
      return `$${priceObj.toFixed(2)}`;
    }

    // If it's an object, try to get displayValue or format value
    if (typeof priceObj === 'object') {
      if (priceObj.displayValue) {
        return priceObj.displayValue;
      }
      if (priceObj.value !== undefined) {
        const val = priceObj.value;
        if (typeof val === 'number') {
          return `$${val.toFixed(2)}`;
        }
        return String(val);
      }
      if (priceObj.amount !== undefined) {
        const amt = priceObj.amount;
        if (typeof amt === 'number') {
          return `$${amt.toFixed(2)}`;
        }
        return String(amt);
      }
    }

    return '';
  }

  /**
   * Extract items from an order container using image alt text
   */
  extractItemsFromOrderContainer(container) {
    if (!container) return [];

    const items = [];
    const seen = new Set();

    // Find all images with alt text (product images)
    const images = container.querySelectorAll('img[alt]');

    images.forEach(img => {
      let name = img.alt?.trim();
      if (!name || name.length < 10 || name.length > 300) return;

      // Skip non-product images
      const skipPatterns = [
        /^Walmart/i,
        /^Pro Seller$/i,
        /Privacy/i,
        /^star/i,
        /rating/i,
        /logo/i,
        /icon/i,
        /avatar/i
      ];

      for (const pattern of skipPatterns) {
        if (pattern.test(name)) return;
      }

      // Check for quantity in the alt text (e.g., "Product Name, quantity 2")
      let quantity = 1;
      const qtyMatch = name.match(/,\s*quantity\s+(\d+)$/i);
      if (qtyMatch) {
        quantity = parseInt(qtyMatch[1]);
        name = name.replace(/,\s*quantity\s+\d+$/i, '').trim();
      }

      if (!seen.has(name) && this.isValidProductName(name)) {
        seen.add(name);
        items.push({
          name,
          quantity,
          price: '', // Price not available on list page
          priceValue: 0
        });
        console.log('[Walmart Order Exporter] Found item:', name.substring(0, 50));
      }
    });

    return items;
  }

  /**
   * Get order IDs from links on current page
   * Returns objects with {orderId, url, isStore} for each order
   */
  getOrderIdsFromPage() {
    const links = document.querySelectorAll('a[href*="/orders/"]');
    const orderMap = new Map(); // Use map to deduplicate by orderId

    links.forEach(link => {
      const match = link.href.match(/\/orders\/(\d+)(\?.*)?/);
      if (match) {
        const orderId = match[1];
        const url = link.href;
        const isStore = url.includes('storePurchase=true');

        // Prefer store purchase URL if we find one (more specific)
        if (!orderMap.has(orderId) || isStore) {
          orderMap.set(orderId, {
            orderId,
            url,
            isStore
          });
        }
      }
    });

    const orders = Array.from(orderMap.values());
    console.log('[Walmart Order Exporter] Found orders on page:', orders.map(o => `${o.orderId}${o.isStore ? ' (store)' : ''}`));
    return orders;
  }

  /**
   * Get order summaries visible on current list page
   */
  getVisibleOrderSummaries() {
    const summaries = [];
    const buttons = document.querySelectorAll('button[aria-label*="View details"]');
    const seen = new Set();

    buttons.forEach(btn => {
      const label = btn.getAttribute('aria-label');
      if (label && !seen.has(label)) {
        seen.add(label);

        const statusInfo = label.replace('View details of ', '');

        // Find the closest section/container
        const section = btn.closest('section') || btn.closest('[class*="bt b--black"]');
        let total = '';

        if (section) {
          // Look for order total
          const elements = section.querySelectorAll('*');
          for (const el of elements) {
            const text = el.innerText || '';
            if (text.startsWith('Order total $') && text.length < 25) {
              total = text.replace('Order total ', '');
              break;
            }
          }
        }

        // Parse status info
        const parts = statusInfo.split(', ');
        const orderType = parts[0] || 'Delivery';
        const status = parts.slice(1).join(', ') || 'Unknown';

        summaries.push({
          orderType,
          status,
          total
        });
      }
    });

    return summaries;
  }

  /**
   * Fetch order details from Walmart's API
   */
  async fetchOrderFromAPI(orderId) {
    try {
      // Try the order details API endpoint
      const apiUrl = `https://www.walmart.com/api/order-details/${orderId}`;
      const response = await fetch(apiUrl, {
        credentials: 'include',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        console.log('[Walmart Order Exporter] Got API response for order:', orderId);
        return data;
      }
    } catch (e) {
      console.log('[Walmart Order Exporter] API fetch failed:', e.message);
    }

    // Try alternative API endpoints
    const alternativeUrls = [
      `https://www.walmart.com/api/orders/${orderId}`,
      `https://www.walmart.com/orchestra/home/graphql/orderDetails/${orderId}`
    ];

    for (const url of alternativeUrls) {
      try {
        const response = await fetch(url, {
          credentials: 'include',
          headers: {
            'Accept': 'application/json'
          }
        });
        if (response.ok) {
          const data = await response.json();
          console.log('[Walmart Order Exporter] Got API response from:', url);
          return data;
        }
      } catch (e) {
        // Continue trying
      }
    }

    return null;
  }

  /**
   * Fetch and parse order details page
   * @param {string|Object} orderInfo - Either an orderId string (backward compatible) or {orderId, url, isStore} object
   */
  async fetchOrderDetails(orderInfo) {
    // Support both old format (string) and new format (object)
    const orderId = typeof orderInfo === 'string' ? orderInfo : orderInfo.orderId;
    const isStore = typeof orderInfo === 'object' ? orderInfo.isStore : false;
    const orderUrl = typeof orderInfo === 'object' && orderInfo.url
      ? orderInfo.url
      : `https://www.walmart.com/orders/${orderId}${isStore ? '?storePurchase=true' : ''}`;

    try {
      // First try to get data from API (more reliable)
      const apiData = await this.fetchOrderFromAPI(orderId);
      if (apiData && (apiData.orderDetails || apiData.lineItems || apiData.items)) {
        console.log('[Walmart Order Exporter] Using API data for order:', orderId);
        return this.parseOrderFromJSONData(apiData.orderDetails || apiData, orderId);
      }

      // Fall back to HTML parsing
      const response = await fetch(orderUrl, {
        credentials: 'include',
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const html = await response.text();
      console.log('[Walmart Order Exporter] HTML length for order', orderId, ':', html.length);

      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      // Check if this is a store purchase (from URL or page content)
      const isStorePurchase = isStore || this.isStorePurchase(orderUrl, doc);

      if (isStorePurchase) {
        console.log(`[Walmart Order Exporter] Parsing store purchase: ${orderId}`);
        return this.parseStorePurchasePage(doc, orderId);
      } else {
        return this.parseOrderDetailPage(doc, orderId);
      }
    } catch (error) {
      console.error(`Error fetching order ${orderId}:`, error);
      return {
        orderId,
        orderType: isStore ? 'store' : 'online',
        orderDate: 'Unknown',
        status: 'Error fetching',
        items: [],
        subtotal: '',
        tax: '',
        total: '',
        associateDiscount: '',
        driverTip: '',
        deliveryFee: '',
        expressFee: '',
        storeLocation: { name: '', address: '' },
        error: error.message
      };
    }
  }

  /**
   * Extract order data from embedded JSON (Next.js/React apps)
   */
  extractOrderFromJSON(doc, orderId) {
    // Try to find Next.js data
    const nextDataScript = doc.querySelector('script#__NEXT_DATA__');
    if (nextDataScript) {
      try {
        const data = JSON.parse(nextDataScript.textContent);
        console.log('[Walmart Order Exporter] Found __NEXT_DATA__');
        return this.parseNextJSData(data, orderId);
      } catch (e) {
        console.log('[Walmart Order Exporter] Failed to parse __NEXT_DATA__:', e);
      }
    }

    // Try to find inline JSON in script tags
    const scripts = doc.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent || '';

      // Look for order data patterns
      if (text.includes('orderDetails') || text.includes('lineItems') || text.includes(orderId)) {
        // Try to extract JSON objects
        const jsonMatches = text.match(/\{[^{}]*"orderDetails"[^{}]*\}/g) ||
                           text.match(/\{[^{}]*"lineItems"[^{}]*\}/g);
        if (jsonMatches) {
          for (const match of jsonMatches) {
            try {
              const data = JSON.parse(match);
              if (data.orderDetails || data.lineItems) {
                console.log('[Walmart Order Exporter] Found order data in script tag');
                return data;
              }
            } catch (e) {
              // Continue trying
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Parse Next.js embedded data structure
   */
  parseNextJSData(data, orderId) {
    try {
      // Navigate through Next.js data structure
      const props = data?.props?.pageProps;
      console.log('[Walmart Order Exporter] pageProps keys:', props ? Object.keys(props) : 'none');

      if (!props) return null;

      // Look for order data in various possible locations
      const possibleKeys = ['orderDetails', 'order', 'orderData', 'initialData', 'initialState', 'data'];
      for (const key of possibleKeys) {
        if (props[key]) {
          console.log('[Walmart Order Exporter] Found data at props.' + key);
          const orderData = props[key].order || props[key].orderDetails || props[key];
          if (orderData) return orderData;
        }
      }

      // Check for Apollo/GraphQL cache
      if (props.__APOLLO_STATE__) {
        const apolloState = props.__APOLLO_STATE__;
        console.log('[Walmart Order Exporter] Apollo state keys:', Object.keys(apolloState).slice(0, 10));
        for (const key of Object.keys(apolloState)) {
          if (key.includes('Order') || key.includes(orderId)) {
            console.log('[Walmart Order Exporter] Found order in Apollo state:', key);
            return apolloState[key];
          }
        }
      }

      // Try to find order data anywhere in props
      const propsStr = JSON.stringify(props);
      if (propsStr.includes(orderId)) {
        console.log('[Walmart Order Exporter] Order ID found in props, searching deeper...');
        // Deep search for the order
        return this.deepSearchForOrder(props, orderId);
      }
    } catch (e) {
      console.log('[Walmart Order Exporter] Error parsing Next.js data:', e);
    }
    return null;
  }

  /**
   * Deep search for order data in nested object
   */
  deepSearchForOrder(obj, orderId, depth = 0) {
    if (depth > 10 || !obj) return null;

    if (typeof obj !== 'object') return null;

    // Check if this object looks like order data
    if (obj.orderId === orderId || obj.id === orderId || obj.orderNumber?.includes(orderId)) {
      return obj;
    }

    // Check for lineItems or items array (strong indicator of order data)
    if ((obj.lineItems || obj.items || obj.orderLines) && Array.isArray(obj.lineItems || obj.items || obj.orderLines)) {
      const items = obj.lineItems || obj.items || obj.orderLines;
      if (items.length > 0 && items[0].name) {
        console.log('[Walmart Order Exporter] Found order-like object with items at depth', depth);
        return obj;
      }
    }

    // Recursively search
    for (const key of Object.keys(obj)) {
      const result = this.deepSearchForOrder(obj[key], orderId, depth + 1);
      if (result) return result;
    }

    return null;
  }

  /**
   * Parse order detail page HTML (online orders)
   */
  parseOrderDetailPage(doc, orderId) {
    // First try to extract from embedded JSON (more reliable for SPAs)
    const jsonData = this.extractOrderFromJSON(doc, orderId);
    if (jsonData) {
      return this.parseOrderFromJSONData(jsonData, orderId);
    }

    // Fallback to DOM parsing
    const mainContent = doc.querySelector('main');
    const bodyContent = doc.body;
    const contentToSearch = mainContent || bodyContent;

    if (!contentToSearch) {
      return {
        orderId,
        orderType: 'online',
        orderDate: 'Unknown',
        status: 'Could not parse',
        items: [],
        subtotal: '',
        tax: '',
        total: '',
        associateDiscount: '',
        driverTip: '',
        deliveryFee: '',
        expressFee: '',
        storeLocation: { name: '', address: '' }
      };
    }

    const pageText = contentToSearch.innerText || '';
    const fullHTML = doc.documentElement.innerHTML || '';

    // Extract order date - try multiple patterns
    let orderDate = 'Unknown';
    const datePatterns = [
      /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\s+order/i,
      /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}/i,
      /(\d{1,2}\/\d{1,2}\/\d{4})/
    ];
    for (const pattern of datePatterns) {
      const match = (pageText + fullHTML).match(pattern);
      if (match) {
        orderDate = match[0].replace(' order', '');
        break;
      }
    }

    // Extract order number
    const orderNumMatch = (pageText + fullHTML).match(/Order#?\s*([\d-]+)/i);
    const orderNumber = orderNumMatch ? orderNumMatch[1] : orderId;

    // Extract status
    let status = 'Unknown';
    if (pageText.includes('Delivered') || fullHTML.includes('Delivered')) {
      status = 'Delivered';
    } else if (pageText.includes('Arrives') || fullHTML.includes('Arrives')) {
      status = 'In Transit';
    } else if (pageText.includes('Shipped') || fullHTML.includes('Shipped')) {
      status = 'Shipped';
    }

    // Extract items using DOM-based approach
    const items = this.extractItemsFromDOM(doc);

    // Extract totals from HTML as well
    const combinedText = pageText + fullHTML;
    const subtotalMatch = combinedText.match(/Subtotal[:\s]*\$?([\d,]+\.\d{2})/i);
    const taxMatch = combinedText.match(/Tax[:\s]*\$?([\d,]+\.\d{2})/i);
    const totalMatch = combinedText.match(/(?:Order\s*)?Total[:\s]*\$?([\d,]+\.\d{2})/i);

    return {
      orderId,
      orderNumber,
      orderType: 'online',
      orderDate,
      status,
      items,
      subtotal: subtotalMatch ? `$${subtotalMatch[1]}` : '',
      tax: taxMatch ? `$${taxMatch[1]}` : '',
      total: totalMatch ? `$${totalMatch[1]}` : '',
      associateDiscount: '',
      driverTip: '',
      deliveryFee: '',
      expressFee: '',
      storeLocation: { name: '', address: '' }
    };
  }

  /**
   * Parse order data from JSON structure
   */
  parseOrderFromJSONData(data, orderId) {
    console.log('[Walmart Order Exporter] Parsing JSON data, keys:', Object.keys(data));

    const items = [];

    // Extract items from various possible structures
    const lineItems = data.lineItems || data.items || data.orderLines || data.products || data.orderItems || [];
    console.log('[Walmart Order Exporter] Found', lineItems.length, 'line items');

    for (const item of lineItems) {
      // Handle nested item structures
      const itemData = item.item || item.product || item;
      const name = itemData.name || itemData.productName || itemData.description || itemData.title || '';
      const price = itemData.price || itemData.unitPrice || itemData.salePrice || itemData.linePrice || itemData.itemPrice || '';
      const quantity = itemData.quantity || itemData.qty || item.quantity || 1;

      if (name) {
        let priceStr = '';
        let priceVal = 0;

        if (typeof price === 'number') {
          priceStr = `$${price.toFixed(2)}`;
          priceVal = price;
        } else if (typeof price === 'string') {
          priceStr = price.startsWith('$') ? price : `$${price}`;
          priceVal = parseFloat(String(price).replace(/[$,]/g, '')) || 0;
        } else if (price && typeof price === 'object') {
          // Handle price objects like {amount: 10.99, currency: 'USD'}
          priceVal = price.amount || price.value || price.price || 0;
          priceStr = `$${priceVal.toFixed(2)}`;
        }

        items.push({
          name,
          quantity,
          price: priceStr,
          priceValue: priceVal
        });
        console.log('[Walmart Order Exporter] Added item:', name.substring(0, 40));
      }
    }

    // Extract date from various possible fields
    let orderDate = 'Unknown';
    const dateFields = ['orderDate', 'placedDate', 'date', 'createdDate', 'purchaseDate', 'orderPlacedDate', 'submittedDate'];
    for (const field of dateFields) {
      if (data[field]) {
        orderDate = this.formatDate(data[field]);
        console.log('[Walmart Order Exporter] Found date in field:', field, '=', orderDate);
        break;
      }
    }

    // Extract status
    let status = data.status || data.orderStatus || data.fulfillmentStatus || 'Unknown';
    if (typeof status === 'object') {
      status = status.label || status.name || status.value || 'Unknown';
    }

    // Extract totals
    const subtotal = this.extractPrice(data.subtotal || data.subTotal || data.itemsTotal);
    const tax = this.extractPrice(data.tax || data.taxTotal || data.estimatedTax);
    const total = this.extractPrice(data.total || data.orderTotal || data.grandTotal);

    return {
      orderId,
      orderNumber: data.orderNumber || data.orderId || data.id || orderId,
      orderType: 'online',
      orderDate,
      status,
      items,
      subtotal,
      tax,
      total,
      associateDiscount: '',
      driverTip: '',
      deliveryFee: '',
      expressFee: '',
      storeLocation: { name: '', address: '' }
    };
  }

  /**
   * Format a date value to readable string
   */
  formatDate(dateValue) {
    if (!dateValue) return 'Unknown';

    try {
      // If it's already a readable string like "Jan 15, 2024"
      if (typeof dateValue === 'string' && /[A-Za-z]/.test(dateValue)) {
        return dateValue;
      }

      // Try to parse as date
      const date = new Date(dateValue);
      if (!isNaN(date.getTime())) {
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      }
    } catch (e) {
      // Fall through
    }

    return String(dateValue);
  }

  /**
   * Extract price from various formats
   */
  extractPrice(value) {
    if (!value) return '';

    if (typeof value === 'number') {
      return `$${value.toFixed(2)}`;
    }

    if (typeof value === 'string') {
      return value.startsWith('$') ? value : `$${value}`;
    }

    if (typeof value === 'object') {
      const amount = value.amount || value.value || value.price || 0;
      return `$${Number(amount).toFixed(2)}`;
    }

    return '';
  }

  /**
   * Extract items from DOM elements (more reliable than regex)
   */
  extractItemsFromDOM(doc) {
    const items = [];
    const seen = new Set();

    // Strategy 1: Find product links (most reliable)
    // Walmart product links typically go to /ip/ pages
    const productLinks = doc.querySelectorAll('a[href*="/ip/"]');
    console.log('[Walmart Order Exporter] Found', productLinks.length, 'product links');

    productLinks.forEach(link => {
      const name = link.textContent?.trim();
      if (name && name.length > 5 && name.length < 300 && !seen.has(name)) {
        let price = '';
        let quantity = 1;

        // Traverse up the DOM tree to find a container with price info
        // Walmart's DOM requires going up ~15 levels to find the price
        let container = link;
        for (let i = 0; i < 20 && container; i++) {
          container = container.parentElement;
          if (container) {
            // Look for price element with data-testid="line-price"
            const priceEl = container.querySelector('[data-testid="line-price"]');
            if (priceEl) {
              const priceText = priceEl.textContent || '';
              const priceMatch = priceText.match(/\$(\d+\.\d{2})/);
              if (priceMatch) {
                price = `$${priceMatch[1]}`;
              }

              // Also look for quantity in this container
              const containerText = container.innerText || '';
              const qtyMatch = containerText.match(/Qty\s*(\d+)/i);
              if (qtyMatch) {
                quantity = parseInt(qtyMatch[1]);
              }
              break;
            }
          }
        }

        // Fallback: if no data-testid price found, try regex on larger container
        if (!price && container) {
          const containerText = container.innerText || '';
          const priceMatch = containerText.match(/\$(\d+\.\d{2})/);
          if (priceMatch) {
            price = `$${priceMatch[1]}`;
          }
          const qtyMatch = containerText.match(/Qty\s*(\d+)/i);
          if (qtyMatch) {
            quantity = parseInt(qtyMatch[1]);
          }
        }

        if (this.isValidProductName(name)) {
          seen.add(name);
          items.push({
            name,
            quantity,
            price,
            priceValue: price ? parseFloat(price.replace('$', '')) : 0
          });
          console.log('[Walmart Order Exporter] Added item:', name.substring(0, 40), 'price:', price);
        }
      }
    });

    console.log('[Walmart Order Exporter] Strategy 1 found', items.length, 'items');

    // Strategy 2: If no product links found, try looking for item containers
    if (items.length === 0) {
      // Look for elements that might be product names by their structure
      const allLinks = doc.querySelectorAll('a[data-testid], a[class*="product"], a[class*="item"]');

      allLinks.forEach(link => {
        const name = link.textContent?.trim();
        if (name && name.length > 10 && name.length < 300 && !seen.has(name) && this.isValidProductName(name)) {
          seen.add(name);

          const container = link.closest('div') || link.parentElement;
          let price = '';
          let quantity = 1;

          if (container) {
            const text = container.innerText || '';
            const priceMatch = text.match(/\$(\d+\.\d{2})/);
            if (priceMatch) price = `$${priceMatch[1]}`;

            const qtyMatch = text.match(/Qty\s*(\d+)/i);
            if (qtyMatch) quantity = parseInt(qtyMatch[1]);
          }

          items.push({
            name,
            quantity,
            price,
            priceValue: price ? parseFloat(price.replace('$', '')) : 0
          });
        }
      });
    }

    // Strategy 3: Fallback - find any element with substantial text near a price
    if (items.length === 0) {
      const allElements = doc.querySelectorAll('span, div, p');

      allElements.forEach(el => {
        const text = el.textContent?.trim();
        // Look for elements that look like product names (substantial text, not UI elements)
        if (text &&
            text.length > 15 &&
            text.length < 200 &&
            !text.includes('$') &&
            !text.includes('Qty') &&
            !seen.has(text) &&
            this.isValidProductName(text)) {

          // Check if there's a price nearby
          const parent = el.parentElement;
          if (parent) {
            const parentText = parent.innerText || '';
            const priceMatch = parentText.match(/\$(\d+\.\d{2})/);

            if (priceMatch) {
              seen.add(text);
              items.push({
                name: text,
                quantity: 1,
                price: `$${priceMatch[1]}`,
                priceValue: parseFloat(priceMatch[1])
              });
            }
          }
        }
      });
    }

    return items;
  }

  /**
   * Check if a string is a valid product name
   */
  isValidProductName(name) {
    if (!name || name.length < 5 || name.length > 200) return false;

    const invalidPatterns = [
      /^Subtotal/i,
      /^Total/i,
      /^Tax/i,
      /^Savings/i,
      /^Associate discount/i,
      /^Driver tip/i,
      /^Payment method/i,
      /^Delivery/i,
      /^Address/i,
      /^Order#/i,
      /^Complete,/i,
      /^Current,/i,
      /^Not complete/i,
      /^Placed/i,
      /^Preparing/i,
      /^On the way/i,
      /^Delivered/i,
      /^Return eligible/i,
      /^How can we help/i,
      /^Need more help/i,
      /^Start a return/i,
      /^Track shipment/i,
      /^View delivery/i,
      /^Charge history/i,
      /^Walmart\+/i,
      /^Free delivery/i,
      /^Express\s*\$/i,
      /^Temporary hold/i,
      /^Your payment/i,
      /^Ending in/i,
      // Store purchase specific patterns
      /^TC#/i,
      /^Store purchase/i,
      /^Purchased at/i,
      /^Receipt/i,
      /^Transaction/i,
      /^Store:/i,
      /^Walmart Supercenter/i,
      /^Walmart Neighborhood/i,
      /^Cash back/i,
      /^Change due/i,
      /^Tender/i,
      /^VISA|MASTERCARD|AMEX|DISCOVER/i,
      /^\d+\s+items?$/i
    ];

    for (const pattern of invalidPatterns) {
      if (pattern.test(name)) return false;
    }

    return true;
  }

  /**
   * Check if there's a next page button
   */
  hasNextPage() {
    const nextBtn = document.querySelector('button[aria-label="Next page"]');
    return nextBtn && !nextBtn.disabled;
  }

  /**
   * Click next page and wait for load
   */
  async goToNextPage() {
    const nextBtn = document.querySelector('button[aria-label="Next page"]');
    if (nextBtn && !nextBtn.disabled) {
      nextBtn.click();
      await this.waitForPageUpdate();
      return true;
    }
    return false;
  }

  /**
   * Wait for page content to update after navigation
   */
  waitForPageUpdate() {
    return new Promise(resolve => {
      setTimeout(resolve, 2000);
    });
  }

  /**
   * Wait between requests to avoid rate limiting
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Main export function
   */
  async exportOrders(options = {}) {
    console.log('[Walmart Order Exporter] Starting export with options:', options);

    const {
      includeItems = true,
      allPages = true,
      dateRange = 30,
      orderTypeFilter = 'all',
      fetchItemPrices = false
    } = options;

    this.isExporting = true;
    this.orders = [];
    this.processedOrders = 0;

    // Calculate cutoff date
    let cutoffDate = null;
    if (dateRange !== 'all') {
      cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - dateRange);
    }

    let pageNum = 1;
    let reachedCutoff = false;

    try {
      while (this.isExporting && !reachedCutoff) {
        this.sendProgress({
          label: `Processing page ${pageNum}...`,
          detail: 'Extracting order data from page...'
        });

        // Extract order data directly from the visible page (more reliable than fetching)
        let pageOrders = this.extractOrderDataFromListPage();

        // Fallback: If list extraction found nothing, try fetching individual order pages
        if (pageOrders.length === 0) {
          console.log('[Walmart Order Exporter] List extraction found 0 orders, trying individual fetch fallback');
          this.sendProgress({
            detail: 'Trying fallback method - fetching individual orders...'
          });

          const orderIds = this.getOrderIdsFromPage();
          console.log('[Walmart Order Exporter] Found', orderIds.length, 'order IDs for fallback fetch');

          for (const orderInfo of orderIds) {
            if (!this.isExporting) break;

            this.sendProgress({
              detail: `Fetching order ${orderInfo.orderId}...`
            });

            try {
              const details = await this.fetchOrderDetails(orderInfo);
              if (details && details.orderId) {
                pageOrders.push(details);
                console.log('[Walmart Order Exporter] Fetched order details:', orderInfo.orderId);
              }
            } catch (err) {
              console.error('[Walmart Order Exporter] Failed to fetch order:', orderInfo.orderId, err);
            }

            // Rate limiting
            await this.delay(500);
          }
        }

        if (pageOrders.length === 0) {
          this.sendProgress({
            detail: 'No orders found on this page'
          });
        }

        // Process each order
        for (let i = 0; i < pageOrders.length; i++) {
          if (!this.isExporting) break;

          const orderDetails = pageOrders[i];
          const displayId = orderDetails.orderType === 'store' ? `${orderDetails.orderId} (store)` : orderDetails.orderId;

          this.sendProgress({
            percent: ((this.processedOrders + i) / Math.max(pageOrders.length * pageNum, 1)) * 100,
            detail: `Processing order ${displayId}...`
          });

          console.log('[Walmart Order Exporter] Order', displayId, 'type:', orderDetails.orderType, 'date:', orderDetails.orderDate, 'items:', orderDetails.items?.length || 0);

          // Fetch detailed item prices if requested
          if (fetchItemPrices && includeItems) {
            this.sendProgress({
              detail: `Fetching item prices for order ${displayId}...`
            });

            const isStore = orderDetails.orderType === 'store';
            const fetchResult = await this.fetchDetailedItems(orderDetails.orderId, isStore);
            if (fetchResult) {
              const { items: detailedItems, orderMeta } = fetchResult;
              if (detailedItems && detailedItems.length > 0) {
                orderDetails.items = detailedItems;
                console.log('[Walmart Order Exporter] Updated order with', detailedItems.length, 'detailed items');
              }

              // Update order fields from fetched metadata if available
              if (orderMeta) {
                if (orderMeta.orderDate && orderDetails.orderDate === 'Unknown') {
                  // Normalize the date format (ISO timestamp -> "Jan 22, 2026")
                  orderDetails.orderDate = this.formatDate(orderMeta.orderDate);
                  console.log('[Walmart Order Exporter] Updated order date:', orderDetails.orderDate);
                }
                if (orderMeta.subtotal && !orderDetails.subtotal) {
                  orderDetails.subtotal = orderMeta.subtotal;
                }
                if (orderMeta.tax && !orderDetails.tax) {
                  orderDetails.tax = orderMeta.tax;
                }
                if (orderMeta.total && !orderDetails.total) {
                  orderDetails.total = orderMeta.total;
                }
                // New fields from priceDetails
                if (orderMeta.driverTip) {
                  orderDetails.driverTip = orderMeta.driverTip;
                }
                if (orderMeta.associateDiscount) {
                  orderDetails.associateDiscount = orderMeta.associateDiscount;
                }
                if (orderMeta.deliveryFee) {
                  orderDetails.deliveryFee = orderMeta.deliveryFee;
                }
                if (orderMeta.expressFee) {
                  orderDetails.expressFee = orderMeta.expressFee;
                }
              }
            }

            // Rate limiting delay between fetches
            await this.delay(500);
          }

          // Check date cutoff - but don't stop yet, check all orders on this page
          let includeOrder = true;
          if (cutoffDate && orderDetails.orderDate !== 'Unknown') {
            const orderDate = new Date(orderDetails.orderDate);
            console.log('[Walmart Order Exporter] Date check - Order:', orderDate.toDateString(), 'Cutoff:', cutoffDate.toDateString(), 'Include:', orderDate >= cutoffDate);
            if (orderDate < cutoffDate) {
              includeOrder = false;
              reachedCutoff = true; // Mark that we've seen old orders, stop pagination after this page
            }
          }

          // Check order type filter
          if (includeOrder && orderTypeFilter !== 'all') {
            if (orderTypeFilter === 'online' && orderDetails.orderType === 'store') {
              includeOrder = false;
              console.log('[Walmart Order Exporter] Skipped order (store order, filter is online only)');
            } else if (orderTypeFilter === 'store' && orderDetails.orderType !== 'store') {
              includeOrder = false;
              console.log('[Walmart Order Exporter] Skipped order (online order, filter is store only)');
            }
          }

          if (includeOrder) {
            this.orders.push(orderDetails);
            console.log('[Walmart Order Exporter] Added order to export list');
          } else if (!reachedCutoff) {
            console.log('[Walmart Order Exporter] Skipped order (filtered out)');
          } else {
            console.log('[Walmart Order Exporter] Skipped order (outside date range)');
          }
          this.processedOrders++;
        }

        // Check for next page
        if (allPages && !reachedCutoff && this.hasNextPage() && this.isExporting) {
          this.sendProgress({
            detail: 'Moving to next page...'
          });

          const navigated = await this.goToNextPage();
          if (!navigated) break;

          pageNum++;
          // Small delay to let the page load
          await this.delay(1000);
        } else {
          break;
        }
      }

      this.sendProgress({
        percent: 100,
        label: 'Generating CSV...',
        detail: `Processed ${this.orders.length} orders`
      });

      // Generate CSV
      const csv = this.generateCSV(includeItems);

      const itemCount = this.orders.reduce((sum, order) => sum + (order.items?.length || 0), 0);

      console.log('[Walmart Order Exporter] Export complete:', this.orders.length, 'orders,', itemCount, 'items');
      console.log('[Walmart Order Exporter] CSV length:', csv.length, 'chars');

      return {
        success: true,
        csv,
        orderCount: this.orders.length,
        itemCount
      };

    } catch (error) {
      console.error('[Walmart Order Exporter] Export error:', error);
      return {
        success: false,
        error: error.message
      };
    } finally {
      this.isExporting = false;
    }
  }

  /**
   * Format store location for CSV output
   */
  formatStoreLocation(storeLocation) {
    if (!storeLocation) return '';
    const parts = [];
    if (storeLocation.name) parts.push(storeLocation.name);
    if (storeLocation.address) parts.push(storeLocation.address);
    return parts.join(' - ');
  }

  /**
   * Generate CSV from collected orders
   */
  generateCSV(includeItems = true) {
    const rows = [];

    if (includeItems) {
      // Header for detailed export (new columns added at end for backward compatibility)
      rows.push([
        'Order Number',
        'Order Date',
        'Status',
        'Item Name',
        'Item Price',
        'Quantity',
        'Subtotal',
        'Tax',
        'Order Total',
        'Order Type',
        'Associate Discount',
        'Driver Tip',
        'Delivery Fee',
        'Express Fee',
        'Store Location'
      ].join(','));

      // Data rows
      for (const order of this.orders) {
        const orderType = order.orderType === 'store' ? 'Store' : 'Online';
        const storeLocation = this.formatStoreLocation(order.storeLocation);

        if (order.items && order.items.length > 0) {
          for (const item of order.items) {
            rows.push([
              this.escapeCSV(order.orderNumber || order.orderId),
              this.escapeCSV(order.orderDate),
              this.escapeCSV(order.status),
              this.escapeCSV(item.name),
              this.escapeCSV(item.price),
              item.quantity,
              this.escapeCSV(order.subtotal),
              this.escapeCSV(order.tax),
              this.escapeCSV(order.total),
              this.escapeCSV(orderType),
              this.escapeCSV(order.associateDiscount || ''),
              this.escapeCSV(order.driverTip || ''),
              this.escapeCSV(order.deliveryFee || ''),
              this.escapeCSV(order.expressFee || ''),
              this.escapeCSV(storeLocation)
            ].join(','));
          }
        } else {
          // Order with no items parsed
          rows.push([
            this.escapeCSV(order.orderNumber || order.orderId),
            this.escapeCSV(order.orderDate),
            this.escapeCSV(order.status),
            'No items found',
            '',
            '',
            this.escapeCSV(order.subtotal),
            this.escapeCSV(order.tax),
            this.escapeCSV(order.total),
            this.escapeCSV(orderType),
            this.escapeCSV(order.associateDiscount || ''),
            this.escapeCSV(order.driverTip || ''),
            this.escapeCSV(order.deliveryFee || ''),
            this.escapeCSV(order.expressFee || ''),
            this.escapeCSV(storeLocation)
          ].join(','));
        }
      }
    } else {
      // Header for summary export (new columns added at end)
      rows.push([
        'Order Number',
        'Order Date',
        'Status',
        'Item Count',
        'Subtotal',
        'Tax',
        'Order Total',
        'Order Type',
        'Associate Discount',
        'Driver Tip',
        'Delivery Fee',
        'Express Fee',
        'Store Location'
      ].join(','));

      // Data rows
      for (const order of this.orders) {
        const orderType = order.orderType === 'store' ? 'Store' : 'Online';
        const storeLocation = this.formatStoreLocation(order.storeLocation);

        rows.push([
          this.escapeCSV(order.orderNumber || order.orderId),
          this.escapeCSV(order.orderDate),
          this.escapeCSV(order.status),
          order.items?.length || 0,
          this.escapeCSV(order.subtotal),
          this.escapeCSV(order.tax),
          this.escapeCSV(order.total),
          this.escapeCSV(orderType),
          this.escapeCSV(order.associateDiscount || ''),
          this.escapeCSV(order.driverTip || ''),
          this.escapeCSV(order.deliveryFee || ''),
          this.escapeCSV(order.expressFee || ''),
          this.escapeCSV(storeLocation)
        ].join(','));
      }
    }

    return rows.join('\n');
  }

  /**
   * Escape a value for CSV
   */
  escapeCSV(value) {
    if (value === null || value === undefined) return '';

    const str = String(value);

    // If contains comma, quote, or newline, wrap in quotes and escape internal quotes
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }

    return str;
  }

  /**
   * Stop the export process
   */
  stopExport() {
    this.isExporting = false;
  }
}

// Initialize exporter instance
const exporter = new WalmartOrderExporter();

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'START_EXPORT') {
    // Run export asynchronously
    exporter.exportOrders(request.options)
      .then(result => {
        // Trigger download directly from content script (more reliable)
        if (result.success && result.csv && result.orderCount > 0) {
          const date = new Date().toISOString().split('T')[0];
          const filename = `walmart_orders_${date}.csv`;
          triggerDownload(result.csv, filename);
        }
        sendResponse(result);
      })
      .catch(error => {
        sendResponse({
          success: false,
          error: error.message
        });
      });

    // Return true to indicate async response
    return true;
  }

  if (request.type === 'STOP_EXPORT') {
    exporter.stopExport();
    sendResponse({ success: true });
    return false;
  }

  if (request.type === 'CHECK_PAGE') {
    sendResponse({
      isOrdersPage: window.location.href.includes('/orders')
    });
    return false;
  }
});

/**
 * Trigger download directly from content script
 */
function triggerDownload(csvContent, filename) {
  console.log('[Walmart Order Exporter] Triggering download:', filename, 'size:', csvContent.length);

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  setTimeout(() => URL.revokeObjectURL(url), 1000);
  console.log('[Walmart Order Exporter] Download triggered');
}

// Log that content script is loaded
console.log('[Walmart Order Exporter] Content script loaded on:', window.location.href);
