// ==UserScript==
// @name         Torn Trading Profit Calculator
// @namespace    http://tampermonkey.net/
// @version       25.0
// @description  Trade profit calculator with profit-only view and round-trip flight-time profit/hr.
// @author       motherBarker (and China)
// @match        https://www.torn.com/trade.php*
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// ==/UserScript==

(function () {
  "use strict";

  // ========== CONFIG ==========
  const CONFIG = {
    apiKey: "SS0qVkxXKa2tX5jW", // <-- Full Access required
    feeAnonymous: 0.15, // anonymity (10%) + listing fee (5%)
    feeStandard: 0.05, // listing fee only (5%)
    defaultDiscount: 100, // discount per unit to sell faster
    defaultTravelMethod: "standard", // 'standard' or 'pilot'
    defaultFlightMinutes: 33, // one-way flight time (min) fallback; round-trip = ×2
    // Round-trip travel costs (standard) — exactly the list provided.
    travelCosts: {
      mexico: 6500,
      "ciudad juárez": 6500,
      "ciudad juarez": 6500,
      "cayman islands": 10000,
      "george town": 10000,
      canada: 9000,
      toronto: 9000,
      hawaii: 11000,
      honolulu: 11000,
      "united kingdom": 18000,
      uk: 18000,
      london: 18000,
      argentina: 21000,
      "buenos aires": 21000,
      switzerland: 27000,
      zurich: 27000,
      japan: 32000,
      tokyo: 32000,
      china: 35000,
      beijing: 35000,
      "united arab emirates": 32000,
      uae: 32000,
      dubai: 32000,
      "south africa": 40000,
      johannesburg: 40000,
    },
    // One-way flight times (MINUTES) for STANDARD travel — the table you provided.
    // Round trip = 2 × one-way. Keys match travelCosts.
    flightTimes: {
      mexico: 24,
      "ciudad juárez": 24,
      "ciudad juarez": 24,
      "cayman islands": 33,
      "george town": 33,
      canada: 39,
      toronto: 39,
      hawaii: 127,
      honolulu: 127,
      "united kingdom": 151,
      uk: 151,
      london: 151,
      argentina: 158,
      "buenos aires": 158,
      switzerland: 166,
      zurich: 166,
      japan: 213,
      tokyo: 213,
      china: 229,
      beijing: 229,
      "united arab emirates": 257,
      uae: 257,
      dubai: 257,
      "south africa": 282,
      johannesburg: 282,
    },
    // Numeric country IDs used by travel / Item-abroad-buy logs (the `area` field).
    // 1 = Torn City (home); 3 = Hawaii (confirmed from this account's logs).
    // More are auto-learned from your own 'Travel depart' + 'Travel fee' logs.
    countryIds: {
      1: "Torn City",
      3: "Hawaii",
    },
    cacheDuration: 3600000, // 1 hour market cache
    debug: true,
  };

  // ========== PERSISTENT GLOBAL STATE ==========
  let discountPerUnit = CONFIG.defaultDiscount; // 100
  let travelMethod = CONFIG.defaultTravelMethod; // 'standard'
  let includeTravelCost = true; // travel considered by default

  // Latest fetched data, held in memory so control changes recompute instantly
  // (no API refetch on every keystroke).
  let lastData = null; // { tradeItems, market, purchase, learnedCosts }

  let panelMinimized = false;
  let panelContainer = null;
  let statsContainer = null;
  let updateSeq = 0; // race guard
  let calcLoading = false; // one API load at a time
  let lastCalcAt = 0; // rate-limit timestamp for full loads

  function log(...args) {
    if (CONFIG.debug) console.log("[Trade Profit]", ...args);
  }

  // ========== API HELPER ==========
  function apiRequest(endpoint, selections) {
    return new Promise((resolve, reject) => {
      const url = `https://api.torn.com/${endpoint}?selections=${selections}&key=${CONFIG.apiKey}`;
      GM_xmlhttpRequest({
        method: "GET",
        url: url,
        onload: function (resp) {
          try {
            const data = JSON.parse(resp.responseText);
            if (data.error) {
              reject(`API Error: ${data.error.error || JSON.stringify(data.error)}`);
            } else {
              resolve(data);
            }
          } catch (e) {
            reject(`Parse error: ${e.message}`);
          }
        },
        onerror: function (err) {
          reject(`Network error: ${err}`);
        },
      });
    });
  }

  // API v2 helper (path like "torn/258,259/items").
  function apiV2(path) {
    return new Promise((resolve, reject) => {
      const url = `https://api.torn.com/v2/${path}?key=${CONFIG.apiKey}`;
      GM_xmlhttpRequest({
        method: "GET",
        url: url,
        onload: function (resp) {
          try {
            const data = JSON.parse(resp.responseText);
            if (data.error) {
              reject(`API Error: ${data.error.error || JSON.stringify(data.error)}`);
            } else {
              resolve(data);
            }
          } catch (e) {
            reject(`Parse error: ${e.message}`);
          }
        },
        onerror: function (err) {
          reject(`Network error: ${err}`);
        },
      });
    });
  }

  // ========== TRADE ID ==========
  function getTradeIdFromURL() {
    const url = new URL(window.location.href);
    const id = url.searchParams.get("ID") || url.searchParams.get("id");
    if (id) return parseInt(id);
    const match = url.hash.match(/ID=(\d+)/);
    if (match) return parseInt(match[1]);
    // PDA / mobile hash-route fallback, e.g. #/trade/123456 or #/trades/123456.
    const routeMatch = url.hash.match(/\/trades?\/(\d+)/i);
    if (routeMatch) return parseInt(routeMatch[1]);
    return null;
  }

  function extractTradeIdFromLog(data) {
    if (data.parsed_trade_id) return parseInt(data.parsed_trade_id);
    if (data.trade_id) {
      const str = String(data.trade_id);
      const m = str.match(/ID=(\d+)/);
      if (m) return parseInt(m[1]);
    }
    return null;
  }

  // ========== GET TRADE ITEMS FROM LOGS ==========
  function getTradeItemsFromLogs(logs, tradeId) {
    const myItems = {},
      theirItems = {};
    let myCash = 0,
      theirCash = 0;

    const entries = Object.entries(logs).sort((a, b) => a[1].timestamp - b[1].timestamp);

    for (const [, entry] of entries) {
      const data = entry.data || {};
      if (extractTradeIdFromLog(data) !== tradeId) continue;

      const title = entry.title || "";

      if (title === "Trade items add" || title === "Trade items add other user") {
        const target = title === "Trade items add" ? myItems : theirItems;
        for (const it of data.items || []) {
          const iid = it.id ?? it.item_id;
          const qty = it.qty ?? it.quantity ?? 1;
          target[iid] = (target[iid] || 0) + qty;
        }
      } else if (title === "Trade items remove" || title === "Trade items remove other user") {
        const target = title === "Trade items remove" ? myItems : theirItems;
        for (const it of data.items || []) {
          const iid = it.id ?? it.item_id;
          const qty = it.qty ?? it.quantity ?? 1;
          target[iid] = (target[iid] || 0) - qty;
          if (target[iid] <= 0) delete target[iid];
        }
      } else if (title === "Trade money add") {
        myCash += data.money || 0;
      } else if (title === "Trade money add other user") {
        theirCash += data.money || 0;
      }
    }

    return {
      myItems: Object.entries(myItems).map(([id, qty]) => ({
        itemId: parseInt(id),
        quantity: qty,
      })),
      theirItems: Object.entries(theirItems).map(([id, qty]) => ({
        itemId: parseInt(id),
        quantity: qty,
      })),
      myCash,
      theirCash,
    };
  }

  // ========== ITEM DETAILS (v2) ==========
  // Uses the per-item v2 endpoint which returns market_price (average), sell_price
  // (city-shop buy price), buy_price, and the vendor country+shop (where it is sold).
  async function fetchItemDetails(itemIds) {
    const ids = [...new Set(itemIds)].filter(Boolean);
    const market = {};
    const chunkSize = 50;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize).join(",");
      let data;
      try {
        data = await apiV2(`torn/${chunk}/items`);
      } catch (e) {
        log(`Item details fetch error for ${chunk}: ${e.message || e}`);
        continue;
      }
      for (const it of data.items || []) {
        const v = it.value || {};
        const vdr = v.vendor || {};
        market[it.id] = {
          name: it.name || `Item #${it.id}`,
          marketPrice: parseFloat(v.market_price) || 0,
          sellPrice: parseFloat(v.sell_price) || 0,
          buyPrice: parseFloat(v.buy_price) || 0,
          country: vdr.country || null,
          shop: vdr.name || null,
        };
      }
    }
    log(`Item details fetched for ${Object.keys(market).length} items.`);
    return market;
  }

  // ========== PURCHASE INFO FROM LOGS ==========
  // For each item we care about, find the most recent purchase log.
  //       'Item abroad buy' -> abroad: true, area = country ID (travel cost applies)
  //       'Item shop buy'   -> abroad: false, area = shop ID (no travel cost)
  function collectPurchaseInfo(logs, myItemIds) {
    const want = new Set(myItemIds);
    const prices = {}; // itemId -> { price, area, abroad, timestamp }
    for (const entry of Object.values(logs)) {
      const title = entry.title || "";
      const isAbroad = title === "Item abroad buy";
      const isShop = title === "Item shop buy";
      if (!isAbroad && !isShop) continue;
      const d = entry.data || {};
      const itemId = parseInt(d.item ?? d.item_id ?? d.itemID);
      if (!itemId || !want.has(itemId)) continue;
      const price = parseInt(d.cost_each ?? d.price ?? d.cost);
      const prev = prices[itemId];
      if (!prev || entry.timestamp > prev.timestamp) {
        prices[itemId] = {
          price: price > 0 ? price : 0,
          area: d.area ?? null,
          abroad: isAbroad,
          timestamp: entry.timestamp,
        };
      }
    }
    return prices;
  }

  // ========== TRAVEL COST ==========
  // Learns the round-trip cost per destination country from the user's own travel logs.
  //  'Travel depart' -> { origin, destination, travel_method, duration }
  //  'Travel fee'    -> { cost }
  // Torn trips are always: Torn -> country -> Torn (destination 1 = home, ignored).
  function learnTravelCosts(logs) {
    const learned = {}; // destinationId -> cost
    const sorted = Object.values(logs).sort((a, b) => a.timestamp - b.timestamp);
    let lastStandardDepart = null; // { destination }
    for (const entry of sorted) {
      const title = entry.title || "";
      const d = entry.data || {};
      if (title === "Travel depart" && (d.travel_method || "standard") === "standard") {
        lastStandardDepart = { destination: d.destination };
      } else if (title === "Travel fee" && lastStandardDepart) {
        const dest = lastStandardDepart.destination;
        const cost = parseInt(d.cost);
        if (dest && dest != 1 && !isNaN(cost) && cost > 0) {
          learned[dest] = cost;
        }
      }
    }
    return learned;
  }

  // ========== FLIGHT TIME ==========
  // Learns the one-way flight time (minutes) per destination from 'Travel depart' logs.
  // A round trip = 2 × one-way. Falls back to the config default.
  function learnTravelDurations(logs) {
    const learned = {}; // destinationId -> one-way minutes
    for (const entry of Object.values(logs)) {
      const d = entry.data || {};
      if ((entry.title || "") === "Travel depart" && d.destination) {
        const dur = parseInt(d.duration);
        if (d.destination != 1 && !isNaN(dur) && dur > 0) {
          learned[d.destination] = dur;
        }
      }
    }
    return learned;
  }

  // Resolve a country ID -> { name, cost } (round-trip, standard).
  function getTravelInfo(countryId, learned) {
    const id = String(countryId);
    let name = CONFIG.countryIds[id] || null;

    // Prefer the learned actual round-trip fare, else the constant for the known name.
    let cost =
      learned && learned[id] != null
        ? learned[id]
        : name && CONFIG.travelCosts[name.toLowerCase()] != null
          ? CONFIG.travelCosts[name.toLowerCase()]
          : null;

    // Try to infer the name from the cost (only when it uniquely matches one destination).
    if (!name && cost != null) {
      const matches = Object.entries(CONFIG.travelCosts).filter(
        ([k, v]) => v === cost && !/[^a-z ]/.test(k),
      );
      const unique = [...new Set(matches.map((m) => m[0].toLowerCase()))];
      if (unique.length === 1) name = unique[0];
    }
    return { name: name || `Country ${countryId}`, cost };
  }

  // ========== CALCULATE PROFIT ==========
  function calculateProfit(tradeItems, market, purchase, learned, learnedDurations) {
    const { myItems, theirItems, myCash, theirCash } = tradeItems;

    // --- Your side: cost basis ---
    const myItemsDetail = [];
    const travelByCountry = new Map(); // destination name(lower) -> round-trip cost
    let oneWayMinutes = CONFIG.defaultFlightMinutes; // learned/fallback one-way flight (min)
    let totalItemCost = 0;

    for (const item of myItems) {
      const m = market[item.itemId] || {
        name: `Item #${item.itemId}`,
        marketPrice: 0,
        sellPrice: 0,
        buyPrice: 0,
        country: null,
        shop: null,
      };
      const pur = purchase[item.itemId];
      const qty = item.quantity;

      let costEach = 0,
        costSource = "none",
        locationName = null,
        shopName = null;
      if (pur && pur.price > 0) {
        costEach = pur.price;
        if (pur.abroad) {
          // Bought overseas: the v2 item data tells us which country directly.
          let destCost = null,
            destName = null;
          if (m.country) {
            const key = m.country.toLowerCase();
            if (CONFIG.travelCosts[key] != null) destCost = CONFIG.travelCosts[key];
            destName = m.country;
          }
          // Fallback: map the numeric area ID from the log.
          if (destCost == null && pur.area) {
            const info = getTravelInfo(pur.area, learned);
            destCost = info.cost;
            destName = info.name;
          }
          costSource = "abroad";
          locationName = destName || m.country || `Country ${pur.area}`;
          shopName = m.shop || null;
          travelByCountry.set(locationName.toLowerCase(), destCost);
          // One-way flight time (standard): prefer the config table, else learned log.
          if (destName) {
            const fk = destName.toLowerCase();
            if (CONFIG.flightTimes[fk] != null) {
              oneWayMinutes = Math.max(oneWayMinutes, CONFIG.flightTimes[fk]);
            }
          }
          if (pur.area && learnedDurations && learnedDurations[String(pur.area)] != null) {
            oneWayMinutes = Math.max(oneWayMinutes, learnedDurations[String(pur.area)]);
          }
        } else {
          costSource = "shop";
          locationName = m.shop ? `Torn (${m.shop})` : "Torn (city shop)";
        }
      } else if (m.buyPrice > 0) {
        // No purchase log recoverable — fall back to the item's city-shop buy price.
        costEach = m.buyPrice;
        costSource = "buy";
        shopName = m.shop || null;
      }

      totalItemCost += costEach * qty;
      myItemsDetail.push({
        itemId: item.itemId,
        name: m.name,
        quantity: qty,
        marketPrice: m.marketPrice,
        sellPrice: m.sellPrice,
        costEach,
        costSource,
        locationName,
        shopName,
      });
    }

    // Travel cost: summed once per unique overseas destination,
    // but only in standard mode and only when included.
    let travelCost = 0;
    const travelDetail = [];
    for (const [name, cost] of travelByCountry) {
      if (cost != null) travelCost += cost;
      travelDetail.push({ name, cost });
    }

    const effectiveTravelCost = travelMethod === "pilot" || !includeTravelCost ? 0 : travelCost;

    const totalCost = myCash + totalItemCost + effectiveTravelCost;
    // Cost basis for selling your items (you keep your cash if you DON'T trade).
    const sellCostBasis = totalItemCost + effectiveTravelCost;

    // --- Their side: offer value ---
    const theirItemsDetail = [];
    let theirItemsMarketValue = 0;
    for (const item of theirItems) {
      const m = market[item.itemId] || {
        name: `Item #${item.itemId}`,
        marketPrice: 0,
        sellPrice: 0,
      };
      const qty = item.quantity;
      theirItemsMarketValue += m.marketPrice * qty;
      theirItemsDetail.push({
        itemId: item.itemId,
        name: m.name,
        quantity: qty,
        marketPrice: m.marketPrice,
      });
    }
    const theirOfferValue = theirCash + theirItemsMarketValue;

    // --- Trade net ---
    const tradeNet = theirOfferValue - totalCost;
    const tradePercent = totalCost > 0 ? (tradeNet / totalCost) * 100 : 0;

    // --- Round-trip profit estimate (flight time; round trip = 2 × one-way) ---
    const roundTripMinutes = oneWayMinutes * 2;
    const profitPerTrip = tradeNet;
    const profitPerHour = roundTripMinutes > 0 ? tradeNet / (roundTripMinutes / 60) : null;

    // --- Sell YOUR items instead (option B) ---
    const discount = discountPerUnit;
    let proceedsAnon = 0,
      proceedsStd = 0,
      proceedsShop = 0,
      shopSellable = false;
    for (const it of myItemsDetail) {
      const base = Math.max(0, it.marketPrice - discount);
      const qty = it.quantity;
      proceedsAnon += base * (1 - CONFIG.feeAnonymous) * qty;
      proceedsStd += base * (1 - CONFIG.feeStandard) * qty;
      if (it.sellPrice > 0) {
        proceedsShop += it.sellPrice * qty;
        shopSellable = true;
      }
    }

    const netAnon = proceedsAnon - sellCostBasis;
    const netStd = proceedsStd - sellCostBasis;
    const netShop = proceedsShop - sellCostBasis;
    const pctAnon = sellCostBasis > 0 ? (netAnon / sellCostBasis) * 100 : 0;
    const pctStd = sellCostBasis > 0 ? (netStd / sellCostBasis) * 100 : 0;
    const pctShop = sellCostBasis > 0 ? (netShop / sellCostBasis) * 100 : 0;

    return {
      totalCost,
      totalItemCost,
      travelCost: effectiveTravelCost,
      myCash,
      theirCash,
      theirItemsMarketValue,
      theirOfferValue,
      tradeNet,
      tradePercent,
      proceedsAnon,
      netAnon,
      pctAnon,
      proceedsStd,
      netStd,
      pctStd,
      proceedsShop,
      netShop,
      pctShop,
      shopSellable,
      myItems: myItemsDetail,
      theirItems: theirItemsDetail,
      travelDetail,
      roundTripMinutes,
      profitPerTrip,
      profitPerHour,
    };
  }

  // ========== UI PANEL (persistent controls) ==========
  function buildPanel() {
    const existing = document.getElementById("trade-profit-display");
    if (existing) {
      panelContainer = existing;
      statsContainer = document.getElementById("trade-profit-stats");
      return;
    }

    const container = document.createElement("div");
    container.id = "trade-profit-display";
    container.style.cssText = `
            position: fixed; bottom: 20px; left: 20px; z-index: 9999;
            background: rgba(0,0,0,0.92); color: #fff; border-radius: 8px;
            font-size: 14px; font-family: Arial, sans-serif;
            width: min(680px, calc(100vw - 40px)); box-sizing: border-box;
            box-shadow: 0 4px 12px rgba(0,0,0,0.6); border-left: 4px solid #555;
            overflow: hidden; transition: max-height 0.3s ease;
        `;
    panelContainer = container;

    // Header
    const header = document.createElement("div");
    header.style.cssText = `
            display: flex; justify-content: space-between; align-items: center;
            padding: 8px 15px; background: rgba(255,255,255,0.05);
            border-bottom: 1px solid rgba(255,255,255,0.1);
        `;
    const title = document.createElement("span");
    title.style.cssText = "font-weight: bold; font-size: 15px; color: #4fc3f7;";
    title.textContent = "📊 Trade Profit";
    const toggleBtn = document.createElement("button");
    toggleBtn.textContent = "➖";
    toggleBtn.style.cssText =
      "background:none;border:none;color:#aaa;font-size:16px;cursor:pointer;padding:0 6px;line-height:1;";

    // Collapse/expand. When minimized the panel becomes a single compact, draggable
    // icon (just 📊) that you tap to expand; when expanded it's the full fluid panel.
    function setMinimized(min) {
      panelMinimized = !!min;
      const b = document.getElementById("trade-profit-body");
      if (b) b.style.display = panelMinimized ? "none" : "block";

      if (panelMinimized) {
        // Compact icon: a small square showing only 📊.
        toggleBtn.style.display = "none";
        title.textContent = "📊";
        title.style.fontSize = "20px";
        title.style.lineHeight = "1";
        header.style.cssText =
          "display:flex; justify-content:center; align-items:center; padding:0; background:none; border-bottom:none; height:44px; width:44px; cursor:grab;";
        container.style.setProperty("width", "44px", "important");
        container.style.setProperty("height", "44px", "important");
        container.style.setProperty("min-width", "0", "important");
        container.style.setProperty("padding", "0", "important");
        container.style.setProperty("border-left", "none", "important");
        container.style.setProperty("border", "1px solid rgba(255,255,255,0.25)", "important");
        container.style.setProperty("border-radius", "50%", "important");
      } else {
        // Full expanded panel.
        toggleBtn.style.display = "";
        title.textContent = "📊 Trade Profit";
        title.style.fontSize = "15px";
        title.style.lineHeight = "";
        header.style.cssText =
          "display:flex; justify-content:space-between; align-items:center; padding:8px 15px; background:rgba(255,255,255,0.05); border-bottom:1px solid rgba(255,255,255,0.1); cursor:grab;";
        container.style.removeProperty("width");
        container.style.removeProperty("height");
        container.style.removeProperty("min-width");
        container.style.removeProperty("padding");
        container.style.removeProperty("border-left");
        container.style.removeProperty("border");
        container.style.removeProperty("border-radius");
      }
    }
    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setMinimized(!panelMinimized);
    });

    // ---- Movable panel / minimized icon (drag to reposition; position is remembered) ----
    const POS_KEY = "tppPanelPos";
    function enableDrag(el) {
      el.style.cursor = "grab";
      el.addEventListener("pointerdown", (e) => {
        if (e.target.closest && e.target.closest("button, input, select, a, label")) return;
        e.preventDefault();
        const startX = e.clientX;
        const startY = e.clientY;
        const rect = container.getBoundingClientRect();
        const startLeft = rect.left;
        const startTop = rect.top;
        let moved = false; // distinguish a tap (expand) from a drag (move)
        el.setPointerCapture(e.pointerId);
        const onMove = (ev) => {
          if (Math.abs(ev.clientX - startX) > 5 || Math.abs(ev.clientY - startY) > 5) moved = true;
          const w = rect.width;
          const h = rect.height;
          let left = startLeft + (ev.clientX - startX);
          let top = startTop + (ev.clientY - startY);
          const maxLeft = Math.max(0, window.innerWidth - w);
          const maxTop = Math.max(0, window.innerHeight - h);
          left = Math.max(0, Math.min(maxLeft, left));
          top = Math.max(0, Math.min(maxTop, top));
          container.style.setProperty("left", left + "px", "important");
          container.style.setProperty("top", top + "px", "important");
          container.style.setProperty("bottom", "auto", "important");
          container.style.setProperty("right", "auto", "important");
        };
        const onUp = () => {
          el.removeEventListener("pointermove", onMove);
          el.removeEventListener("pointerup", onUp);
          el.removeEventListener("pointercancel", onUp);
          el.style.cursor = "grab";
          if (!moved && panelMinimized) {
            // Tapped the minimized icon (no real drag) -> expand.
            setMinimized(false);
          } else if (moved) {
            try {
              const r = container.getBoundingClientRect();
              localStorage.setItem(
                POS_KEY,
                JSON.stringify({
                  left: Math.round(r.left),
                  top: Math.round(r.top),
                }),
              );
            } catch (err) {
              /* storage unavailable */
            }
          }
        };
        el.style.cursor = "grabbing";
        el.addEventListener("pointermove", onMove);
        el.addEventListener("pointerup", onUp);
        el.addEventListener("pointercancel", onUp);
      });
    }
    enableDrag(header);
    header.appendChild(title);
    header.appendChild(toggleBtn);
    container.appendChild(header);

    // Body
    const body = document.createElement("div");
    body.id = "trade-profit-body";
    body.style.cssText = "padding: 12px 15px 15px 15px;";

    // --- Controls (built once, never rebuilt => inputs persist) ---
    const controls = document.createElement("div");
    controls.style.cssText = `
            display:flex; flex-wrap:wrap; gap:8px; margin-bottom:10px; align-items:center;
            background: rgba(255,255,255,0.05); padding:6px 8px; border-radius:4px;
        `;

    const lbl1 = document.createElement("span");
    lbl1.style.cssText = "color:#aaa;font-size:12px;";
    lbl1.textContent = "Discount:";
    const discountInput = document.createElement("input");
    discountInput.type = "number";
    discountInput.min = 0;
    discountInput.step = 10;
    discountInput.value = discountPerUnit;
    discountInput.style.cssText =
      "width:60px;padding:2px 4px;background:#222;color:#fff;border:1px solid #555;border-radius:4px;font-size:12px;";
    discountInput.addEventListener("change", () => {
      const v = parseInt(discountInput.value);
      if (!isNaN(v) && v >= 0) discountPerUnit = v;
    });
    controls.appendChild(lbl1);
    controls.appendChild(discountInput);

    const lbl2 = document.createElement("span");
    lbl2.style.cssText = "color:#aaa;font-size:12px;margin-left:8px;";
    lbl2.textContent = "Travel:";
    const travelSelect = document.createElement("select");
    travelSelect.style.cssText =
      "background:#222;color:#fff;border:1px solid #555;border-radius:4px;padding:2px 4px;font-size:12px;";
    const op1 = document.createElement("option");
    op1.value = "standard";
    op1.textContent = "Standard";
    const op2 = document.createElement("option");
    op2.value = "pilot";
    op2.textContent = "Pilot (free)";
    travelSelect.appendChild(op1);
    travelSelect.appendChild(op2);
    travelSelect.value = travelMethod;
    travelSelect.addEventListener("change", () => {
      travelMethod = travelSelect.value;
    });
    controls.appendChild(lbl2);
    controls.appendChild(travelSelect);

    const includeCheck = document.createElement("input");
    includeCheck.type = "checkbox";
    includeCheck.checked = includeTravelCost;
    includeCheck.style.cssText = "margin-left:8px;";
    includeCheck.addEventListener("change", () => {
      includeTravelCost = includeCheck.checked;
    });
    const lbl3 = document.createElement("span");
    lbl3.style.cssText = "color:#aaa;font-size:12px;";
    lbl3.textContent = "Add travel cost";
    controls.appendChild(includeCheck);
    controls.appendChild(lbl3);

    const calcBtn = document.createElement("button");
    calcBtn.id = "trade-calc-btn";
    calcBtn.textContent = "🔄 Calculate Trade";
    calcBtn.style.cssText =
      "margin-left:auto;padding:4px 12px;background:#28a745;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;";
    calcBtn.addEventListener("click", onCalculate);
    controls.appendChild(calcBtn);

    body.appendChild(controls);

    // Stats container (only this is re-rendered on update)
    const stats = document.createElement("div");
    stats.id = "trade-profit-stats";
    stats.innerHTML =
      '<div style="color:#aaa;padding:2px 0;">Trade detected — click <b>Calculate Trade</b> to analyze it.</div>';
    body.appendChild(stats);

    container.appendChild(body);

    // Responsive styles — inline styles can't carry media queries, so inject a CSS block.
    const styleEl = document.createElement("style");
    styleEl.textContent = `
            #trade-profit-display { max-width: 100vw; }
            #trade-profit-display .tpp-row { flex-wrap: wrap; gap: 6px; }
            @media (max-width: 640px) {
                #trade-profit-display {
                    top: 8px !important; left: 8px !important; bottom: auto !important;
                    width: calc(100vw - 16px) !important; max-width: none !important;
                    font-size: 12px !important;
                }
                #trade-profit-display #trade-profit-body { padding: 10px 12px 12px !important; }
            }
        `;
    document.head.appendChild(styleEl);

    document.body.appendChild(container);
    statsContainer = stats;
    panelContainer = container;
    container.style.borderLeftColor = "#555";

    // Start collapsed on small/mobile screens so the panel stays out of the way
    // (top-left) and doesn't cover the trade page or the bottom chat bar.
    if (window.matchMedia && window.matchMedia("(max-width: 640px)").matches) setMinimized(true);

    // Restore the panel's last dragged position, if any.
    try {
      const saved = localStorage.getItem(POS_KEY);
      if (saved) {
        const p = JSON.parse(saved);
        if (typeof p.left === "number" && typeof p.top === "number") {
          container.style.setProperty("left", p.left + "px", "important");
          container.style.setProperty("top", p.top + "px", "important");
          container.style.setProperty("bottom", "auto", "important");
          container.style.setProperty("right", "auto", "important");
        }
      }
    } catch (err) {
      /* ignore */
    }
  }

  const fmt = (n) => (n >= 0 ? "+" : "") + "$" + Math.round(n).toLocaleString();
  const money = (n) => "$" + Math.round(n).toLocaleString();

  function renderStats(result) {
    if (!statsContainer || !result) return;

    const color = result.tradeNet >= 0 ? "#28a745" : "#dc3545";
    if (panelContainer) panelContainer.style.borderLeftColor = color;

    const rows = (items, showCost) =>
      items
        .map((it) => {
          let costText = "";
          if (showCost) {
            if (it.costSource === "abroad")
              costText = ` bought ${money(it.costEach)} from ${it.locationName}${it.shopName ? ` (${it.shopName})` : ""}`;
            else if (it.costSource === "shop") costText = ` bought ${money(it.costEach)} in Torn`;
            else if (it.costSource === "buy")
              costText = ` cost est. ${money(it.costEach)} (buy price)`;
            else costText = " no cost (not purchased)";
          }
          const shopMark = it.sellPrice > 0 ? "" : " [not sold in shops]";
          return `<div style="color:#aaa;font-size:12px;">${it.name} ×${it.quantity} @ ${money(it.marketPrice)}${costText}${shopMark}</div>`;
        })
        .join("");

    const travelLine = result.travelCost > 0 ? `Travel: ${money(result.travelCost)}` : "Travel: $0";

    const shopLine = result.shopSellable
      ? `<div class="tpp-row" style="display:flex;justify-content:space-between;margin-bottom:3px;">
                 <span style="color:#aaa;">City shop:</span>
                 <span style="font-weight:bold;color:${result.netShop >= 0 ? "#28a745" : "#dc3545"};">
                   ${money(result.proceedsShop)} (${fmt(result.netShop)}, ${result.pctShop.toFixed(2)}%)
                 </span>
               </div>`
      : `<div class="tpp-row" style="display:flex;justify-content:space-between;margin-bottom:3px;">
                 <span style="color:#aaa;">City shop:</span>
                 <span style="color:#888;">not sold in shops</span>
               </div>`;

    const tripColor = result.tradeNet >= 0 ? "#28a745" : "#dc3545";
    const rtMin = result.roundTripMinutes || 0;
    const perHour = result.profitPerHour;

    let html = `
            <div class="tpp-row" style="display:flex;justify-content:space-between;align-items:center;background:rgba(40,167,69,0.15);border:1px solid ${tripColor};border-radius:4px;padding:6px 8px;margin-bottom:8px;">
                <span style="color:#fff;font-weight:bold;">💸 Profit (gained):</span>
                <span style="font-size:16px;font-weight:bold;color:${tripColor};">${fmt(result.tradeNet)}</span>
            </div>
            <div class="tpp-row" style="display:flex;justify-content:space-between;margin-bottom:3px;">
                <span style="color:#aaa;">Your Cost:</span>
                <span style="font-weight:bold;">${money(result.totalCost)}</span>
            </div>
            <div class="tpp-row" style="display:flex;justify-content:space-between;margin-bottom:3px;font-size:13px;color:#888;">
                <span>Items: ${money(result.totalItemCost)}</span>
                <span>${travelLine}</span>
                <span>Cash: ${money(result.myCash)}</span>
            </div>
            <div class="tpp-row" style="display:flex;justify-content:space-between;margin-bottom:3px;border-top:1px solid #444;padding-top:4px;">
                <span style="color:#aaa;">They offer (cash+items):</span>
                <span style="font-weight:bold;">${money(result.theirOfferValue)}</span>
            </div>
            <div class="tpp-row" style="display:flex;justify-content:space-between;margin-bottom:3px;font-size:13px;color:#888;">
                <span>Cash: ${money(result.theirCash)}</span>
                <span>Items Market: ${money(result.theirItemsMarketValue)}</span>
            </div>
            <div class="tpp-row" style="display:flex;justify-content:space-between;margin-bottom:3px;border-top:1px solid #444;padding-top:4px;">
                <span style="color:#aaa;font-weight:bold;">Trade Net:</span>
                <span style="font-weight:bold;color:${color};">${fmt(result.tradeNet)} (${result.tradePercent.toFixed(2)}%)</span>
            </div>
            <div style="border-top:1px solid #444;padding-top:4px;margin-top:4px;">
                <div style="color:#888;font-size:12px;margin-bottom:3px;">If you sell YOUR items instead:</div>
                <div class="tpp-row" style="display:flex;justify-content:space-between;margin-bottom:3px;">
                    <span style="color:#aaa;">Item Market (anon 15%):</span>
                    <span style="font-weight:bold;color:${result.netAnon >= 0 ? "#28a745" : "#dc3545"};">
                        ${money(result.proceedsAnon)} (${fmt(result.netAnon)}, ${result.pctAnon.toFixed(2)}%)
                    </span>
                </div>
                <div class="tpp-row" style="display:flex;justify-content:space-between;margin-bottom:3px;">
                    <span style="color:#aaa;">Item Market (standard 5%):</span>
                    <span style="font-weight:bold;color:${result.netStd >= 0 ? "#28a745" : "#dc3545"};">
                        ${money(result.proceedsStd)} (${fmt(result.netStd)}, ${result.pctStd.toFixed(2)}%)
                    </span>
                </div>
                ${shopLine}
            </div>
        `;

    if (result.myItems.length || result.theirItems.length) {
      const you = rows(result.myItems, true);
      const them = rows(result.theirItems, false);
      html += `
                <div style="border-top:1px solid #444;padding-top:4px;margin-top:4px;max-height:160px;overflow-y:auto;">
                    ${you}${them}
                </div>
            `;
    } else {
      html += `<div style="color:#888;font-size:12px;margin-top:4px;">No trade items found in logs.</div>`;
    }

    // --- Bottom: round-trip profit based on flight time ---
    html += `
            <div style="border-top:2px solid ${tripColor};margin-top:8px;padding-top:6px;">
                <div style="color:#888;font-size:12px;margin-bottom:3px;">Round-trip flight ${rtMin} min (${Math.round(rtMin / 2)} min each way) →</div>
                <div class="tpp-row" style="display:flex;justify-content:space-between;margin-bottom:3px;">
                    <span style="color:#aaa;">Profit per trip:</span>
                    <span style="font-weight:bold;color:${tripColor};">${fmt(result.profitPerTrip)}</span>
                </div>
                <div class="tpp-row" style="display:flex;justify-content:space-between;">
                    <span style="color:#aaa;">Profit per hour:</span>
                    <span style="font-weight:bold;color:${tripColor};">${perHour != null ? fmt(perHour) : "—"}/hr</span>
                </div>
            </div>`;

    statsContainer.innerHTML = html;
  }

  // ========== RECOMPUTE (instant, from cached data + current controls; no API) ==========
  function recompute() {
    if (!lastData) {
      if (statsContainer)
        statsContainer.innerHTML =
          '<div style="color:#888;">Click <b>Calculate Trade</b> first.</div>';
      return;
    }
    try {
      const result = calculateProfit(
        lastData.tradeItems,
        lastData.market,
        lastData.purchase,
        lastData.learnedCosts,
        lastData.learnedDurations,
      );
      renderStats(result);
    } catch (e) {
      if (statsContainer)
        statsContainer.innerHTML = `<div style="color:#dc3545;">⚠️ ${e.message || e || "Error"}</div>`;
    }
  }

  // ========== CALCULATE (button action) ==========
  // The script is idle by default and only touches the API when this runs.
  function onCalculate() {
    const tradeId = getTradeIdFromURL();
    if (!tradeId) {
      if (statsContainer)
        statsContainer.innerHTML = '<div style="color:#888;">No trade selected.</div>';
      return;
    }
    // Already loaded for this trade -> recompute instantly from cache (applies any
    // new discount/travel setting) with no API request at all.
    if (lastData && lastData.tradeId === tradeId) {
      recompute();
      return;
    }
    loadTrade();
  }

  // ========== LOAD (full fetch + rebuild, rate-limited) ==========
  function loadTrade() {
    if (calcLoading) {
      log("Already loading — ignoring.");
      return;
    }
    const now = Date.now();
    if (now - lastCalcAt < 2500) {
      log("Rate limited — waiting.");
      return;
    }
    lastCalcAt = now;

    const tradeId = getTradeIdFromURL();
    if (!tradeId) {
      if (statsContainer)
        statsContainer.innerHTML = '<div style="color:#888;">No trade selected.</div>';
      return;
    }

    calcLoading = true;
    const btn = document.getElementById("trade-calc-btn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "⏳ Calculating…";
    }
    if (statsContainer) statsContainer.innerHTML = '<div style="color:#aaa;">⏳ Calculating…</div>';

    const seq = ++updateSeq;
    (async function () {
      try {
        const logData = await apiRequest("user", "log");
        const logs = logData.log || {};
        const tradeItems = getTradeItemsFromLogs(logs, tradeId);

        const myItemIds = tradeItems.myItems.map((i) => i.itemId);
        const theirItemIds = tradeItems.theirItems.map((i) => i.itemId);
        const market = await fetchItemDetails([...myItemIds, ...theirItemIds]);
        const purchase = collectPurchaseInfo(logs, myItemIds);
        const learnedCosts = learnTravelCosts(logs);
        const learnedDurations = learnTravelDurations(logs);

        if (seq !== updateSeq) return;

        lastData = {
          tradeId,
          tradeItems,
          market,
          purchase,
          learnedCosts,
          learnedDurations,
        };
        const result = calculateProfit(
          tradeItems,
          market,
          purchase,
          learnedCosts,
          learnedDurations,
        );
        renderStats(result);
        log("Trade calculated.");
      } catch (e) {
        if (seq !== updateSeq) return;
        log("Load error:", e);
        if (statsContainer)
          statsContainer.innerHTML = `<div style="color:#dc3545;">⚠️ ${e.message || e || "Unknown error"}</div>`;
      } finally {
        calcLoading = false;
        const b = document.getElementById("trade-calc-btn");
        if (b) {
          b.disabled = false;
          b.textContent = "🔄 Calculate Trade";
        }
      }
    })();
  }

  // ========== INIT ==========
  // Opens the panel on the trade page but makes NO API calls on its own.
  function init() {
    log("Trading Profit Calculator loaded.");
    buildPanel();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
