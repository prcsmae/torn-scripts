// ==UserScript==
// @name         Torn Travel Planner
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Plan profitable travel routes using live abroad prices (YATA /api/v1/travel/export/) + Torn market values. Per-trip profit, budget allocation, suggested buy-list, active-window (short-haul) & sleep (long-haul) planning.
// @author       motherBarker (and China)
// @match        https://www.torn.com/travelagency.php*
// @match        https://www.torn.com/page.php?sid=travel*

// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @connect      yata.yt
// @connect      api.prombot.co.uk
// @connect      raw.githubusercontent.com
// ==/UserScript==

(function () {
  "use strict";

  // ========== CONFIG ==========
  const CONFIG = {
    apiKey: "A0SxQ5FFORk9CNAs", // Minimal access is enough (items only)
    yataUrl: "https://yata.yt/api/v1/travel/export/", // public, no auth (no restock field)
    prombotUrl: "https://api.prombot.co.uk/api/travel", // public; provides nextRestock (ISO)
    modelUrl:
      "https://raw.githubusercontent.com/russianrob/torn-foreign-restock/main/restock-model.json", // restock intervals/qtys
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
    respectStock: true, // only buy items that will be in stock when you land
    stockWindow: -1, // aim to land ~N min AFTER a restock (default -1 per playbook)
    nerveWasteLimit: 0, // max nerve you'll allow to cap while airborne before warning (0 = none)
    apiKey: "", // user's own API key ('' = disabled); enables nerve/restock reads
    restockConfidence: "med", // only trust OOS-restock predictions at/above this ('high'|'med'|'low')
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
        if (state.respectStock == null) state.respectStock = true;
        state.stockWindow = Number.isFinite(state.stockWindow) ? state.stockWindow : -1;
        state.nerveWasteLimit = Number.isFinite(state.nerveWasteLimit) ? state.nerveWasteLimit : 0;
        if (!state.restockConfidence) state.restockConfidence = "med";
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
  let _ttpBackoffUntil = 0; // unix ms, 0 = clear (cooldown after Torn API error)
  let updateSeq = 0;
  let loading = false;
  let lastLoadAt = 0;
  let _ttpNow = Date.now; // injectable clock (tests); matches foreignstock's __setClock

  function getCached(key) {
    const c = apiCache[key];
    return c && Date.now() - c.ts < CONFIG.cacheDuration ? c.data : null;
  }
  function ttpInBackoff() {
    return Date.now() < _ttpBackoffUntil;
  }
  function ttpApiOk() {
    _ttpBackoffUntil = 0;
  }
  function ttpApiErr() {
    _ttpBackoffUntil = Date.now() + 300000;
  } // 5 min cooldown

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
    // PromBot provides nextRestock (ISO) per item; YATA is the fallback (no restock field).
    const urls = [CONFIG.prombotUrl, CONFIG.yataUrl];
    let lastErr = null;
    for (const url of urls) {
      if (!force) {
        const cached = getCached(url);
        if (cached) return cached;
      }
      try {
        const data = await gmFetch(url);
        if (!data || !data.stocks) throw new Error("travel: unexpected response");
        apiCache[url] = { data: data, ts: Date.now() };
        return data;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("travel: no data source");
  }

  async function fetchModel(force) {
    const url = CONFIG.modelUrl;
    if (!force) {
      const cached = getCached(url);
      if (cached) return cached.items;
    }
    const data = await gmFetch(url);
    if (!data || !data.items) throw new Error("model: unexpected response");
    apiCache[url] = { data: data, ts: Date.now() };
    return data.items || {};
  }

  // Non-fatal wrapper: if the restock model can't load, planning still works.
  async function fetchModelSafe(force) {
    try {
      return (await fetchModel(force)) || {};
    } catch (e) {
      return {};
    }
  }

  // Current nerve from the user's own API key ('' = disabled).
  async function fetchNerve(force) {
    const key = state.apiKey;
    if (!key) return null;
    if (!force && ttpInBackoff()) return null; // cool-down after error, skip
    const url = "https://api.torn.com/user/?selections=basic&key=" + encodeURIComponent(key);
    if (!force) {
      const cached = getCached(url);
      if (cached) return cached;
    }
    try {
      const data = await gmFetch(url);
      if (!data || data.error || data.nerve == null) {
        ttpApiErr();
        return null;
      }
      apiCache[url] = { data: data, ts: Date.now() };
      ttpApiOk();
      return data;
    } catch (e) {
      ttpApiErr();
      return null;
    }
  }

  // Non-fatal: a missing/invalid API key must not break price/stock planning.
  async function fetchNerveSafe(force) {
    return (await fetchNerve(force)) || null;
  }

  async function fetchItems(force) {
    // Prefer the user's own API key (per-user rate limit); fall back to the
    // shared CONFIG key (minimal access is enough for items) if none is set.
    const key = state.apiKey || CONFIG.apiKey;
    const url = "https://api.torn.com/torn/?selections=items&key=" + key;
    if (!force) {
      const cached = getCached(url);
      if (cached) return cached;
      if (ttpInBackoff()) {
        // Serve stale cache during cooldown rather than nothing.
        const stale = apiCache[url];
        if (stale) return stale.data;
      }
    }
    try {
      const data = await gmFetch(url);
      if (!data || !data.items) {
        ttpApiErr();
        throw new Error("Torn: unexpected response");
      }
      apiCache[url] = { data: data, ts: Date.now() };
      ttpApiOk();
      return data;
    } catch (e) {
      ttpApiErr();
      throw e;
    }
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

  // ========== RESTOCK + NERVE HELPERS ==========
  // YATA/PromBot may give nextRestock as seconds, milliseconds, or an ISO string.
  function toMs(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") return v < 100000000000 ? v * 1000 : v;
    const t = Date.parse(String(v));
    return isNaN(t) ? null : t;
  }
  // Next restock time (ms): PromBot's nextRestock first, else estimate from the
  // restock model (last restock + next multiple of the interval). Mirrors
  // foreign-stock's nextRestockSec: the model is only trusted for non-low
  // reliability (rel) entries, and the next slot is floored to a full interval
  // so we never claim a restock is "right now" when it's actually uncertain.
  // A nextRestock already in the PAST means the export is stale (the shop hasn't
  // actually refilled yet) — ignore it rather than claim it'll be in stock.
  function itemNextRestockMs(s, entry, nowMs) {
    if (s && s.nextRestock != null) {
      const m = toMs(s.nextRestock);
      if (m != null && m > nowMs) return m; // only future restocks are actionable
    }
    if (
      entry &&
      typeof entry.last === "number" &&
      typeof entry.interval === "number" &&
      (entry.rel || "low") !== "low"
    ) {
      const last = entry.last * 1000;
      const interval = entry.interval * 1000;
      if (last > nowMs) return last;
      // since < 0 is handled above; otherwise the next slot is a whole number of
      // intervals after the last observed restock — never "now" itself, so a
      // bumpy estimate can't pretend the shop just refilled.
      const since = nowMs - last;
      let left = interval - (since % interval);
      if (left <= 0) left = interval; // min 1 full interval
      return nowMs + left;
    }
    return null;
  }
  function modelRestockQty(entry) {
    if (entry && Array.isArray(entry.qs) && entry.qs.length) {
      const a = [...entry.qs].sort((x, y) => x - y);
      const m = Math.floor(a.length / 2);
      const med = a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
      if (med > 0) return med;
    }
    if (typeof (entry && entry.modelQty) === "number" && entry.modelQty > 0) return entry.modelQty;
    return null;
  }
  function confRank(c) {
    return c === "high" ? 3 : c === "med" ? 2 : 1;
  }
  // Confidence in a restock estimate, mirroring foreign-stock's reliability (rel):
  // live PromBot nextRestock = high; model rel high = high, med = medium; else low.
  // A small sample count (n) degrades the estimate.
  function restockConfidence(s, entry) {
    let level = "low";
    if (s && s.nextRestock != null) level = "high";
    else if (entry && entry.rel === "high") level = "high";
    else if (entry && entry.rel === "med") level = "med";
    const n = entry && typeof entry.n === "number" ? entry.n : 0;
    if (n > 0 && n < 8) {
      if (level === "med") level = "low";
      else if (level === "high" && !(s && s.nextRestock != null)) level = "med";
    }
    return {
      level,
      label: level === "high" ? "high" : level === "med" ? "medium" : "low",
    };
  }
  const RESTOCK_CUSHION_MIN = 3; // minutes of safety on top of stockWindow, so a bumpy restock estimate still shelves before you land
  // Predicted minutes until an in-stock item sells out, from the model's sellRate
  // (mirrors foreign-stock: buffered so we err toward 'sells out sooner').
  const SELL_SAFETY = 1.15;
  function depletionInfo(qty, entry) {
    if (qty > 0 && entry && typeof entry.sellRate === "number" && isFinite(entry.sellRate)) {
      const rate = entry.sellRate * SELL_SAFETY;
      if (rate > 0) return { depletesMin: qty / rate };
    }
    return null;
  }
  // How much of a FUTURE restock (at restockMs) is still on the shelf when you
  // land (arrivalMs), given the model's buffered sell rate. Returns qty when no
  // sell rate is known (assume the full restock survives).
  function restockSurvival(qty, sellRate, arrivalMs, restockMs) {
    if (!(qty > 0)) return 0;
    if (
      typeof sellRate === "number" &&
      isFinite(sellRate) &&
      sellRate > 0 &&
      restockMs != null &&
      arrivalMs > restockMs
    ) {
      const minsAfter = (arrivalMs - restockMs) / 60000;
      const left = Math.floor(qty - sellRate * SELL_SAFETY * minsAfter);
      return Math.max(0, left);
    }
    return qty;
  }
  // Is an item buyable the moment you land (arrivalMs)?
  // status: 'instock' | 'restock' (returns before/at landing, or within
  // POST_ARRIVAL_MINS after) | 'empty'.  Restocked items are checked against
  // the buffered sell rate: if the fresh stock sells out again before you
  // land the item is marked empty.
  var POST_ARRIVAL_MINS = 5; // min you're willing to wait on the ground
  function landingAvailability(s, entry, nowMs, arrivalMs, stockWindowMin) {
    const qty = typeof s.quantity === "number" ? s.quantity : 0;
    if (qty > 0) {
      const conf = { level: "high", label: "high" };
      const dep = depletionInfo(qty, entry);
      const flightMin = (arrivalMs - nowMs) / 60000;
      const beforeLand = dep ? dep.depletesMin - flightMin : null; // + = after landing, - = before
      if (beforeLand != null && beforeLand < 0) {
        // In stock now, but likely sold out before you land.
        if (state.respectStock) {
          const nrMs = itemNextRestockMs(s, entry, nowMs);
          if (nrMs != null && nrMs <= arrivalMs) {
            const survived = restockSurvival(
              modelRestockQty(entry) || qty,
              entry && entry.sellRate,
              arrivalMs,
              nrMs,
            );
            if (survived > 0) {
              return {
                status: "restock",
                qty: survived,
                note: "sells out, restocks before you land",
                restockIn: Math.max(0, Math.round((nrMs - nowMs) / 60000)),
                beforeLanding: Math.max(0, Math.round((arrivalMs - nrMs) / 60000)),
                conf,
              };
            }
            return {
              status: "empty",
              qty: 0,
              note:
                "restocks " +
                Math.max(1, Math.round((arrivalMs - nrMs) / 60000)) +
                "m before you land but sells out again",
              conf,
            };
          }
          // Restock after landing but within the wait window?
          if (nrMs != null && nrMs <= arrivalMs + POST_ARRIVAL_MINS * 60000) {
            const survived = restockSurvival(
              modelRestockQty(entry) || qty,
              entry && entry.sellRate,
              arrivalMs + POST_ARRIVAL_MINS * 60000,
              nrMs,
            );
            if (survived > 0) {
              return {
                status: "restock",
                qty: survived,
                note:
                  "restocks ~" +
                  Math.max(1, Math.round((nrMs - arrivalMs) / 60000)) +
                  "m after you land — wait",
                restockIn: Math.max(0, Math.round((nrMs - nowMs) / 60000)),
                beforeLanding: Math.round((arrivalMs - nrMs) / 60000), // negative = after you land
                conf,
              };
            }
          }
          return {
            status: "empty",
            qty: 0,
            note: "depletes ~" + Math.max(1, Math.round(-beforeLand)) + "m before you land",
            conf,
          };
        }
        return {
          status: "instock",
          qty,
          note: "in stock",
          conf,
          depletion: {
            sellsOutBeforeLand: true,
            beforeLanding: Math.max(1, Math.round(-beforeLand)),
          },
        };
      }
      // Quantity still on the shelf when you land: current stock minus what the
      // buffered sell rate eats during the flight (mirrors restockSurvival).
      // Without a sell rate, assume the full current stock is still buyable.
      let qtyAtLanding = qty;
      if (dep) {
        const bufferedRate = qty / dep.depletesMin; // = sellRate * SELL_SAFETY
        qtyAtLanding = Math.max(1, Math.floor(qty - bufferedRate * flightMin));
      }
      return {
        status: "instock",
        qty: qtyAtLanding,
        note: "in stock",
        conf,
        depletion: {
          depletesMin: dep ? Math.round(dep.depletesMin) : null,
          beforeLanding: beforeLand != null ? Math.max(1, Math.round(beforeLand)) : null,
        },
      };
    }
    // Out of stock: confidence gate + restock-vs-landing.
    const conf = restockConfidence(s, entry);
    if (confRank(state.restockConfidence || "med") > confRank(conf.level)) {
      return { status: "empty", qty: 0, note: "restock too uncertain", conf };
    }
    const nrMs = itemNextRestockMs(s, entry, nowMs);
    const byMs = arrivalMs + (stockWindowMin || 0) * 60000 - RESTOCK_CUSHION_MIN * 60000;
    // Only claim "restocked before you land" when the restock truly precedes
    // arrival; a positive stockWindow can push byMs past arrival, and restocks
    // after landing belong to the post-arrival wait path below.
    if (nrMs != null && nrMs <= byMs && nrMs <= arrivalMs) {
      const survived = restockSurvival(
        modelRestockQty(entry) || state.capacity * 3,
        entry && entry.sellRate,
        arrivalMs,
        nrMs,
      );
      if (survived > 0) {
        return {
          status: "restock",
          qty: survived,
          note: "restocks before you land",
          restockIn: Math.max(0, Math.round((nrMs - nowMs) / 60000)),
          beforeLanding: Math.max(0, Math.round((arrivalMs - nrMs) / 60000)),
          conf,
        };
      }
      return {
        status: "empty",
        qty: 0,
        note:
          "restocks " +
          Math.max(1, Math.round((arrivalMs - nrMs) / 60000)) +
          "m before you land but sells out again",
        conf,
      };
    }
    // Restock within the post-arrival wait window?
    if (nrMs != null && nrMs <= arrivalMs + POST_ARRIVAL_MINS * 60000) {
      const survived = restockSurvival(
        modelRestockQty(entry) || state.capacity * 3,
        entry && entry.sellRate,
        arrivalMs + POST_ARRIVAL_MINS * 60000,
        nrMs,
      );
      if (survived > 0) {
        return {
          status: "restock",
          qty: survived,
          note:
            "restocks ~" +
            Math.max(1, Math.round((nrMs - arrivalMs) / 60000)) +
            "m after you land — wait",
          restockIn: Math.max(0, Math.round((nrMs - nowMs) / 60000)),
          beforeLanding: Math.round((arrivalMs - nrMs) / 60000), // negative = after you land
          conf,
        };
      }
    }
    return { status: "empty", qty: 0, note: "empty at landing", conf };
  }
  // Nerve-waste estimate for a round trip of `roundTripMin` minutes.
  function nerveInfo(roundTripMin, nerve) {
    const max = (nerve && nerve.nerve_maximum) || 100;
    const nowPts = nerve && typeof nerve.nerve === "number" ? nerve.nerve : null;
    const base = {
      max,
      now: nowPts,
      msPerNerve: null,
      regen: 0,
      waste: 0,
      spendTo: null,
    };
    if (nerve == null || nowPts == null) return base;
    let msPerNerve = null;
    if (nowPts < max && nerve.nerve_fulltime) {
      const fullMs = nerve.nerve_fulltime * 1000;
      if (fullMs > Date.now()) msPerNerve = (fullMs - Date.now()) / (max - nowPts);
    }
    if (msPerNerve == null || !isFinite(msPerNerve) || msPerNerve <= 0) msPerNerve = 5 * 60000; // default: 1 nerve / 5 min
    const regen = Math.floor((roundTripMin * 60000) / msPerNerve);
    const waste = Math.max(0, regen - (max - nowPts));
    return {
      max,
      now: nowPts,
      msPerNerve,
      regen,
      waste,
      spendTo: Math.max(0, Math.round(nowPts - waste)),
    };
  }

  // ========== CORE COMPUTATION ==========
  // Build one row per destination with trip profit (budget-allocated buy-list),
  // PPH, active-window profit, suggested top items, restock/nerve awareness.
  function computeDestinations(abroad, items, models, nerve) {
    const mode = state.mode;
    const cap = state.capacity;
    const netPct = state.netPct / 100;
    const buffer = state.bufferMin; // buy-time buffer (all flights)
    const windowMin = windowMinutes();
    const nowMs = _ttpNow();
    const rows = [];

    for (const key of Object.keys(CONFIG.destinations)) {
      const dc = CONFIG.destinations[key];
      const oneWay = dc.time[mode] != null ? dc.time[mode] : dc.time.standard;
      const travelCost = mode === "standard" ? dc.cost : 0; // only standard pays
      const stock = (abroad.stocks && abroad.stocks[key] && abroad.stocks[key].stocks) || [];

      // --- Candidate items with real net profit, buying only what is in stock on arrival ---
      const arrivalMs = nowMs + oneWay * 60000;
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
        const entry = models && models[key] ? models[key][s.id] : null;
        let stockQty = typeof s.quantity === "number" ? s.quantity : 0;
        let landing = null;
        if (state.respectStock) {
          landing = landingAvailability(s, entry, nowMs, arrivalMs, state.stockWindow);
          if (landing.status === "empty") continue; // won't be buyable when you land
          stockQty = landing.qty;
        }
        cands.push({
          id: s.id,
          name: it.name || "#" + s.id,
          stockQty,
          cost: s.cost,
          received,
          unitNet,
          landing,
        });
      }
      cands.sort((a, b) => b.unitNet - a.unitNet);

      // --- Budget allocation (greedy by unit net), capped by flight capacity ---
      let remaining = state.budget;
      const buyList = [];
      let slotsUsed = 0;
      for (const c of cands) {
        if (remaining < 1) break;
        const bySlots = cap - slotsUsed;
        const perCap = Math.min(c.stockQty, cap);
        const byBudget = Math.floor(remaining / c.cost);
        const qty = Math.min(perCap, byBudget, bySlots);
        if (qty <= 0) {
          if (cap > 0 && slotsUsed >= cap) break; // flight capacity full
          continue;
        }
        buyList.push({
          name: c.name,
          qty,
          cost: c.cost,
          unitNet: c.unitNet,
          profit: c.unitNet * qty,
          spent: c.cost * qty,
          landing: c.landing,
        });
        remaining -= c.cost * qty;
        slotsUsed += qty;
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
      const nrv = nerveInfo(roundTripMin, nerve);

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
        roi: budgetSpent > 0 ? (tripProfit / budgetSpent) * 100 : 0,
        slots: slotsUsed,
        nerve: nrv,
        top,
        buyList,
      });
    }

    // Sort for table default: recommended (PPH high, or window profit when window active)
    const sortKey = windowMin != null ? "windowProfit" : "pph";
    rows.sort((a, b) => b[sortKey] - a[sortKey]);
    return { rows, windowMin, sortKey, nerve };
  }

  // Sleep plan: for each destination, find the most profitable item that will be
  // in stock when you land, and tell you when to depart so the fresh restock is
  // still on the shelf. Two scenarios per destination:
  //   timed — depart at restock+window−flight, land right after the restock
  //   now   — depart immediately, item must survive (or restock) until landing
  // Both allocate your budget + capacity like the main planner; destinations are
  // ranked by net trip profit (travel cost subtracted).
  function computeSleepPlan(abroad, items, models) {
    const mode = state.mode;
    const cap = state.capacity;
    const netPct = state.netPct / 100;
    const sleepMin = state.sleepHours * 60;
    const nowMs = _ttpNow();
    const rows = [];

    for (const key of Object.keys(CONFIG.destinations)) {
      const dc = CONFIG.destinations[key];
      const oneWay = dc.time[mode] != null ? dc.time[mode] : dc.time.standard;
      const travelCost = mode === "standard" ? dc.cost : 0;
      const stock = (abroad.stocks && abroad.stocks[key] && abroad.stocks[key].stocks) || [];
      const timedCands = [];
      const nowCands = [];

      for (const s of stock) {
        const it = items[s.id];
        if (!it) continue;
        if (it.tradeable === false) continue;
        const mv = parseFloat(it.market_value);
        if (!(mv > 0)) continue;
        const received = mv * netPct;
        const unitNet = received - s.cost;
        if (unitNet <= 0) continue;
        const entry = models && models[key] ? models[key][s.id] : null;
        const qtyNow = typeof s.quantity === "number" ? s.quantity : 0;
        const R = itemNextRestockMs(s, entry, nowMs);
        const rate =
          entry && typeof entry.sellRate === "number" && isFinite(entry.sellRate)
            ? entry.sellRate
            : null;

        // --- Scenario "now": land at now + flight ---
        const arrivalNow = nowMs + oneWay * 60000;
        const ld = landingAvailability(s, entry, nowMs, arrivalNow, state.stockWindow);
        let availNow = 0;
        let noteNow = "";
        if (ld.status === "instock") {
          availNow = ld.qty;
          noteNow =
            ld.depletion && ld.depletion.sellsOutBeforeLand
              ? "sells out before you land"
              : "in stock at landing";
        } else if (ld.status === "restock") {
          const q = restockSurvival(ld.qty, rate, arrivalNow, R);
          if (q > 0) {
            availNow = q;
            noteNow =
              ld.beforeLanding != null && ld.beforeLanding > 0
                ? "restocks ~" + ld.beforeLanding + "m before you land"
                : ld.note || "restocked before you land";
          }
        }
        if (availNow > 0)
          nowCands.push({
            id: s.id,
            name: it.name || "#" + s.id,
            avail: availNow,
            cost: s.cost,
            received,
            unitNet,
            note: noteNow,
          });

        // --- Scenario "timed": land ~R + window + cushion after the restock ---
        if (R) {
          const conf = restockConfidence(s, entry);
          // Same confidence gate as the main planner: never time a departure
          // to a restock estimate we wouldn't trust out-of-stock.
          if (confRank(state.restockConfidence || "med") <= confRank(conf.level)) {
            const restockInMin = (R - nowMs) / 60000;
            const landDelayMin = restockInMin + RESTOCK_CUSHION_MIN - (state.stockWindow || 0);
            const departureMin = landDelayMin - oneWay;
            if (departureMin >= 0) {
              const arrivalMin = departureMin + oneWay;
              const qtyAtRestock = modelRestockQty(entry) || qtyNow || cap * 3;
              const q = restockSurvival(qtyAtRestock, rate, nowMs + arrivalMin * 60000, R);
              if (q > 0)
                timedCands.push({
                  id: s.id,
                  name: it.name || "#" + s.id,
                  avail: q,
                  cost: s.cost,
                  received,
                  unitNet,
                  departureMin: Math.round(departureMin),
                  arrivalMin: Math.round(arrivalMin),
                  afterRestockMin: Math.max(1, Math.round(arrivalMin - restockInMin)),
                  conf,
                  note: "",
                });
            }
          }
        }
      }

      // --- Build per-scenario buy-lists (greedy by unit net, budget + capacity) ---
      function allocate(cands) {
        cands.sort((a, b) => b.unitNet - a.unitNet);
        let remaining = state.budget;
        let slotsUsed = 0;
        const buyList = [];
        for (const c of cands) {
          if (remaining < 1) break;
          const bySlots = cap - slotsUsed;
          const byBudget = Math.floor(remaining / c.cost);
          const qty = Math.min(c.avail, byBudget, bySlots);
          if (qty <= 0) continue;
          buyList.push({
            name: c.name,
            qty,
            cost: c.cost,
            unitNet: c.unitNet,
            profit: c.unitNet * qty,
            spent: c.cost * qty,
            note: c.note,
            dep: c.departureMin != null ? c.departureMin : null,
            after: c.afterRestockMin != null ? c.afterRestockMin : null,
            conf: c.conf || null,
          });
          remaining -= c.cost * qty;
          slotsUsed += qty;
        }
        let tripProfit = 0,
          budgetSpent = 0;
        for (const b of buyList) {
          tripProfit += b.profit;
          budgetSpent += b.spent;
        }
        return { buyList, tripProfit, budgetSpent, slots: slotsUsed };
      }

      const timed = timedCands.length ? allocate(timedCands) : null;
      const now = nowCands.length ? allocate(nowCands) : null;
      const timedFits =
        timed && timed.buyList.length
          ? timedCands.every((c) => c.departureMin >= 0 && c.arrivalMin <= sleepMin)
          : false;
      const nowFits = now && now.buyList.length ? oneWay <= sleepMin : false;

      // Pick the country's best scenario (profit-first, prefer sleep-fitting;
      // on an exact tie prefer leaving now — no alarm needed).
      let best = null,
        bestKind = null;
      for (const kind of ["now", "timed"]) {
        const sc = kind === "timed" ? timed : now;
        if (!sc || !sc.buyList.length) continue;
        const fits = kind === "timed" ? timedFits : nowFits;
        const profitNet = sc.tripProfit - travelCost;
        if (!best || (fits && !best.fits) || (fits === best.fits && profitNet > best.profitNet)) {
          best = { ...sc, profitNet, travelCost, fits };
          bestKind = kind;
        }
      }
      if (!best) continue;

      rows.push({
        key,
        name: dc.name,
        city: dc.city,
        oneWay,
        travelCost,
        kind: bestKind,
        fits: best.fits,
        profitNet: best.profitNet,
        tripProfit: best.tripProfit,
        budgetSpent: best.budgetSpent,
        slots: best.slots,
        timedCands,
        nowCands,
        buyList: best.buyList,
        top: best.buyList.slice(0, 3),
        timed,
        now,
      });
    }

    rows.sort((a, b) => b.profitNet - a.profitNet);
    const fitting = rows.filter((r) => r.fits);
    const chosen = fitting.length ? fitting[0] : rows[0];
    return { rows, chosen, fitsInSleep: fitting.length > 0 };
  }
  // Back-compat alias used by renderResults.
  function sleepRecommendation(abroad, items, models) {
    return computeSleepPlan(abroad, items, models);
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
  function landingTag(ld) {
    if (!ld) return "";
    if (ld.status === "restock") {
      const before = ld.beforeLanding != null ? ld.beforeLanding : "?";
      const inMin = ld.restockIn != null ? ld.restockIn : "?";
      const conf = ld.conf ? ld.conf.label : "";
      // Post-arrival restock: beforeLanding is negative (or 0 when the
      // restock coincides with landing); use the note instead.
      if (typeof before === "number" && before <= 0) {
        return `<span style="color:#c9a227;font-size:10px;" title="Restocks in ~${inMin}m from now (~${-before}m after you land) — confidence: ${conf}">🟡 ${ld.note || "restocks shortly after you land"}${conf ? " · " + conf : ""}</span>`;
      }
      return `<span style="color:#c9a227;font-size:10px;" title="Restocks in ~${inMin}m from now (~${before}m before you land) — confidence: ${conf}">🟡 restocks ~${before}m before you land${conf ? " · " + conf : ""}</span>`;
    }
    if (ld.status === "instock" && ld.depletion) {
      if (ld.depletion.sellsOutBeforeLand)
        return `<span style="color:#d8736a;font-size:10px;" title="In stock now, but predicted sold out ~${ld.depletion.beforeLanding}m before you land">🔴 depletes ~${ld.depletion.beforeLanding}m before you land</span>`;
      if (ld.depletion.beforeLanding != null)
        return `<span style="color:#51c97a;font-size:10px;" title="In stock; predicted to sell out ~${ld.depletion.beforeLanding}m after you land">🟢 in stock · sells out ~${ld.depletion.beforeLanding}m after you land</span>`;
    }
    if (ld.status === "instock")
      return '<span style="color:#28a745;font-size:10px;">🟢 in stock</span>';
    // empty with a useful note
    if (ld.note && ld.note !== "empty at landing")
      return `<span style="color:#d8736a;font-size:10px;" title="${ld.note}">🔴 ${ld.note}</span>`;
    return '<span style="color:#dc3545;font-size:10px;">🔴 empty</span>';
  }

  // ========== SUMMARY (recommended route + sleep) ==========
  function buildSummary(computed, sleep, nerve) {
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
        : "💰 " +
          signed(best.tripProfitNet) +
          " per trip · " +
          pphStr(best.pph) +
          " · ROI " +
          (best.roi != null ? best.roi.toFixed(1) + "%" : "—");
      html += `<div class="ttp-reco" style="background:rgba(40,167,69,0.12);border:1px solid rgba(40,167,69,0.5);border-radius:6px;padding:8px 10px;margin-bottom:8px;">`;
      html += `<div style="font-weight:bold;color:#28a745;">★ Recommended route${useWindow ? " (active window)" : ""}</div>`;
      html += `<div><b>${best.name} (${best.city})</b> — ${useWindow ? metric : ""}</div>`;
      html += `<div style="color:#bbb;font-size:12px;">${useWindow ? "PPH " + pphStr(best.pph) + " · " : ""}RT ${hours(best.roundTripMin)} · Buy: ${topBuy}</div>`;
      if (second) {
        html += `<div style="color:#bbb;font-size:12px;margin-top:4px;">Runner-up: <b>${second.name}</b> — ${signed(second.tripProfitNet)}/trip · ${pphStr(second.pph)}</div>`;
      }
      if (best && best.nerve && typeof best.nerve.now === "number") {
        const n = best.nerve;
        if (n.waste > state.nerveWasteLimit) {
          const doSpend = Math.max(0, n.waste - state.nerveWasteLimit);
          html += `<div style="color:#e2a03f;font-size:12px;margin-top:4px;">🧠 Nerve ${n.now}/${n.max} — this RT wastes <b>~${n.waste}</b> nerve. Spend <b>${doSpend}</b> (down to ~${n.spendTo}) before leaving to avoid capping mid-flight.</div>`;
        }
      }
      html += `</div>`;
    } else {
      html += `<div style="color:#dc3545;padding:6px;">No profitable routes found with current net% / budget / capacity.</div>`;
    }

    // Sleep plan — most profitable item that will be stocked when you land
    if (sleep && sleep.rows.length) {
      const c = sleep.chosen;
      const top =
        c.top && c.top.length
          ? c.top
              .map(
                (t) =>
                  `${t.name} ×${t.qty}${t.after != null ? ` (${t.after}m after restock)` : ""}`,
              )
              .join(", ")
          : "—";
      const timedPick = c.kind === "timed" && c.buyList[0] && c.buyList[0].dep != null;
      const depItem = timedPick ? c.buyList[0] : null;
      const confLbl =
        depItem && depItem.conf && depItem.conf.level !== "high"
          ? ` · <span style="color:#c9a227;">${depItem.conf.label} confidence</span>`
          : "";
      const departTxt = timedPick
        ? `Depart in <b>${hours(depItem.dep)}</b> — land <b>${depItem.after}m</b> after restock${confLbl}`
        : "Depart <b>now</b> (stock verified at arrival)";
      const fitsTxt =
        state.sleepHours > 0
          ? c.fits
            ? `Fits your ${state.sleepHours}h sleep — set an alarm 🛬`
            : `Arrival overruns your ${state.sleepHours}h sleep — will wake mid-trip`
          : "Set sleep hours to time the restock";
      html += `<div class="ttp-sleep" style="background:rgba(79,195,247,0.10);border:1px solid rgba(79,195,247,0.45);border-radius:6px;padding:8px 10px;margin-bottom:8px;">`;
      html += `<div style="font-weight:bold;color:#4fc3f7;">😴 Sleep plan — best item stocked at arrival</div>`;
      html += `<div>Fly to <b>${c.name} (${c.city})</b> — one-way ${hours(c.oneWay)} · ${departTxt}</div>`;
      html += `<div style="color:#bbb;font-size:12px;">💰 ${signed(c.profitNet)} net (spend ${money(c.budgetSpent)}, ${c.slots} slots) · Buy: ${top}</div>`;
      html += `<div style="color:#bbb;font-size:12px;">${fitsTxt}</div>`;
      if (sleep.rows.length > 1) {
        html += `<div style="color:#888;font-size:11px;margin-top:3px;">Alternatives: ${sleep.rows
          .slice(1, 4)
          .map((r) => `${r.name} ${signed(r.profitNet)}${r.fits ? "" : " ⚠overrun"}`)
          .join(" · ")}</div>`;
      }
      html += `</div>`;
    } else if (sleep && !sleep.rows.length) {
      html += `<div class="ttp-sleep" style="background:rgba(79,195,247,0.10);border:1px solid rgba(79,195,247,0.45);border-radius:6px;padding:8px 10px;margin-bottom:8px;">`;
      html += `<div style="font-weight:bold;color:#4fc3f7;">😴 Sleep plan</div>`;
      html += `<div style="color:#bbb;font-size:12px;">No item will be profitably in stock at any destination within your settings (budget/capacity/net%/restock confidence).</div>`;
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
      html += `<td style="padding:5px 6px;white-space:nowrap;"><span style="color:#f2f2f2;font-weight:600;">${hours(r.roundTripMin)}</span><br><span style="color:#b7bdc5;font-size:11px;">1-way ${hours(r.oneWay)}${r.travelCost ? " · cost " + money(r.travelCost) : ""}</span></td>`;
      html += `<td style="padding:5px 6px;white-space:nowrap;color:${colorFor(r.tripProfitNet)};font-weight:bold;">${signed(r.tripProfitNet)}</td>`;
      html += `<td style="padding:5px 6px;white-space:nowrap;color:${colorFor(r.pph)};">${pphStr(r.pph)}</td>`;
      html += `<td style="padding:5px 6px;white-space:nowrap;color:${colorFor(r.windowProfit)};">${computed.windowMin != null ? signed(r.windowProfit) + ' <span style="color:#888;font-size:11px;">(' + r.trips + "×)</span>" : "—"}</td>`;
      html += `<td style="padding:5px 6px;white-space:nowrap;color:#aaa;">${money(r.budgetSpent)}</td>`;
      // Top 3 suggested items with qty + unit net
      html += `<td style="padding:5px 6px;">`;
      if (r.top.length) {
        r.top.forEach((t, i) => {
          html += `<div style="${i ? "margin-top:2px;" : ""}"><span style="color:#ddd;">${t.name}</span> <span style="color:#888;">×${t.qty}</span> <span style="color:${colorFor(t.unitNet)};font-size:11px;">@${signed(t.unitNet)}</span> ${landingTag(t.landing)}</div>`;
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
      computed = computeDestinations(
        lastData.abroad,
        lastData.items,
        lastData.model || {},
        lastData.nerve,
      );
    } catch (e) {
      if (statusEl)
        statusEl.innerHTML = '<span style="color:#dc3545;">Error: ' + (e.message || e) + "</span>";
      return;
    }
    const sleep = sleepRecommendation(lastData.abroad, lastData.items, lastData.model || {});
    buildSummary(computed, sleep, lastData.nerve);
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
    let suff = state.respectStock ? " · stock@arrival" : "";
    if (lastData && lastData.nerve)
      suff += " · nerve " + lastData.nerve.nerve + "/" + (lastData.nerve.nerve_maximum || 100);
    if (suff) statusEl.innerHTML += suff;
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
        '<span style="color:#4fc3f7;">⏳ Fetching abroad prices + item values + restock/nerve…</span>';

    try {
      const [abroad, items, model, nerve] = await Promise.all([
        fetchAbroad(force),
        fetchItems(force),
        fetchModelSafe(force),
        fetchNerveSafe(force),
      ]);
      if (seq !== updateSeq) return;
      const itemMap = {};
      for (const [id, it] of Object.entries(items.items || {})) itemMap[parseInt(id)] = it;
      lastData = {
        abroad,
        items: itemMap,
        model,
        nerve,
        fetchedAt: Date.now(),
      };
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
    const nowBtn = document.createElement("button");
    nowBtn.textContent = "Now";
    nowBtn.title = "Set Active start to the current time";
    nowBtn.style.cssText =
      "padding:4px 8px;background:#333;color:#fff;border:1px solid #555;border-radius:4px;cursor:pointer;font-size:11px;";
    nowBtn.addEventListener("click", () => {
      state.activeStart = nowHHMM();
      startInp.value = state.activeStart;
      saveState();
      onSettingsChange();
    });
    const startWrap = document.createElement("div");
    startWrap.style.cssText = "display:flex;gap:4px;align-items:flex-end;";
    startWrap.appendChild(startInp);
    startWrap.appendChild(nowBtn);
    const endInp = document.createElement("input");
    endInp.type = "time";
    endInp.value = state.activeEnd;
    endInp.style.cssText = inputStyle();
    endInp.style.width = "90px";
    endInp.addEventListener("change", () => {
      state.activeEnd = endInp.value;
      onSettingsChange();
    });

    const respectCb = document.createElement("input");
    respectCb.type = "checkbox";
    respectCb.checked = state.respectStock;
    respectCb.style.cssText = "cursor:pointer;";
    respectCb.addEventListener("change", () => {
      state.respectStock = respectCb.checked;
      onSettingsChange();
    });
    const swInp = numInput(
      state.stockWindow,
      -30,
      1,
      (v) => {
        state.stockWindow = v;
        onSettingsChange();
      },
      "50px",
    );
    const nwInp = numInput(
      state.nerveWasteLimit,
      0,
      1,
      (v) => {
        state.nerveWasteLimit = Math.max(0, v || 0);
        onSettingsChange();
      },
      "50px",
    );
    const keyInp = document.createElement("input");
    keyInp.type = "password";
    keyInp.placeholder = "API key (items + nerve)";
    keyInp.value = state.apiKey || "";
    keyInp.style.cssText = inputStyle();
    keyInp.style.width = "120px";
    keyInp.addEventListener("change", () => {
      state.apiKey = keyInp.value.trim();
      saveState();
      loadData(true); // refetch so items/nerve use the new key
    });
    const confSel = document.createElement("select");
    ["med", "high", "low"].forEach((v) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = v[0].toUpperCase() + v.slice(1);
      confSel.appendChild(o);
    });
    confSel.value = state.restockConfidence || "med";
    confSel.style.cssText = selStyle();
    confSel.addEventListener("change", () => {
      state.restockConfidence = confSel.value;
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
    ctl.appendChild(field("Active start", startWrap));
    ctl.appendChild(field("Active end", endInp));
    ctl.appendChild(field("Sleep (h)", sleepInp));
    ctl.appendChild(field("Stock on arrival", respectCb, "justify-content:flex-end;"));
    ctl.appendChild(field("Stock window (min)", swInp));
    ctl.appendChild(field("Restock confidence", confSel));
    ctl.appendChild(field("Nerve waste allow", nwInp));
    ctl.appendChild(field("API key", keyInp, "flex-basis:160px;"));
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

  // Headless/Node guard: keeps require() side-effect free (no live DOM) so the
  // pure helpers below can be unit-tested with a small harness (see the
  // torn-userscripts skill). Identical behavior in the browser.
  if (typeof document !== "undefined" && typeof document.getElementById === "function") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  }

  // ========== TESTS (module.exports) ==========
  // Pure helpers exported for the Node verification harness. In the browser
  // `module` is undefined so this block is inert.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      CONFIG,
      state,
      toMs,
      itemNextRestockMs,
      modelRestockQty,
      confRank,
      restockConfidence,
      depletionInfo,
      restockSurvival,
      landingAvailability,
      nerveInfo,
      computeDestinations,
      computeSleepPlan,
      RESTOCK_CUSHION_MIN,
      POST_ARRIVAL_MINS,
      SELL_SAFETY,
    };
    module.exports.__setClock = function (fn) {
      _ttpNow = fn || Date.now;
    };
  }
})();
