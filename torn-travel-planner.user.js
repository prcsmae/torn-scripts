// ==UserScript==
// @name         Torn Travel Planner
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Plan profitable travel routes using live abroad prices (YATA /api/v1/travel/export/) + Torn market values. Per-trip profit, budget allocation, suggested buy-list, active-window (short-haul) & sleep (long-haul) planning.
// @author       motherBarker (and China)
// @match        https://www.torn.com/travelagency.php*
// @match        https://www.torn.com/page.php?sid=travel*

// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @connect      yata.yt
// ==/UserScript==

(function () {
  "use strict";

  // ========== CONFIG ==========
  const CONFIG = {
    apiKey: "A0SxQ5FFORk9CNAs", // Minimal access is enough (items only)
    yataUrl: "https://yata.yt/api/v1/travel/export/", // public, no auth
    cacheDuration: 300000, // 5 min cache
    autoRefreshMs: 600000, // 10 min auto-refresh
    defaultNetPct: 97, // what you actually get from trading (95-97)
    defaultBudget: 50000000, // day's capital
    defaultSleepHours: 8,
    defaultBufferMin: 5, // time to buy items on the ground (default, min 0)
    debug: true,
    // One-way flight minutes per method; round trip = 2x. 'cost' = round-trip fare.
    // Only STANDARD pays the cost; airstrip (private island + pilot), WLT & business = FREE.
    destinations: {
      mex: {
        name: "Mexico",
        city: "Ciudad Juárez",
        cost: 6500,
        time: { standard: 24, airstrip: 17, wlt: 12, business: 7 },
      },
      cay: {
        name: "Cayman Islands",
        city: "George Town",
        cost: 10000,
        time: { standard: 33, airstrip: 23, wlt: 17, business: 10 },
      },
      can: {
        name: "Canada",
        city: "Toronto",
        cost: 9000,
        time: { standard: 39, airstrip: 27, wlt: 19, business: 12 },
      },
      haw: {
        name: "Hawaii",
        city: "Honolulu",
        cost: 11000,
        time: { standard: 127, airstrip: 89, wlt: 63, business: 38 },
      },
      uni: {
        name: "United Kingdom",
        city: "London",
        cost: 18000,
        time: { standard: 151, airstrip: 106, wlt: 75, business: 45 },
      },
      arg: {
        name: "Argentina",
        city: "Buenos Aires",
        cost: 21000,
        time: { standard: 158, airstrip: 111, wlt: 79, business: 47 },
      },
      swi: {
        name: "Switzerland",
        city: "Zurich",
        cost: 27000,
        time: { standard: 166, airstrip: 116, wlt: 83, business: 50 },
      },
      jap: {
        name: "Japan",
        city: "Tokyo",
        cost: 32000,
        time: { standard: 213, airstrip: 149, wlt: 107, business: 64 },
      },
      chi: {
        name: "China",
        city: "Beijing",
        cost: 35000,
        time: { standard: 229, airstrip: 160, wlt: 114, business: 69 },
      },
      uae: {
        name: "United Arab Emirates",
        city: "Dubai",
        cost: 32000,
        time: { standard: 257, airstrip: 180, wlt: 128, business: 77 },
      },
      sou: {
        name: "South Africa",
        city: "Johannesburg",
        cost: 40000,
        time: { standard: 282, airstrip: 197, wlt: 141, business: 85 },
      },
    },
    capacityByMode: { airstrip: 18, standard: 13, wlt: 13, business: 13 },
  };

  // ========== STATE (persisted) ==========
  const LS_KEY = "torn_travel_planner_state_v1";
  let state = {
    mode: "airstrip", // airstrip | standard | wlt | business
    capacity: 18, // editable; mode default unless overridden
    capacityOverridden: false,
    netPct: CONFIG.defaultNetPct,
    budget: CONFIG.defaultBudget,
    bufferMin: CONFIG.defaultBufferMin,
    activeStart: "", // HH:MM ('' = disabled)
    activeEnd: "", // HH:MM ('' = disabled)
    sleepHours: CONFIG.defaultSleepHours,
    autoRefresh: true,
    miniTop: 130, // vertical pos (px) of the minimized left-side button
    panelHidden: false, // fully hidden while minimized to button
  };

  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        Object.assign(state, JSON.parse(raw));
        state.capacity = Number(state.capacity) || 18;
        state.netPct = Number(state.netPct) || CONFIG.defaultNetPct;
        state.budget = Number(state.budget) || CONFIG.defaultBudget;
        state.bufferMin = Number.isFinite(state.bufferMin)
          ? state.bufferMin
          : CONFIG.defaultBufferMin;
        state.sleepHours = Number(state.sleepHours) || CONFIG.defaultSleepHours;
      }
      // Default the active-window start to "now" if nothing is saved.
      // (Only fills start; leave end empty so the window isn't accidentally enabled.)
      if (!state.activeStart) state.activeStart = nowHHMM();
    } catch (e) {
      /* ignore */
    }
  }
  // Current local time formatted as HH:MM (for <input type="time">).
  function nowHHMM() {
    const d = new Date();
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    return `${h}:${m}`;
  }
  function saveState() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
    } catch (e) {
      /* ignore */
    }
  }

  // ========== CACHES ==========
  const apiCache = {}; // url -> { data, ts }
  let lastData = null; // { abroad, items, fetchedAt }
  let updateSeq = 0;
  let loading = false;
  let lastLoadAt = 0;

  function getCached(key) {
    const c = apiCache[key];
    return c && Date.now() - c.ts < CONFIG.cacheDuration ? c.data : null;
  }

  // ========== NETWORK ==========
  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: url,
        onload: function (resp) {
          try {
            const data = JSON.parse(resp.responseText);
            if (data && data.error && typeof data.error === "object" && data.error.error) {
              reject(new Error("API Error: " + data.error.error));
            } else {
              resolve(data);
            }
          } catch (e) {
            reject(new Error("Parse error: " + e.message));
          }
        },
        onerror: function () {
          reject(new Error("Network error"));
        },
      });
    });
  }

  async function fetchAbroad(force) {
    if (!force) {
      const cached = getCached(CONFIG.yataUrl);
      if (cached) return cached;
    }
    const data = await gmFetch(CONFIG.yataUrl);
    if (!data || !data.stocks) throw new Error("YATA: unexpected response");
    apiCache[CONFIG.yataUrl] = { data: data, ts: Date.now() };
    return data;
  }

  async function fetchItems(force) {
    const url = "https://api.torn.com/torn/?selections=items&key=" + CONFIG.apiKey;
    if (!force) {
      const cached = getCached(url);
      if (cached) return cached;
    }
    const data = await gmFetch(url);
    if (!data || !data.items) throw new Error("Torn: unexpected response");
    apiCache[url] = { data: data, ts: Date.now() };
    return data;
  }

  // ========== FORMATTING ==========
  const money = (n) => "$" + Math.round(n).toLocaleString();
  const signed = (n) => (n >= 0 ? "+" : "") + "$" + Math.round(n).toLocaleString();
  const hours = (min) => {
    const h = Math.floor(min / 60),
      m = Math.round(min % 60);
    return h > 0 ? h + "h " + (m ? m + "m" : "") : m + "m";
  };
  const pphStr = (n) => "$" + Math.round(n).toLocaleString() + "/h";

  // ========== TIME HELPERS ==========
  // Parse HH:MM (or H:MM) -> minutes since midnight. null if invalid/empty.
  function parseHHMM(str) {
    if (!str) return null;
    const m = String(str)
      .trim()
      .match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = parseInt(m[1]),
      mm = parseInt(m[2]);
    if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
    return h * 60 + mm;
  }
  // Active-window minutes (handles overnight wrap). null if window disabled/invalid.
  function windowMinutes() {
    const ws = parseHHMM(state.activeStart),
      we = parseHHMM(state.activeEnd);
    if (ws === null || we === null) return null;
    let d = we - ws;
    if (d < 0) d += 24 * 60; // wraps past midnight
    return d;
  }

  // ========== CORE COMPUTATION ==========
  // Build one row per destination with trip profit (budget-allocated buy-list),
  // PPH, active-window profit, suggested top items, and sleep (one-way) info.
  function computeDestinations(abroad, items) {
    const mode = state.mode;
    const cap = state.capacity;
    const netPct = state.netPct / 100;
    const buffer = state.bufferMin; // buy-time buffer (all flights)
    const windowMin = windowMinutes();
    const net = {}; // destKey -> summary
    const rows = [];

    for (const key of Object.keys(CONFIG.destinations)) {
      const dc = CONFIG.destinations[key];
      const oneWay = dc.time[mode] != null ? dc.time[mode] : dc.time.standard;
      const travelCost = mode === "standard" ? dc.cost : 0; // only standard pays
      const stock = (abroad.stocks && abroad.stocks[key] && abroad.stocks[key].stocks) || [];

      // --- Candidate items with real net profit ---
      const cands = [];
      for (const s of stock) {
        const it = items[s.id];
        if (!it) continue;
        if (it.tradeable === false) continue;
        const mv = parseFloat(it.market_value);
        if (!(mv > 0)) continue;
        const received = mv * netPct;
        const unitNet = received - s.cost;
        if (unitNet <= 0) continue;
        cands.push({
          id: s.id,
          name: it.name || "#" + s.id,
          stockQty: s.quantity,
          cost: s.cost,
          received,
          unitNet,
        });
      }
      cands.sort((a, b) => b.unitNet - a.unitNet);

      // --- Budget allocation (greedy by unit net) ---
      let remaining = state.budget;
      const buyList = [];
      for (const c of cands) {
        if (remaining < 1) break;
        const perCap = Math.min(c.stockQty, cap);
        const byBudget = Math.floor(remaining / c.cost);
        const qty = Math.min(perCap, byBudget);
        if (qty <= 0) continue;
        buyList.push({
          name: c.name,
          qty,
          cost: c.cost,
          unitNet: c.unitNet,
          profit: c.unitNet * qty,
          spent: c.cost * qty,
        });
        remaining -= c.cost * qty;
      }

      let tripProfit = 0,
        budgetSpent = 0;
      for (const b of buyList) {
        tripProfit += b.profit;
        budgetSpent += b.spent;
      }
      const tripProfitNet = tripProfit - travelCost; // after travel cost (only standard)

      const roundTripMin = 2 * oneWay + buffer; // in + out + buy buffer
      const roundTripHours = roundTripMin / 60;
      const pph = roundTripHours > 0 ? tripProfitNet / roundTripHours : 0;

      // Active window: how many full round trips fit
      const trips =
        windowMin != null && roundTripMin > 0 ? Math.floor(windowMin / roundTripMin) : 0;
      const windowProfit = trips * tripProfitNet;

      const top = buyList.slice(0, 3);

      rows.push({
        key,
        name: dc.name,
        city: dc.city,
        oneWay,
        travelCost,
        cap,
        roundTripMin,
        roundTripHours,
        pph,
        trips,
        windowProfit,
        tripProfit,
        tripProfitNet,
        budgetSpent,
        top,
        buyList,
      });
    }

    // Sort for table default: recommended (PPH high, or window profit when window active)
    const sortKey = windowMin != null ? "windowProfit" : "pph";
    rows.sort((a, b) => b[sortKey] - a[sortKey]);
    return { rows, windowMin, sortKey };
  }

  // Sleep recommendation: long-haul only, ONE-WAY time. You are asleep, so you only
  // fly OUT. We prefer the longest one-way flight that fits within your sleep so you
  // set an alarm and wake as you land. Buffer is noted separately (you buy items awake).
  function sleepRecommendation(rows) {
    const sleepMin = state.sleepHours * 60;
    const list = rows
      .map((r) => ({
        key: r.key,
        name: r.name,
        city: r.city,
        oneWay: r.oneWay,
        buffer: state.bufferMin,
        tripProfit: r.tripProfit,
        top: r.top,
      }))
      .sort((a, b) => b.oneWay - a.oneWay); // long-haul first
    // Longest one-way that still fits the sleep window (you wake right as you land)
    const fitting = list.filter((r) => r.oneWay <= sleepMin);
    const chosen = fitting.length ? fitting[0] : list[0];
    return {
      list,
      chosen,
      fitsInSleep: fitting.length ? true : list.length && chosen.oneWay <= sleepMin,
    };
  }

  // ========== RENDER STATE ==========
  let sortState = { key: null, dir: -1 }; // key from sortable columns; -1 desc
  // Panel element refs
  let rootEl = null,
    panelBody = null,
    controlsEl = null,
    statusEl = null;
  let summaryEl = null,
    tableWrap = null; // eslint-disable-line no-unused-vars
  let miniButtonEl = null;
  let panelMinimized = false;

  // Column definitions for the sortable table
  const COLUMNS = [
    { key: "name", label: "Destination" },
    { key: "roundTripMin", label: "Time (RT)" },
    { key: "tripProfitNet", label: "Trip profit" },
    { key: "pph", label: "PPH" },
    { key: "windowProfit", label: "Window profit" },
    { key: "budgetSpent", label: "Budget spent" },
  ];

  function colorFor(v) {
    return v >= 0 ? "#28a745" : "#dc3545";
  }

  // ========== SUMMARY (recommended route + sleep) ==========
  function buildSummary(computed, sleep) {
    const useWindow = computed.windowMin != null;
    const best = computed.rows[0];
    const second = computed.rows[1];
    const topBuy =
      best && best.top.length ? best.top.map((t) => t.name + " ×" + t.qty).join(", ") : "—";
    let html = "";

    // Recommended active route
    if (best) {
      const metric = useWindow
        ? "💰 " +
          money(best.windowProfit) +
          " over " +
          best.trips +
          " trips in your " +
          hours(computed.windowMin) +
          " active window"
        : "💰 " + signed(best.tripProfitNet) + " per trip · " + pphStr(best.pph);
      html += `<div class="ttp-reco" style="background:rgba(40,167,69,0.12);border:1px solid rgba(40,167,69,0.5);border-radius:6px;padding:8px 10px;margin-bottom:8px;">`;
      html += `<div style="font-weight:bold;color:#28a745;">★ Recommended route${useWindow ? " (active window)" : ""}</div>`;
      html += `<div><b>${best.name} (${best.city})</b> — ${useWindow ? metric : ""}</div>`;
      html += `<div style="color:#bbb;font-size:12px;">${useWindow ? "PPH " + pphStr(best.pph) + " · " : ""}RT ${hours(best.roundTripMin)} · Buy: ${topBuy}</div>`;
      if (second) {
        html += `<div style="color:#bbb;font-size:12px;margin-top:4px;">Runner-up: <b>${second.name}</b> — ${signed(second.tripProfitNet)}/trip · ${pphStr(second.pph)}</div>`;
      }
      html += `</div>`;
    } else {
      html += `<div style="color:#dc3545;padding:6px;">No profitable routes found with current net% / budget / capacity.</div>`;
    }

    // Sleep recommendation (long-haul, one-way)
    if (sleep && sleep.list.length) {
      const c = sleep.chosen;
      const fits = c.oneWay <= state.sleepHours * 60;
      const note =
        state.sleepHours > 0
          ? fits
            ? `Fits your ${state.sleepHours}h sleep — set an alarm and wake as you land 🛬`
            : `Flight (${hours(c.oneWay)}) is longer than your ${state.sleepHours}h sleep — will overrun`
          : "Set sleep hours to auto-pick a long-haul";
      html += `<div class="ttp-sleep" style="background:rgba(79,195,247,0.10);border:1px solid rgba(79,195,247,0.45);border-radius:6px;padding:8px 10px;margin-bottom:8px;">`;
      html += `<div style="font-weight:bold;color:#4fc3f7;">😴 Sleep flight (long-haul, one-way — you're asleep on the way out)</div>`;
      html += `<div>Fly to <b>${c.name} (${c.city})</b> — one-way ${hours(c.oneWay)}${c.buffer ? " (+ " + c.buffer + "m buy buffer)" : ""}</div>`;
      html += `<div style="color:#bbb;font-size:12px;">${note} · Best long-hauls: ${sleep.list
        .slice(0, 3)
        .map((r) => r.name + " (" + hours(r.oneWay) + ")")
        .join(", ")}</div>`;
      html += `</div>`;
    }

    summaryEl.innerHTML = html;
  }

  function log(...a) {
    if (CONFIG.debug) console.log("[Travel Planner]", ...a);
  }

  // ========== TABLE (sortable) ==========
  function buildTable(computed) {
    let rows = computed.rows.slice();
    // Resolve sort key (default to windowProfit if window active, else pph)
    const defKey = computed.windowMin != null ? "windowProfit" : "pph";
    let k = sortState.key || defKey;
    const dir = sortState.key ? sortState.dir : -1;
    // numeric sort; name sorts alphabetically
    rows.sort((a, b) => {
      const va = a[k],
        vb = b[k];
      if (typeof va === "string") return dir * va.localeCompare(vb);
      return dir * (va - vb || a.pph - b.pph);
    });

    let html =
      '<table class="ttp-table" style="width:100%;border-collapse:collapse;font-size:12px;">';
    html += '<thead><tr style="border-bottom:1px solid rgba(255,255,255,0.15);text-align:left;">';
    for (const c of COLUMNS) {
      const active = (sortState.key || defKey) === c.key;
      const arrow = active ? (dir === -1 ? " ▼" : " ▲") : "";
      html += `<th data-key="${c.key}" style="padding:5px 6px;cursor:pointer;white-space:nowrap;color:${active ? "#4fc3f7" : "#aaa"};user-select:none;">${c.label}${arrow}</th>`;
    }
    html += '<th style="padding:5px 6px;color:#aaa;">Top items</th></tr></thead><tbody>';

    for (const r of rows) {
      const isBest = r === computed.rows[0];
      html += `<tr style="border-bottom:1px solid rgba(255,255,255,0.06);${isBest ? "background:rgba(40,167,69,0.08);" : ""}">`;
      html += `<td style="padding:5px 6px;"><b style="color:#f2f2f2;">${r.name}</b><br><span style="color:#c9c9c9;font-size:11px;">${r.city}</span></td>`;
      html += `<td style="padding:5px 6px;white-space:nowrap;">${hours(r.roundTripMin)}<br><span style="color:#888;font-size:11px;">1-way ${hours(r.oneWay)}${r.travelCost ? " · cost " + money(r.travelCost) : ""}</span></td>`;
      html += `<td style="padding:5px 6px;white-space:nowrap;color:${colorFor(r.tripProfitNet)};font-weight:bold;">${signed(r.tripProfitNet)}</td>`;
      html += `<td style="padding:5px 6px;white-space:nowrap;color:${colorFor(r.pph)};">${pphStr(r.pph)}</td>`;
      html += `<td style="padding:5px 6px;white-space:nowrap;color:${colorFor(r.windowProfit)};">${computed.windowMin != null ? signed(r.windowProfit) + ' <span style="color:#888;font-size:11px;">(' + r.trips + "×)</span>" : "—"}</td>`;
      html += `<td style="padding:5px 6px;white-space:nowrap;color:#aaa;">${money(r.budgetSpent)}</td>`;
      // Top 3 suggested items with qty + unit net
      html += `<td style="padding:5px 6px;">`;
      if (r.top.length) {
        r.top.forEach((t, i) => {
          html += `<div style="${i ? "margin-top:2px;" : ""}"><span style="color:#ddd;">${t.name}</span> <span style="color:#888;">×${t.qty}</span> <span style="color:${colorFor(t.unitNet)};font-size:11px;">@${signed(t.unitNet)}</span></div>`;
        });
        if (r.top.length < r.buyList.length)
          html += `<div style="color:#888;font-size:11px;">+${r.buyList.length - r.top.length} more</div>`;
      } else {
        html += '<span style="color:#666;">—</span>';
      }
      html += `</td></tr>`;
    }
    html += "</tbody></table>";
    tableWrap.innerHTML = html;

    // wire header clicks
    tableWrap.querySelectorAll("th[data-key]").forEach((th) => {
      th.addEventListener("click", () => {
        const k2 = th.getAttribute("data-key");
        if (sortState.key === k2) sortState.dir = -sortState.dir;
        else {
          sortState.key = k2;
          sortState.dir = -1;
        }
        renderResults();
      });
    });
  }

  // ========== RENDER ==========
  function renderResults() {
    if (!lastData) {
      if (statusEl) statusEl.textContent = "No data yet — click Refresh.";
      return;
    }
    let computed;
    try {
      computed = computeDestinations(lastData.abroad, lastData.items);
    } catch (e) {
      if (statusEl)
        statusEl.innerHTML = '<span style="color:#dc3545;">Error: ' + (e.message || e) + "</span>";
      return;
    }
    const sleep = sleepRecommendation(computed.rows);
    buildSummary(computed, sleep);
    buildTable(computed);
    updateStatus();
    if (statusEl) statusEl.style.color = "#bbb";
  }

  function updateStatus() {
    if (!lastData || !statusEl) return;
    const age = lastData.fetchedAt
      ? Math.max(0, Math.round((Date.now() - lastData.fetchedAt) / 1000))
      : -1;
    const mode =
      state.mode.toUpperCase() +
      " · cap " +
      state.capacity +
      " · net " +
      state.netPct +
      "% · budget " +
      money(state.budget);
    statusEl.innerHTML = `Data ${age >= 0 ? age + "s old" : "—"} · ${mode}`;
  }

  // ========== LOAD / REFRESH ==========
  async function loadData(force) {
    if (loading) return;
    if (!force && Date.now() - lastLoadAt < 2500) return; // rate-limit guard (skipped for manual force)
    lastLoadAt = Date.now();
    loading = true;
    const seq = ++updateSeq;
    const btn = document.getElementById("ttp-refresh");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "⏳ Loading…";
    }
    if (statusEl)
      statusEl.innerHTML =
        '<span style="color:#4fc3f7;">⏳ Fetching YATA abroad prices + Torn item values…</span>';

    try {
      const [abroad, items] = await Promise.all([fetchAbroad(force), fetchItems(force)]);
      if (seq !== updateSeq) return;
      const itemMap = {};
      for (const [id, it] of Object.entries(items.items || {})) itemMap[parseInt(id)] = it;
      lastData = { abroad, items: itemMap, fetchedAt: Date.now() };
      renderResults();
    } catch (e) {
      if (seq !== updateSeq) return;
      if (statusEl)
        statusEl.innerHTML = '<span style="color:#dc3545;">⚠️ ' + (e.message || e) + "</span>";
    } finally {
      loading = false;
      if (seq === updateSeq) {
        const b = document.getElementById("ttp-refresh");
        if (b) {
          b.disabled = false;
          b.textContent = "🔄 Refresh";
        }
      }
    }
  }

  function onSettingsChange() {
    saveState();
    if (lastData)
      renderResults(); // recompute from cache, no refetch
    else updateStatus();
  }

  // ========== BUILD PANEL (large overlay) ==========
  function field(label, input, extra) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;flex-direction:column;gap:2px;" + (extra || "");
    const lab = document.createElement("label");
    lab.textContent = label;
    lab.style.cssText = "color:#999;font-size:11px;";
    wrap.appendChild(lab);
    wrap.appendChild(input);
    return wrap;
  }
  function numInput(value, min, step, onchange, w) {
    const inp = document.createElement("input");
    inp.type = "number";
    inp.min = min != null ? min : "";
    inp.step = step || 1;
    inp.value = value;
    inp.style.cssText =
      "background:#0f0f0f;border:1px solid #333;color:#fff;border-radius:3px;padding:3px 6px;font-size:12px;width:" +
      (w || "70px") +
      ";";
    inp.addEventListener("change", () => onchange(parseFloat(inp.value)));
    return inp;
  }

  function buildPanel() {
    const existing = document.getElementById("ttp-root");
    if (existing) {
      rootEl = existing;
      panelBody = document.getElementById("ttp-body");
      statusEl = document.getElementById("ttp-status");
      summaryEl = document.getElementById("ttp-summary");
      tableWrap = document.getElementById("ttp-table");
      controlsEl = document.getElementById("ttp-controls");
      return;
    }

    const container = document.createElement("div");
    container.id = "ttp-root";
    container.style.cssText =
      "position:fixed;top:20px;left:50%;transform:translateX(-50%);" +
      "z-index:99999;width:min(1150px,96vw);max-height:calc(100vh - 40px);" +
      "background:#111;color:#fff;border:1px solid #333;border-radius:8px;" +
      "display:flex;flex-direction:column;box-sizing:border-box;" +
      "box-shadow:0 6px 24px rgba(0,0,0,0.7);overflow-y:auto;overflow-x:auto;" +
      "font-family:Arial,sans-serif;font-size:13px;";
    rootEl = container;

    const header = document.createElement("div");
    header.id = "ttp-header";
    header.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;padding:9px 14px;background:#1a1a1a;border-bottom:1px solid #333;cursor:grab;user-select:none;";
    const title = document.createElement("span");
    title.textContent = "✈️ Torn Travel Planner";
    title.style.cssText = "font-weight:bold;font-size:15px;color:#4fc3f7;";
    const btns = document.createElement("div");
    btns.style.cssText = "display:flex;gap:6px;";
    const minBtn = document.createElement("button");
    minBtn.className = "ttp-min";
    minBtn.textContent = "➖";
    minBtn.style.cssText = btnStyle();
    minBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setMinimized(!panelMinimized);
    });
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.style.cssText = btnStyle();
    closeBtn.title = "Minimize to button (never loses the panel)";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setMinimized(true);
    });
    btns.appendChild(minBtn);
    btns.appendChild(closeBtn);
    header.appendChild(title);
    header.appendChild(btns);
    container.appendChild(header);

    // Drag
    let dragging = false,
      dx = 0,
      dy = 0;
    header.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      dragging = true;
      dx = e.clientX - container.getBoundingClientRect().left;
      dy = e.clientY - container.getBoundingClientRect().top;
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      container.style.left = e.clientX - dx + "px";
      container.style.top = e.clientY - dy + "px";
      container.style.transform = "none";
    });
    document.addEventListener("mouseup", () => {
      dragging = false;
    });

    // Body
    const body = document.createElement("div");
    body.id = "ttp-body";
    body.style.cssText = "display:block;padding:12px 14px;";
    panelBody = body;

    // Controls
    const ctl = document.createElement("div");
    ctl.id = "ttp-controls";
    ctl.style.cssText =
      "display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;background:rgba(255,255,255,0.04);padding:8px 10px;border-radius:6px;";
    controlsEl = ctl;

    const modeSel = document.createElement("select");
    ["airstrip", "standard", "wlt", "business"].forEach((m) => {
      const o = document.createElement("option");
      o.value = m;
      o.textContent = m[0].toUpperCase() + m.slice(1);
      modeSel.appendChild(o);
    });
    modeSel.value = state.mode;
    modeSel.style.cssText = selStyle();
    modeSel.addEventListener("change", () => {
      state.mode = modeSel.value;
      if (!state.capacityOverridden) {
        state.capacity = CONFIG.capacityByMode[state.mode] || state.capacity;
        capInp.value = state.capacity;
      }
      onSettingsChange();
    });

    const capInp = numInput(
      state.capacity,
      0,
      1,
      (v) => {
        state.capacity = v;
        state.capacityOverridden = true;
        onSettingsChange();
      },
      "60px",
    );
    const netInp = numInput(
      state.netPct,
      1,
      0.5,
      (v) => {
        state.netPct = v;
        onSettingsChange();
      },
      "60px",
    );
    const budInp = numInput(
      state.budget,
      0,
      1000,
      (v) => {
        state.budget = v;
        onSettingsChange();
      },
      "100px",
    );
    const bufInp = numInput(
      state.bufferMin,
      0,
      1,
      (v) => {
        state.bufferMin = Math.max(0, v || 0);
        onSettingsChange();
      },
      "55px",
    );
    const sleepInp = numInput(
      state.sleepHours,
      0,
      0.5,
      (v) => {
        state.sleepHours = v;
        onSettingsChange();
      },
      "55px",
    );

    const startInp = document.createElement("input");
    startInp.type = "time";
    startInp.value = state.activeStart;
    startInp.style.cssText = inputStyle();
    startInp.style.width = "90px";
    startInp.addEventListener("change", () => {
      state.activeStart = startInp.value;
      onSettingsChange();
    });
    const endInp = document.createElement("input");
    endInp.type = "time";
    endInp.value = state.activeEnd;
    endInp.style.cssText = inputStyle();
    endInp.style.width = "90px";
    endInp.addEventListener("change", () => {
      state.activeEnd = endInp.value;
      onSettingsChange();
    });

    const autoCb = document.createElement("input");
    autoCb.type = "checkbox";
    autoCb.checked = state.autoRefresh;
    autoCb.style.cssText = "cursor:pointer;";
    autoCb.addEventListener("change", () => {
      state.autoRefresh = autoCb.checked;
      saveState();
    });
    const refreshBtn = document.createElement("button");
    refreshBtn.id = "ttp-refresh";
    refreshBtn.textContent = "🔄 Refresh";
    refreshBtn.style.cssText =
      "padding:5px 14px;background:#28a745;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;";
    refreshBtn.addEventListener("click", () => loadData(true));

    ctl.appendChild(field("Travel method", modeSel));
    ctl.appendChild(field("Item capacity", capInp));
    ctl.appendChild(field("Net % (trade)", netInp));
    ctl.appendChild(field("Budget (capital)", budInp));
    ctl.appendChild(field("Buy buffer (min)", bufInp));
    ctl.appendChild(field("Active start", startInp));
    ctl.appendChild(field("Active end", endInp));
    ctl.appendChild(field("Sleep (h)", sleepInp));
    ctl.appendChild(field("Auto-refresh", autoCb, "justify-content:flex-end;"));
    ctl.appendChild(refreshBtn);

    body.appendChild(ctl);

    // Status, summary, table
    const status = document.createElement("div");
    status.id = "ttp-status";
    statusEl = status;
    status.style.cssText =
      "color:#bbb;font-size:12px;background:rgba(255,255,255,0.03);padding:6px 10px;border-radius:4px;";
    status.textContent = "Loading…";
    body.appendChild(status);

    const summary = document.createElement("div");
    summary.id = "ttp-summary";
    summaryEl = summary;
    body.appendChild(summary);

    const tw = document.createElement("div");
    tw.id = "ttp-table";
    tableWrap = tw;
    tw.style.cssText = "overflow-x:auto;";
    tw.innerHTML = '<div style="color:#aaa;">Click <b>Refresh</b> to fetch live prices.</div>';
    body.appendChild(tw);

    container.appendChild(body);
    document.body.appendChild(container);

    // ---- Minified left-side button (Torn PDA / mobile friendly) ----
    const miniBtn = document.createElement("button");
    miniBtn.style.cssText =
      "display:none;position:fixed;left:8px;top:" +
      (state.miniTop || 130) +
      "px;" +
      "z-index:100000;width:46px;height:46px;border-radius:50%;" +
      "background:#1a1a1a;border:2px solid #4fc3f7;color:#4fc3f7;font-size:20px;cursor:pointer;" +
      "box-shadow:0 3px 10px rgba(0,0,0,0.6);align-items:center;justify-content:center;" +
      "touch-action:none;user-select:none;";
    miniBtn.textContent = "✈️";
    miniBtn.title = "Torn Travel Planner — tap to open (drag to move)";
    // tap to expand (unless it was a drag)
    let miniDragged = false;
    miniBtn.addEventListener("click", () => {
      if (miniDragged) {
        miniDragged = false;
        return;
      }
      setMinimized(false);
    });
    // drag to reposition (pointer events work for mouse + touch)
    miniBtn.addEventListener("pointerdown", (e) => {
      miniDragged = false;
      const startY = e.clientY,
        startX = e.clientX;
      const startTop = miniBtn.getBoundingClientRect().top;
      const move = (ev) => {
        const ny = startTop + (ev.clientY - startY);
        const nx = 8 + (ev.clientX - startX);
        const maxY = Math.max(
          8,
          (window.innerHeight || document.documentElement.clientHeight) - 54,
        );
        const clampedY = Math.max(8, Math.min(maxY, ny));
        miniBtn.style.top = clampedY + "px";
        // keep it hugging the left edge (allow small horizontal too, but clamp to left side)
        miniBtn.style.left = Math.max(8, Math.min(24, nx)) + "px";
        if (Math.abs(ev.clientY - startY) + Math.abs(ev.clientX - startX) > 6) miniDragged = true;
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        state.miniTop = parseInt(miniBtn.style.top) || state.miniTop;
        saveState();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      e.preventDefault();
    });
    document.body.appendChild(miniBtn);
    miniButtonEl = miniBtn;

    document.body.appendChild(container);

    const st = document.createElement("style");
    st.textContent =
      "#ttp-root table th:hover{color:#fff;} " +
      "@media (max-width:700px){#ttp-root{top:12px;left:50%;width:calc(100vw - 24px)!important;" +
      "max-height:calc(100vh - 24px)!important;max-height:calc(100dvh - 24px)!important;} #ttp-root #ttp-body{padding:8px;}}";
    document.head.appendChild(st);
  }

  function btnStyle() {
    return "background:none;border:none;color:#aaa;font-size:15px;cursor:pointer;padding:0 6px;line-height:1;";
  }
  function selStyle() {
    return "background:#0f0f0f;border:1px solid #333;color:#fff;border-radius:3px;padding:3px 6px;font-size:12px;";
  }
  function inputStyle() {
    return "background:#0f0f0f;border:1px solid #333;color:#fff;border-radius:3px;padding:3px 6px;font-size:12px;";
  }

  function setMinimized(min) {
    panelMinimized = !!min;
    if (rootEl) rootEl.style.display = panelMinimized ? "none" : "flex";
    if (miniButtonEl) miniButtonEl.style.display = panelMinimized ? "flex" : "none";
    state.panelHidden = panelMinimized;
    saveState();
    const mb = document.querySelector("#ttp-root #ttp-header .ttp-min");
    if (mb) mb.textContent = panelMinimized ? "➕" : "➖";
  }

  // ========== INIT ==========
  let refreshTimer = null;
  let statusTimer = null;
  function scheduleAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (state.autoRefresh) loadData();
    }, CONFIG.autoRefreshMs);
  }
  function scheduleStatusTicker() {
    // Live "Data Xs old" counter — ticks the age every second so it's never frozen.
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(updateStatus, 1000);
  }
  function init() {
    loadState();
    buildPanel();
    if (!state.capacityOverridden)
      state.capacity = CONFIG.capacityByMode[state.mode] || state.capacity;
    // restore minimized state (panel collapsed to the left-side button)
    if (state.panelHidden) setMinimized(true);
    updateStatus();
    loadData();
    scheduleAutoRefresh();
    scheduleStatusTicker();
    log("Travel Planner ready.");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
