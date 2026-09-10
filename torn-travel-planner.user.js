// ==UserScript==
// @name         Torn Travel Planner
// @namespace    http://tampermonkey.net/
// @version      1.6
// @description  Plan profitable travel routes using live abroad prices (YATA /api/v1/travel/export/) + Torn market values. Per-trip profit, budget allocation, suggested buy-list, active-window (short-haul) & sleep (long-haul) planning.
// @author       motherBarker (and China)
// @match        https://www.torn.com/travelagency.php*
// @match        https://www.torn.com/page.php?sid=travel*

// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @connect      yata.yt
// @connect      api.prombot.co.uk
// @connect      raw.githubusercontent.com
// @connect      mediabros.cc
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
    nerveCare: false, // whether the user cares about nerve waste at all
    trackedItems: [], // item ids the user wants leave-times for (item tracker tab)
    tab: "planner", // which tab is showing: planner | tracker
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
        state.nerveCare = !!state.nerveCare;
        // Single tracked item (v1.5) upgraded to a list; keep the old value.
        if (state.trackItem) {
          state.trackedItems = [parseInt(state.trackItem, 10)];
          delete state.trackItem;
        }
        state.trackedItems = Array.isArray(state.trackedItems)
          ? [...new Set(state.trackedItems.map((n) => parseInt(n, 10)).filter((n) => n > 0))]
          : [];
        if (state.tab !== "tracker") state.tab = "planner";
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

  // ========== RESTOCK HISTORY (locally learned, Spud-style) ==========
  // While a Torn tab is open the abroad feed is snapshotted every minute; 0 ->
  // positive transitions are recorded as restock events. Predictions then use
  // the MEDIAN of observed gaps instead of trusting the static restock model,
  // which fixes items whose modelled interval is faster than reality (e.g.
  // Neumune Tablets in Switzerland repeatedly promising stock that isn't there).
  // History shape: { "dest:id": { name, samples:[[tSec,q],...], restocks:[tSec,...], misses, lastPred } }
  const HIST_KEY = "ttp_restock_history_v1";
  const MAX_SAMPLES = 240; // ~4h at 60s cadence
  const MAX_RESTOCKS = 40;
  const MEDIA_URL = "https://travel.mediabros.cc"; // shared 24/7 restock logger (Spud Travel backend)

  function getHistory() {
    try {
      return JSON.parse(localStorage.getItem(HIST_KEY) || "{}");
    } catch (e) {
      return {};
    }
  }
  function saveHistory(h) {
    try {
      localStorage.setItem(HIST_KEY, JSON.stringify(h));
    } catch (e) {
      /* ignore */
    }
  }

  // Record a feed snapshot; detects restock events and quantity declines.
  function recordSnapshot(abroad) {
    if (!abroad || !abroad.stocks) return;
    const h = getHistory();
    const nowSec = Math.floor(_ttpNow() / 1000);
    let changed = false;
    for (const [key, c] of Object.entries(abroad.stocks)) {
      for (const st of c.stocks || []) {
        const k = key + ":" + st.id;
        let e = h[k];
        if (!e) e = h[k] = { name: st.name, samples: [], restocks: [], misses: 0 };
        if (e.name !== st.name) e.name = st.name;
        const prev = e.samples.length ? e.samples[e.samples.length - 1] : null;
        if (!prev || prev[1] !== st.quantity || nowSec - prev[0] > 300) {
          e.samples.push([nowSec, st.quantity]);
          if (e.samples.length > MAX_SAMPLES) e.samples.shift();
          // Restock event: previous snapshot was 0 and now > 0.
          if (prev && prev[1] === 0 && st.quantity > 0) {
            e.restocks.push(nowSec);
            if (e.restocks.length > MAX_RESTOCKS) e.restocks.shift();
            e.misses = 0; // a fresh observed cycle resets the miss counter
          }
          changed = true;
        }
        // Miss correction: still empty past a predicted restock -> the interval
        // estimate was too fast; widen it progressively (up to 2x after 4 misses).
        if (st.quantity === 0 && e.lastPred && nowSec > e.lastPred + 120) {
          e.misses = (e.misses || 0) + 1;
          e.lastPred = nowSec; // don't double-count the same miss
          changed = true;
        }
      }
    }
    if (changed) saveHistory(h);
  }

  // Next restock from local history: median observed gap, rolled forward to the
  // upcoming cycle, widened by any unfulfilled predictions (miss correction).
  function localRestockCycles(destKey, id) {
    const e = getHistory()[destKey + ":" + id];
    if (!e || e.restocks.length < 2)
      return { nextMs: null, intervalMin: null, cycles: e ? e.restocks.length : 0 };
    const rs = e.restocks;
    const gaps = [];
    for (let i = 1; i < rs.length; i++) gaps.push(rs[i] - rs[i - 1]);
    gaps.sort((a, b) => a - b);
    const widen = 1 + Math.min(1, 0.25 * (e.misses || 0));
    const med = Math.round(gaps[Math.floor(gaps.length / 2)] * widen);
    let next = rs[rs.length - 1] + med;
    const nowMs = _ttpNow();
    while (next * 1000 < nowMs) next += med;
    // Stamp the prediction so recordSnapshot can detect misses (still empty past
    // the predicted time) and widen the interval on the next pass.
    const h = getHistory();
    if (h[destKey + ":" + id]) {
      h[destKey + ":" + id].lastPred = next; // unix seconds
      saveHistory(h);
    }
    return { nextMs: next * 1000, intervalMin: Math.round(med / 60), cycles: rs.length };
  }

  // Locally-learned depletion rate (units/min, already buffered by SELL_SAFETY)
  // from the median of observed quantity declines.
  function localDepletionRate(destKey, id) {
    const e = getHistory()[destKey + ":" + id];
    if (!e || !e.samples || e.samples.length < 3) return null;
    const rates = [];
    for (let i = 1; i < e.samples.length; i++) {
      const t0 = e.samples[i - 1][0], q0 = e.samples[i - 1][1];
      const t1 = e.samples[i][0], q1 = e.samples[i][1];
      const dt = (t1 - t0) / 60;
      if (dt >= 1 && q0 > q1 && q1 >= 0) rates.push((q0 - q1) / dt);
    }
    if (!rates.length) return null;
    rates.sort((a, b) => a - b);
    return rates[Math.floor(rates.length / 2)] * SELL_SAFETY;
  }

  // Shared 24/7 restock logger (same backend the Spud Travel script uses).
  // Returns { "dest:id": { cycles, intervalMin, next } } or null (non-fatal).
  async function fetchBackend(force) {
    const url = MEDIA_URL.replace(/\/$/, "") + "/predictions";
    if (!force) {
      const cached = getCached(url);
      if (cached) return cached;
    }
    try {
      const data = await gmFetch(url);
      if (!data || !data.items) throw new Error("backend: unexpected response");
      apiCache[url] = { data: data.items, ts: Date.now() };
      return data.items;
    } catch (e) {
      return null;
    }
  }
  let _backend = null; // cached mediabros predictions map

  // Unified restock estimate with source priority:
  //   live (PromBot nextRestock) > cloud (mediabros) > local history > model.
  // The static model is deliberately capped at 'med': its interval can be wrong
  // (the Neumune/Switzerland bug), so a model-only prediction must never rank
  // like a confirmed one. Returns { nextMs, source, level, label } or null.
  function restockSource(s, entry, destKey, id, nowMs) {
    // Stale-feed guard: a "live" nextRestock from a feed older than 10 minutes
    // may already be past (stale export); do not present it as actionable.
    const feedAgeMin =
      lastData && lastData.fetchedAt ? (_ttpNow() - lastData.fetchedAt) / 60000 : 0;
    const live =
      s && s.nextRestock != null && feedAgeMin <= 10 ? toMs(s.nextRestock) : null;
    if (live != null && live > nowMs)
      return { nextMs: live, source: "live", level: "high", label: "live" };
    const local = destKey ? localRestockCycles(destKey, id) : { nextMs: null, cycles: 0 };
    const cloud = (_backend && destKey && _backend[destKey + ":" + id]) || null;
    if (cloud && cloud.next && (cloud.cycles || 0) >= (local.cycles || 0)) {
      const cm = toMs(cloud.next);
      if (cm != null)
        return {
          nextMs: cm,
          source: "cloud",
          level: (cloud.cycles || 0) >= 4 ? "high" : "med",
          label: "cloud",
        };
    }
    if (local.nextMs && local.cycles >= 2)
      return {
        nextMs: local.nextMs,
        source: "local",
        level: local.cycles >= 4 ? "high" : "med",
        label: "learned",
      };
    const model = itemNextRestockMs(s, entry, nowMs);
    if (model != null) {
      const rel = (entry && entry.rel) || "low";
      return {
        nextMs: model,
        source: "model",
        level: rel === "low" ? "low" : "med", // model-only is never 'high'
        label: "model",
      };
    }
    return null;
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
  const RESTOCK_FRESH_GRACE_MIN = 10; // default "land right after a restock" tolerance when the stock window is negative
  // A restock older than this (relative to landing) is treated as already sold
  // out: 90+ minutes of buyers picking the shelf clean is not a landing plan,
  // even if a naive sell-rate extrapolation still "predicts survivors".
  function restockGraceMs(stockWindowMin) {
    const w = Number(stockWindowMin) || 0;
    return ((w > 0 ? w : RESTOCK_FRESH_GRACE_MIN) + RESTOCK_CUSHION_MIN) * 60000;
  }
  // Predicted minutes until an in-stock item sells out, from the model's sellRate
  // (mirrors foreign-stock: buffered so we err toward 'sells out sooner').
  const SELL_SAFETY = 1.15;
  function depletionInfo(qty, entry, destKey, id) {
    if (qty > 0) {
      // Prefer the fastest known decline so we err toward "sells out sooner".
      const rates = [];
      const localRate = destKey ? localDepletionRate(destKey, id) : null;
      if (localRate && isFinite(localRate) && localRate > 0) rates.push(localRate);
      if (entry && typeof entry.sellRate === "number" && isFinite(entry.sellRate))
        rates.push(entry.sellRate * SELL_SAFETY);
      if (rates.length) {
        const rate = Math.max(...rates);
        if (rate > 0) return { depletesMin: qty / rate, rate };
      }
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
  function landingAvailability(s, entry, nowMs, arrivalMs, stockWindowMin, destKey) {
    const qty = typeof s.quantity === "number" ? s.quantity : 0;
    if (qty > 0) {
      const conf = { level: "high", label: "high" };
      const dep = depletionInfo(qty, entry, destKey, s.id);
      const flightMin = (arrivalMs - nowMs) / 60000;
      const beforeLand = dep ? dep.depletesMin - flightMin : null; // + = after landing, - = before
      // Stock must still be on the shelf when you finish buying on the ground
      // (buy buffer + stock window). Items that sell out before that are only
      // useful if a restock lands in time. Only positive stock windows extend
      // the requirement — the default -1 means "land right after a restock"
      // (short window), which never shortens the plain buy-buffer time.
      const minSurviveMin = state.bufferMin + Math.max(0, stockWindowMin || 0);
      if (beforeLand != null && beforeLand < minSurviveMin) {
        // In stock now, but likely sold out before you finish buying.
        if (state.respectStock) {
          const nrMs = itemNextRestockMs(s, entry, nowMs);
          const graceMs = restockGraceMs(stockWindowMin);
          if (nrMs != null && nrMs <= arrivalMs && arrivalMs - nrMs > graceMs) {
            // Restock happens long before landing — its fresh stock will be
            // gone by the time you arrive (stock window says land ~N min after
            // a restock, not 95 minutes after one).
            return {
              status: "empty",
              qty: 0,
              note:
                "restocks " +
                Math.max(1, Math.round((arrivalMs - nrMs) / 60000)) +
                "m before you land — won't still be stocked",
              conf,
            };
          }
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
          const soon = beforeLand < 0;
          const soonMin = Math.max(1, Math.round(soon ? -beforeLand : beforeLand));
          return {
            status: "empty",
            qty: 0,
            note: soon
              ? "depletes ~" + soonMin + "m before you land"
              : "sells out ~" + soonMin + "m after you land — not enough time to buy",
            conf,
          };
        }
        return {
          status: "instock",
          qty,
          note: "in stock",
          conf,
          depletion: {
            sellsOutBeforeLand: beforeLand < 0,
            beforeLanding: Math.max(1, Math.round(beforeLand < 0 ? -beforeLand : beforeLand)),
          },
        };
      }
      // Survives through the buying window — plainly buyable. Quantity still on
      // the shelf when you land: current stock minus what the buffered sell
      // rate eats during the flight (mirrors restockSurvival). Without a sell
      // rate, assume the full current stock is still buyable.
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
          beforeLanding: null, // plain "in stock" — no sells-out noise
        },
      };
    }
    // Out of stock: confidence gate + restock-vs-landing. The confidence now
    // reflects the SOURCE (live/cloud/learned/model), so model-only guesses are
    // held to the same standard as the user's confidence setting.
    const src = restockSource(s, entry, destKey, s.id, nowMs);
    const conf = { level: src ? src.level : "low", label: src ? src.label : "low" };
    if (confRank(state.restockConfidence || "med") > confRank(conf.level)) {
      return { status: "empty", qty: 0, note: "restock too uncertain", conf };
    }
    const nrMs = src ? src.nextMs : null;
    const byMs = arrivalMs + (stockWindowMin || 0) * 60000 - RESTOCK_CUSHION_MIN * 60000;
    const graceMs = restockGraceMs(stockWindowMin);
    // Only claim "restocked before you land" when the restock truly precedes
    // arrival AND is fresh enough to still be on the shelf (stock window); a
    // positive stockWindow can push byMs past arrival, and restocks after
    // landing belong to the post-arrival wait path below.
    if (
      nrMs != null &&
      nrMs <= byMs &&
      nrMs <= arrivalMs &&
      arrivalMs - nrMs <= graceMs
    ) {
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
    if (nrMs != null && nrMs <= arrivalMs && arrivalMs - nrMs > graceMs) {
      return {
        status: "empty",
        qty: 0,
        note:
          "restocks " +
          Math.max(1, Math.round((arrivalMs - nrMs) / 60000)) +
          "m before you land — won't still be stocked",
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

  // ========== DEPARTURE PLANNING (local time) ==========
  // Format a unix-ms timestamp as the user's local HH:MM (DST-safe via Date).
  function localHHMM(ms) {
    const d = new Date(ms);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  // When should the user LEAVE so the item is on the shelf when they land?
  //   now    - in stock on arrival (or a restock lands before arrival): go now
  //   timed  - leave at departAtMs (local time) so arrival meets the restock
  //   null   - no viable departure window
  function departurePlan(s, entry, nowMs, oneWayMin, destKey, stockWindowMin) {
    const oneWayMs = oneWayMin * 60000;
    const arrivalMs = nowMs + oneWayMs;
    if (typeof s.quantity === "number" && s.quantity > 0) {
      const ld = landingAvailability(s, entry, nowMs, arrivalMs, stockWindowMin, destKey);
      if (ld.status !== "empty")
        return {
          status: "now",
          departAtMs: nowMs,
          landAtMs: arrivalMs,
          ld,
          source: ld.conf ? { label: ld.conf.label, level: ld.conf.level } : null,
        };
      // In stock now but will be gone: a restock may still land in time.
    }
    const src = restockSource(s, entry, destKey, s.id, nowMs);
    if (!src || !(src.nextMs > nowMs)) return null;
    const departAtMs = src.nextMs - oneWayMs;
    if (departAtMs < nowMs - 5 * 60000) return null; // window already passed
    return {
      status: departAtMs <= nowMs ? "now" : "timed",
      departAtMs,
      landAtMs: src.nextMs,
      source: { label: src.label, level: src.level },
    };
  }

  // ========== CORE COMPUTATION ==========
  // Total net-of-nothing (pre-travel-cost) profit over `trips` consecutive round
  // trips to one destination, with EACH trip's buy-list allocated against the
  // shelf that will actually remain at ITS landing. Trip 1 uses the landing
  // availability already computed for the main buy list; later trips face that
  // same shelf after it kept draining at the buffered sell rate for another
  // round trip — and it only refills when the item's restock cycle fits inside
  // a round trip. Returns null when no candidate has a usable depletion rate,
  // so the caller can keep the flat trips × trip-profit estimate rather than
  // invent one. Pure apart from scratch fields on `cands` (c._shelfLevel).
  function simulateWindowProfit(cands, trips, roundTripMin, cap, budget, destKey) {
    const rateOf = new Map();  // cand -> buffered units/min, or null
    const refillOf = new Map(); // cand -> fresh-cycle qty when its restock cycle fits, else null
    let anyRate = false;
    for (const c of cands) {
      const qty = typeof c.s.quantity === "number" ? c.s.quantity : 0;
      const dep = depletionInfo(qty, c.entry, destKey, c.id);
      rateOf.set(c, dep ? dep.rate : null);
      if (dep) anyRate = true;
      const itv =
        c.entry && typeof c.entry.interval === "number" && c.entry.interval > 0
          ? c.entry.interval
          : null;
      // A restock helps later trips only if another cycle completes within one
      // round trip; the fresh shelf is the modeled cycle quantity (fall back to
      // what the feed showed this cycle).
      refillOf.set(
        c,
        itv && itv <= roundTripMin ? modelRestockQty(c.entry) || c.stockQty : null,
      );
    }
    if (!anyRate) return null;

    const sorted = [...cands].sort((a, b) => b.unitNet - a.unitNet);
    let windowProfit = 0;
    for (let k = 1; k <= trips; k++) {
      let remaining = budget;
      let slotsUsed = 0;
      for (const c of sorted) {
        if (remaining < 1 || slotsUsed >= cap) break;
        let shelf;
        if (k === 1) {
          shelf = c.stockQty; // same landing availability the main buy list used
        } else {
          const rate = rateOf.get(c);
          const rf = refillOf.get(c);
          if (rf != null) {
            shelf = rf; // a fresh cycle lands between trips
          } else {
            const prev = c._shelfLevel != null ? c._shelfLevel : c.stockQty;
            shelf = rate != null ? prev - rate * roundTripMin : 0; // no refill, no rate -> assume drained
          }
          shelf = Math.floor(shelf);
        }
        const q = Math.max(
          0,
          Math.min(cap - slotsUsed, Math.floor(remaining / c.cost), shelf),
        );
        // What you buy comes off the same shelf later trips buy from.
        c._shelfLevel = shelf - q;
        if (q <= 0) continue;
        remaining -= c.cost * q;
        slotsUsed += q;
        windowProfit += c.unitNet * q;
      }
    }
    return windowProfit;
  }

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
      const candsById = {};
      let rowDepart = null;
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
          landing = landingAvailability(s, entry, nowMs, arrivalMs, state.stockWindow, key);
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
          s, // original feed entry - needed for departure planning
          entry,
        });
        candsById[s.id] = cands[cands.length - 1];
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
          id: c.id,
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
      // Repeat trips compete with the same shelf: it keeps draining at the
      // learned depletion rate while you fly back and forth, and refills only
      // when a restock cycle fits inside a round trip. Allocate each trip
      // against the shelf remaining at its own landing instead of assuming the
      // trip-1 list repeats verbatim; without a depletion rate the flat
      // trips × trip-profit estimate is kept (no invented numbers).
      let windowProfit = trips * tripProfitNet;
      if (trips > 1 && cands.length) {
        const sim = simulateWindowProfit(
          cands,
          trips,
          roundTripMin,
          cap,
          state.budget,
          key,
        );
        if (sim != null) windowProfit = sim - travelCost * trips;
      }

      const top = buyList.slice(0, 3);
      const nrv = nerveInfo(roundTripMin, nerve);

      // Departure guidance: prefer an item that is buyable on arrival ("now");
      // otherwise the earliest timed departure across the whole buy list.
      let timedDepart = null;
      for (const b of buyList) {
        const c0 = candsById[b.id];
        if (!c0) continue;
        const dep = departurePlan(c0.s, c0.entry, nowMs, oneWay, key, state.stockWindow);
        if (!dep) continue;
        if (dep.status === "now") {
          rowDepart = dep;
          break;
        }
        if (!timedDepart || dep.departAtMs < timedDepart.departAtMs) timedDepart = dep;
      }
      if (!rowDepart) rowDepart = timedDepart;

      rows.push({
        key,
        name: dc.name,
        city: dc.city,
        oneWay,
        travelCost,
        cap,
        depart: null, // filled below
        departSort: -Infinity,
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
      const row = rows[rows.length - 1];
      row.depart = rowDepart;
      row.departSort = rowDepart ? rowDepart.departAtMs : -Infinity;
    }

    // Sort for table default: recommended (PPH high, or window profit when window
    // active). Prediction-driven routes are DEMOTED by confidence: a destination
    // that only works because the static model claims a restock (the old
    // Neumune/Switzerland phantom) can no longer outrank real in-stock items.
    const sortKey = windowMin != null ? "windowProfit" : "pph";
    const confDiscount = { high: 1, med: 0.75, low: 0.5 };
    for (const r of rows) {
      const t0 = r.top.length ? r.top[0] : null;
      const predicted = !!(t0 && t0.landing && t0.landing.status === "restock");
      const lvl = predicted && t0.landing.conf ? t0.landing.conf.level : "high";
      // Only scale positive PPH - a discount would flatter money-losing routes.
      r.rankPph =
        r.pph > 0 ? r.pph * (confDiscount[lvl] != null ? confDiscount[lvl] : 0.5) : r.pph;
    }
    rows.sort((a, b) => b.rankPph - a.rankPph || b[sortKey] - a[sortKey]);
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
        const src0 = restockSource(s, entry, key, s.id, nowMs);
        const R = src0 ? src0.nextMs : null;
        const rate =
          entry && typeof entry.sellRate === "number" && isFinite(entry.sellRate)
            ? entry.sellRate
            : null;

        // --- Scenario "now": land at now + flight ---
        const arrivalNow = nowMs + oneWay * 60000;
        const ld = landingAvailability(s, entry, nowMs, arrivalNow, state.stockWindow, key);
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
          const conf = { level: src0 ? src0.level : "low", label: src0 ? src0.label : "low" };
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

  // ========== ITEM TRACKER ==========
  // For each user-tracked item, work out when to LEAVE for every destination
  // that stocks it so the item is freshly restocked (per the stock window) at
  // arrival. Reuses departurePlan ("now" = go immediately, "timed" = leave at
  // departAtMs) and re-checks the shelf at the planned arrival so the advice is
  // honest: destinations where even the timed departure doesn't work out are
  // dropped, and restock predictions below the confidence threshold are skipped.
  function computeItemTimer(abroad, items, models) {
    const nowMs = _ttpNow();
    const groups = [];
    for (const id of state.trackedItems) {
      const it = items[id];
      const rows = [];
      for (const key of Object.keys(CONFIG.destinations)) {
        const dc = CONFIG.destinations[key];
        const oneWay = dc.time[state.mode] != null ? dc.time[state.mode] : dc.time.standard;
        const stock = (abroad.stocks && abroad.stocks[key] && abroad.stocks[key].stocks) || [];
        const s = stock.find((x) => x.id === id);
        if (!s) continue;
        const entry = models && models[key] ? models[key][s.id] : null;
        const dep = departurePlan(s, entry, nowMs, oneWay, key, state.stockWindow);
        if (!dep) continue; // no restock lands in a usable window
        let ld = dep.ld || null;
        if (dep.status === "timed") {
          // Re-evaluate the shelf at the planned (future) arrival.
          ld = landingAvailability(s, entry, nowMs, dep.landAtMs, state.stockWindow, key);
        }
        if (!ld || ld.status === "empty") continue;
        if (
          ld.status === "restock" &&
          ld.conf &&
          confRank(state.restockConfidence || "med") > confRank(ld.conf.level)
        )
          continue; // too speculative per the user's confidence setting
        rows.push({
          key,
          name: dc.name,
          city: dc.city,
          oneWay,
          unitNet:
            it && parseFloat(it.market_value) > 0
              ? parseFloat(it.market_value) * (state.netPct / 100) - s.cost
              : null,
          qtyNow: typeof s.quantity === "number" ? s.quantity : 0,
          status: dep.status,
          departAtMs: dep.departAtMs,
          landAtMs: dep.landAtMs,
          ld,
        });
      }
      rows.sort((a, b) => a.departAtMs - b.departAtMs);
      groups.push({ id, name: it ? it.name : "#" + id, rows });
    }
    return { groups, nowMs };
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
  // Tab + item tracker refs
  let plannerWrap = null,
    trackerWrap = null,
    trackResultsEl = null,
    trackDatalistEl = null,
    trackSearchInp = null,
    tabBtnPlanner = null,
    tabBtnTracker = null;

  // Column definitions for the sortable table
  const COLUMNS = [
    { key: "name", label: "Destination" },
    { key: "roundTripMin", label: "Time (RT)" },
    { key: "tripProfitNet", label: "Trip profit" },
    { key: "pph", label: "PPH" },
    { key: "windowProfit", label: "Window profit" },
    { key: "budgetSpent", label: "Budget spent" },
    { key: "departSort", label: "Depart (local)" },
  ];

  function colorFor(v) {
    return v >= 0 ? "#3fb950" : "#f85149";
  }
  // Pill badge for the buy-at-arrival status. cls: ok | wait | bad | mut.
  function badge(text, cls, title) {
    return `<span class="ttp-badge ${cls}"${title ? ` title="${title}"` : ""}>${text}</span>`;
  }
  function landingTag(ld) {
    if (!ld) return "";
    const conf = ld.conf ? ld.conf.label : "";
    if (ld.status === "restock") {
      const before = ld.beforeLanding != null ? ld.beforeLanding : "?";
      const inMin = ld.restockIn != null ? ld.restockIn : "?";
      // Post-arrival restock: beforeLanding is negative (or 0 when the
      // restock coincides with landing); use the note instead.
      if (typeof before === "number" && before <= 0) {
        return (
          badge("RESTOCKS +" + Math.max(1, -before) + "m AFTER LAND", "wait", "Restocks in ~" + inMin + "m from now (~" + -before + "m after you land) — " + conf) +
          (conf ? ` <span class="ttp-conf">${conf}</span>` : "")
        );
      }
      return (
        badge("RESTOCKS ~" + before + "m BEFORE LAND", "wait", "Restocks in ~" + inMin + "m from now — " + conf) +
        (conf ? ` <span class="ttp-conf">${conf}</span>` : "")
      );
    }
    if (ld.status === "instock" && ld.depletion) {
      if (ld.depletion.sellsOutBeforeLand)
        return badge("GONE ~" + ld.depletion.beforeLanding + "m BEFORE LAND", "bad", "In stock now, but predicted sold out ~" + ld.depletion.beforeLanding + "m before you land");
      if (ld.depletion.beforeLanding != null)
        return (
          badge("IN STOCK", "ok") +
          ` <span class="ttp-conf">sells out ~${ld.depletion.beforeLanding}m after you land</span>`
        );
    }
    if (ld.status === "instock")
      return badge("IN STOCK", "ok");
    // empty with a useful note
    if (ld.note && ld.note !== "empty at landing")
      return badge("EMPTY", "bad", ld.note) + (conf ? ` <span class="ttp-conf">${conf}</span>` : "");
    return badge("EMPTY", "bad");
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
        ? money(best.windowProfit) +
          " over " +
          best.trips +
          " trips in your " +
          hours(computed.windowMin) +
          " active window"
        : signed(best.tripProfitNet) +
          " per trip · " +
          pphStr(best.pph) +
          " · ROI " +
          (best.roi != null ? best.roi.toFixed(1) + "%" : "—");
      html += `<div class="ttp-reco" style="background:rgba(40,167,69,0.12);border:1px solid rgba(40,167,69,0.5);border-radius:6px;padding:8px 10px;margin-bottom:8px;">`;
      html += `<div style="font-weight:bold;color:#28a745;">★ Recommended route${useWindow ? " (active window)" : ""}</div>`;
      html += `<div><b>${best.name} (${best.city})</b> — ${useWindow ? metric : ""}</div>`;
      html += `<div style="color:#bbb;font-size:12px;">${useWindow ? "PPH " + pphStr(best.pph) + " · " : ""}RT ${hours(best.roundTripMin)} · Buy: ${topBuy}</div>`;
      // Departure times live in the table's "Depart (local)" column — the
      // recommended route is always the top row there, so no duplicate here.
      if (second) {
        html += `<div style="color:#bbb;font-size:12px;margin-top:4px;">Runner-up: <b>${second.name}</b> — ${signed(second.tripProfitNet)}/trip · ${pphStr(second.pph)}</div>`;
      }
      if (best && best.nerve && typeof best.nerve.now === "number") {
        const n = best.nerve;
        if (state.nerveCare && n.waste > state.nerveWasteLimit) {
          const doSpend = Math.max(0, n.waste - state.nerveWasteLimit);
          html += `<div style="color:#e2a03f;font-size:12px;margin-top:4px;">Nerve ${n.now}/${n.max} — this RT wastes <b>~${n.waste}</b> nerve. Spend <b>${doSpend}</b> (down to ~${n.spendTo}) before leaving to avoid capping mid-flight.</div>`;
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
          ? ` · <span style="color:#d29922;">${depItem.conf.label} confidence</span>`
          : "";
      const departTxt = timedPick
        ? `Depart in <b>${hours(depItem.dep)}</b> — land <b>${depItem.after}m</b> after restock${confLbl}`
        : "Depart <b>now</b> (stock verified at arrival)";
      const fitsTxt =
        state.sleepHours > 0
          ? c.fits
            ? `Fits your ${state.sleepHours}h sleep — set an alarm`
            : `Arrival overruns your ${state.sleepHours}h sleep — will wake mid-trip`
          : "Set sleep hours to time the restock";
      html += `<div class="ttp-sleep" style="background:rgba(79,195,247,0.10);border:1px solid rgba(79,195,247,0.45);border-radius:6px;padding:8px 10px;margin-bottom:8px;">`;
      html += `<div style="font-weight:bold;color:#58a6ff;">Sleep plan — best item stocked at arrival</div>`;
      html += `<div>Fly to <b>${c.name} (${c.city})</b> — one-way ${hours(c.oneWay)} · ${departTxt}</div>`;
      html += `<div style="color:#bbb;font-size:12px;">${signed(c.profitNet)} net (spend ${money(c.budgetSpent)}, ${c.slots} slots) · Buy: ${top}</div>`;
      html += `<div style="color:#bbb;font-size:12px;">${fitsTxt}</div>`;
      if (sleep.rows.length > 1) {
        html += `<div style="color:#888;font-size:11px;margin-top:3px;">Alternatives: ${sleep.rows
          .slice(1, 4)
          .map((r) => `${r.name} ${signed(r.profitNet)}${r.fits ? "" : " (over budget)"}`)
          .join(" · ")}</div>`;
      }
      html += `</div>`;
    } else if (sleep && !sleep.rows.length) {
      html += `<div class="ttp-sleep" style="background:rgba(79,195,247,0.10);border:1px solid rgba(79,195,247,0.45);border-radius:6px;padding:8px 10px;margin-bottom:8px;">`;
      html += `<div style="font-weight:bold;color:#58a6ff;">Sleep plan</div>`;
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

    let rowIdx = 0;
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
      const idx = rowIdx++;
      html += `<tr class="ttp-row" data-idx="${idx}" style="border-bottom:1px solid rgba(255,255,255,0.06);${isBest ? "background:rgba(40,167,69,0.08);" : ""}cursor:pointer;">`;
      html += `<td style="padding:5px 6px;"><b style="color:#f2f2f2;">${r.name}</b><br><span style="color:#c9c9c9;font-size:11px;">${r.city}</span></td>`;
      html += `<td style="padding:5px 6px;white-space:nowrap;"><span style="color:#f2f2f2;font-weight:600;">${hours(r.roundTripMin)}</span><br><span style="color:#b7bdc5;font-size:11px;">1-way ${hours(r.oneWay)}${r.travelCost ? " · cost " + money(r.travelCost) : ""}</span></td>`;
      html += `<td style="padding:5px 6px;white-space:nowrap;color:${colorFor(r.tripProfitNet)};font-weight:bold;">${signed(r.tripProfitNet)}</td>`;
      html += `<td style="padding:5px 6px;white-space:nowrap;color:${colorFor(r.pph)};">${pphStr(r.pph)}</td>`;
      html += `<td style="padding:5px 6px;white-space:nowrap;color:${colorFor(r.windowProfit)};">${computed.windowMin != null ? signed(r.windowProfit) + ' <span style="color:#888;font-size:11px;">(' + r.trips + "×)</span>" : "—"}</td>`;
      html += `<td style="padding:5px 6px;white-space:nowrap;color:#aaa;">${money(r.budgetSpent)}</td>`;
      // Depart (local): when to head to the airport for the headline item
      {
        let depHtml = '<span class="ttp-badge mut">—</span>';
        if (r.depart) {
          if (r.depart.status === "now") {
            depHtml = badge("LEAVE NOW", "ok");
          } else {
            const inMin = Math.max(0, Math.round((r.depart.departAtMs - _ttpNow()) / 60000));
            depHtml =
              badge(localHHMM(r.depart.departAtMs), "wait") +
              ` <span class="ttp-conf">in ${inMin}m</span>`;
          }
          if (r.depart.source && r.depart.source.label)
            depHtml += ` <span class="ttp-conf">${r.depart.source.label}</span>`;
        }
        html += `<td style="padding:5px 6px;white-space:nowrap;">${depHtml}</td>`;
      }
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
      // Expandable detail row: the FULL buy list with per-item profit lines.
      const detail = r.buyList
        .map(
          (b) =>
            `<tr><td style="padding:2px 6px;color:#c9d1d9;">${b.name}</td>` +
            `<td style="padding:2px 6px;color:#c9d1d9;">×${b.qty}</td>` +
            `<td style="padding:2px 6px;color:#8b949e;">@${money(b.cost)}</td>` +
            `<td style="padding:2px 6px;color:${colorFor(b.unitNet)};">${signed(b.unitNet)}/u</td>` +
            `<td style="padding:2px 6px;color:${colorFor(b.profit)};font-weight:600;">${signed(b.profit)}</td>` +
            `<td style="padding:2px 6px;">${landingTag(b.landing)}</td></tr>`,
        )
        .join("");
      html +=
        `<tr class="ttp-detail" data-detail="${idx}" style="display:none;background:rgba(88,166,255,0.04);">` +
        `<td colspan="7" style="padding:6px 18px;">` +
        `<div style="color:#8b949e;font-size:11px;margin-bottom:2px;">Buy list — ${r.name} · spend ${money(r.budgetSpent)} · ${r.slots}/${r.cap} slots</div>` +
        `<table style="width:100%;border-collapse:collapse;font-size:11px;">` +
        `<thead><tr style="color:#8b949e;text-align:left;"><th style="padding:2px 6px;">Item</th><th style="padding:2px 6px;">Qty</th><th style="padding:2px 6px;">Buy</th><th style="padding:2px 6px;">Net/unit</th><th style="padding:2px 6px;">Profit</th><th style="padding:2px 6px;">Arrival</th></tr></thead>` +
        `<tbody>${detail}</tbody></table></td></tr>`;
    }
    html += "</tbody></table>";
    tableWrap.innerHTML = html;

    // wire row clicks: toggle the per-item profit detail row
    tableWrap.querySelectorAll("tr.ttp-row").forEach((tr) => {
      tr.addEventListener("click", () => {
        const d = tableWrap.querySelector(
          'tr.ttp-detail[data-detail="' + tr.getAttribute("data-idx") + '"]',
        );
        if (d) d.style.display = d.style.display === "none" ? "" : "none";
      });
    });

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
  // ---- Tab switching ----
  function setTab(tab) {
    state.tab = tab === "tracker" ? "tracker" : "planner";
    saveState();
    if (plannerWrap) plannerWrap.style.display = state.tab === "planner" ? "" : "none";
    if (trackerWrap) trackerWrap.style.display = state.tab === "tracker" ? "" : "none";
    const on = "background:#0d1117;color:#58a6ff;";
    const off = "background:#161b22;color:#9aa4b2;";
    if (tabBtnPlanner)
      tabBtnPlanner.style.cssText = tabBtnPlanner.style.cssText.replace(
        /background:[^;]+;color:[^;]+;/,
        state.tab === "planner" ? on : off,
      );
    if (tabBtnTracker)
      tabBtnTracker.style.cssText = tabBtnTracker.style.cssText.replace(
        /background:[^;]+;color:[^;]+;/,
        state.tab === "tracker" ? on : off,
      );
    if (state.tab === "tracker") {
      updateItemOptions();
      buildTracker();
    }
  }

  // ---- Item tracker: add / remove / options / render ----
  const MAX_TRACKED = 10;
  function addTrackedItem(raw) {
    if (!lastData || !trackSearchInp || !trackDatalistEl) return;
    const q = String(raw || "").trim().toLowerCase();
    if (!q) return;
    // Exact id, else exact name, else first name containing the text.
    let id = parseInt(q, 10);
    if (!(id > 0 && lastData.items[id])) {
      id = null;
      for (const opt of trackDatalistEl.options) {
        const [oid, nm] = opt.value.split("|");
        if (nm.toLowerCase() === q) { id = parseInt(oid, 10); break; }
      }
      if (id == null) {
        for (const opt of trackDatalistEl.options) {
          const [oid, nm] = opt.value.split("|");
          if (nm.toLowerCase().includes(q)) { id = parseInt(oid, 10); break; }
        }
      }
    }
    if (!(id > 0)) { trackSearchInp.value = ""; return; }
    if (!state.trackedItems.includes(id) && state.trackedItems.length < MAX_TRACKED)
      state.trackedItems.push(id);
    trackSearchInp.value = "";
    saveState();
    buildTracker();
  }
  function removeTrackedItem(id) {
    state.trackedItems = state.trackedItems.filter((n) => n !== id);
    saveState();
    buildTracker();
  }
  // Rebuild the datalist from current abroad data (id|name pairs).
  function updateItemOptions() {
    if (!trackDatalistEl || !lastData) return;
    trackDatalistEl.innerHTML = "";
    const byId = new Map();
    for (const key of Object.keys(CONFIG.destinations)) {
      const stock =
        (lastData.abroad.stocks && lastData.abroad.stocks[key] && lastData.abroad.stocks[key].stocks) || [];
      for (const s of stock) {
        const it = lastData.items[s.id];
        if (!it || it.tradeable === false) continue;
        if (!byId.has(s.id)) byId.set(s.id, { name: it.name || "#" + s.id, dests: 0 });
        byId.get(s.id).dests++;
      }
    }
    for (const [id, v] of [...byId.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
      const o = document.createElement("option");
      o.value = id + "|" + v.name;
      o.label = v.name + (v.dests > 1 ? ` (${v.dests} dest)` : "");
      trackDatalistEl.appendChild(o);
    }
  }

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
    updateItemOptions();
    buildTracker();
    updateStatus();
    if (statusEl) statusEl.style.color = "#bbb";
  }

  function buildTracker() {
    if (!trackResultsEl) return;
    // Chips (tracked items)
    const chips = document.getElementById("ttp-track-chips");
    if (chips) {
      chips.innerHTML = "";
      if (!state.trackedItems.length) {
        const hint = document.createElement("span");
        hint.style.cssText = "color:#9aa4b2;font-size:12px;";
        hint.textContent = "Nothing tracked yet — search an item above and hit Track.";
        chips.appendChild(hint);
      }
      for (const id of state.trackedItems) {
        const chip = document.createElement("span");
        chip.style.cssText =
          "display:inline-flex;align-items:center;gap:5px;background:#161b22;border:1px solid #30363d;border-radius:12px;padding:2px 8px;font-size:11px;";
        const it = lastData && lastData.items[id];
        const nm = document.createElement("span");
        nm.textContent = it ? it.name : "#" + id;
        chip.appendChild(nm);
        const x = document.createElement("button");
        x.textContent = "×";
        x.title = "Stop tracking";
        x.style.cssText =
          "background:none;border:none;color:#f85149;font-size:13px;cursor:pointer;padding:0;line-height:1;";
        x.addEventListener("click", () => removeTrackedItem(id));
        chip.appendChild(x);
        chips.appendChild(chip);
      }
    }
    // Results
    if (!lastData) {
      trackResultsEl.innerHTML =
        '<div style="color:#9aa4b2;font-size:12px;">Click Refresh to load stock data first.</div>';
      return;
    }
    if (!state.trackedItems.length) {
      trackResultsEl.innerHTML = "";
      return;
    }
    const t = computeItemTimer(lastData.abroad, lastData.items, lastData.model || {});
    let html = "";
    for (const g of t.groups) {
      html += `<div style="margin-bottom:10px;">`;
      html += `<div style="font-weight:bold;color:#58a6ff;font-size:13px;">${g.name}</div>`;
      if (!g.rows.length) {
        html += `<div style="color:#9aa4b2;font-size:12px;">No usable restock window at any destination with your stock window + confidence settings.</div>`;
      }
      for (const r of g.rows) {
        const qty = r.ld && r.ld.qty != null ? r.ld.qty : "?";
        const conf =
          r.ld && r.ld.conf && r.ld.conf.level !== "high"
            ? ` · <span style="color:#d29922;">${r.ld.conf.label} confidence</span>`
            : "";
        const after =
          r.ld && r.ld.beforeLanding != null ? ` · ${Math.max(0, r.ld.beforeLanding)}m after restock` : "";
        const when =
          r.status === "now"
            ? `Leave <b>now</b> — land in ${hours(r.oneWay)}`
            : `Leave in <b>${hours(Math.max(0, (r.departAtMs - t.nowMs) / 60000))}</b> (at ${localHHMM(r.departAtMs)})`;
        const net =
          r.unitNet != null
            ? ` · <span style="color:${colorFor(r.unitNet)};">${signed(r.unitNet)}/unit</span>`
            : "";
        html += `<div style="font-size:12px;margin-top:3px;"><b>${r.name}</b> — ${when} · ~${qty} on shelf${after}${net}${conf}</div>`;
      }
      html += `</div>`;
    }
    trackResultsEl.innerHTML = html;
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
        '<span style="color:#58a6ff;">⏳ Fetching abroad prices + item values + restock/nerve…</span>';

    try {
      const [abroad, items, model, nerve, backend] = await Promise.all([
        fetchAbroad(force),
        fetchItems(force),
        fetchModelSafe(force),
        fetchNerveSafe(force),
        fetchBackend(force),
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
      _backend = backend; // shared 24/7 restock predictions (may be null)
      recordSnapshot(abroad); // feed the locally-learned restock history
      renderResults();
    } catch (e) {
      if (seq !== updateSeq) return;
      if (statusEl)
        statusEl.innerHTML = '<span style="color:#dc3545;">' + (e.message || e) + "</span>";
    } finally {
      loading = false;
      if (seq === updateSeq) {
        const b = document.getElementById("ttp-refresh");
        if (b) {
          b.disabled = false;
          b.textContent = "Refresh";
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
    wrap.style.cssText = "display:flex;flex-direction:column;gap:3px;" + (extra || "");
    const lab = document.createElement("label");
    lab.textContent = label;
    lab.className = "ttp-label";
    const err = document.createElement("div");
    err.className = "ttp-err";
    err.style.display = "none";
    wrap.appendChild(lab);
    wrap.appendChild(input);
    wrap.appendChild(err);
    // Inputs report problems through this — shown inline under the field.
    input.__setErr = (msg) => {
      if (msg) {
        err.textContent = msg;
        err.style.display = "block";
        input.classList.add("ttp-bad");
      } else {
        err.textContent = "";
        err.style.display = "none";
        input.classList.remove("ttp-bad");
      }
    };
    return wrap;
  }
  function numInput(value, min, step, onchange, w, opts) {
    const inp = document.createElement("input");
    inp.type = "number";
    inp.className = "ttp-input";
    inp.min = min != null ? min : "";
    inp.step = step || 1;
    inp.value = value;
    inp.style.width = w || "70px";
    if (opts && opts.title) inp.title = opts.title;
    let lastValid = typeof value === "number" && isFinite(value) ? value : null;
    const check = () => {
      const raw = parseFloat(inp.value);
      if (inp.value === "" || isNaN(raw)) return { err: "Enter a number" };
      if (min != null && raw < min) return { err: "Min " + min };
      if (opts && opts.max != null && raw > opts.max) return { err: "Max " + opts.max };
      if (opts && opts.integer && Math.floor(raw) !== raw) return { err: "Whole numbers only" };
      return { v: raw };
    };
    // Responsive: validate as the user types, commit (and save) on change.
    inp.addEventListener("input", () => {
      const r = check();
      if (inp.__setErr) inp.__setErr(r.err || null);
    });
    inp.addEventListener("change", () => {
      const r = check();
      if (r.err) {
        if (inp.__setErr) inp.__setErr(r.err);
        inp.value = lastValid != null ? lastValid : ""; // revert invalid input
        return;
      }
      if (inp.__setErr) inp.__setErr(null);
      lastValid = r.v;
      onchange(r.v);
    });
    return inp;
  }
  // Budget input: accepts short-hand (2k / 2m / 1.5b), commas while typing and
  // plain numbers. Comma-formats on commit; invalid text shows an inline error
  // and reverts to the last good value.
  function parseMoney(raw) {
    if (raw == null) return null;
    const s = String(raw).trim().replace(/[,\s_]/g, "");
    if (!s) return null;
    const m = s.match(/^(\d+(?:\.\d+)?)([kmb])?$/i);
    if (!m) return null;
    const mult = m[2] ? { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()] : 1;
    const v = Math.round(parseFloat(m[1]) * mult);
    return isFinite(v) && v >= 0 ? v : null;
  }
  function moneyInput(value, onchange, w) {
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "ttp-input";
    inp.inputMode = "numeric";
    inp.placeholder = "2m · 1,000,000";
    inp.title = "Accepts 2k = 2,000, 2m = 2,000,000, 1.5b = 1,500,000,000, commas and plain numbers";
    inp.value = value != null && isFinite(Number(value)) ? Number(value).toLocaleString("en-US") : "";
    inp.style.width = w || "110px";
    let lastValid = typeof value === "number" && isFinite(value) ? value : null;
    const fmt = (v) => (v == null ? "" : v.toLocaleString("en-US"));
    inp.addEventListener("input", () => {
      if (inp.value.trim() === "") {
        if (inp.__setErr) inp.__setErr("Enter an amount (e.g. 2m or 2,000,000)");
        return;
      }
      const v = parseMoney(inp.value);
      if (inp.__setErr)
        inp.__setErr(v == null ? "Use 2m = 2,000,000, 2k = 2,000, commas, or a plain number" : null);
    });
    inp.addEventListener("change", () => {
      const v = parseMoney(inp.value);
      if (v == null) {
        inp.value = fmt(lastValid); // revert invalid input
        if (inp.__setErr) inp.__setErr(null);
        return;
      }
      lastValid = v;
      inp.value = fmt(v);
      if (inp.__setErr) inp.__setErr(null);
      onchange(v);
    });
    return inp;
  }
  // "?" header button → modal explaining every control.
  const HELP_ITEMS = [
    ["Travel method", "Flight class. Airstrip / WLT / Business are FREE and faster; only Standard pays the fare shown per destination."],
    ["Item capacity", "How many items you can carry home in one trip."],
    ["Net % (trade)", "Percent of market value you actually receive when selling. 97 is typical."],
    ["Budget (capital)", "Money you're willing to spend per trip. Short-hand works: 2m = 2,000,000, 2k = 2,000, 1.5b = 1,500,000,000. Commas are fine."],
    ["Buy buffer (min)", "Minutes you'll realistically spend shopping after landing. Items predicted to sell out before you finish buying are skipped."],
    ["Active start / end", "Your awake window. Departure times and active-window recommendations target this period; 'Now' sets start to the current time."],
    ["Sleep (h)", "Hours you'll be asleep — the sleep plan times a departure so the best item is freshly restocked when you wake up."],
    ["Stock on arrival", "Only recommend items that will actually be on the shelf when you land (respects depletion + restock timing)."],
    ["Stock window (min)", "Land ~N minutes AFTER a restock. Negative (default) = land as soon as possible after the restock. Restocks older than this window before landing are treated as already sold out."],
    ["Restock confidence", "Minimum trust level for restock predictions (live PromBot data / restock model). Lower = more speculative routes shown."],
    ["Nerve waste", "Tick the box if you care about nerve capping mid-flight. When on, warns if the round trip wastes more than N nerve and suggests how much to spend first."],
    ["Item tracker (tab)", "Track up to 10 specific items and get exact leave-times: for each destination stocking the item, when to depart so it's freshly restocked (per your stock window) at arrival, with expected shelf size and net per unit."],
    ["API key", "Optional Torn API key (items + nerve). Needed for the nerve-waste estimate; stored locally in your browser only."],
    ["Auto-refresh", "Re-fetch live prices and restock data every 10 minutes."],
  ];
  const HELP_FLOW = [
    ["Set your trip basics", "Pick a travel method (Airstrip / WLT / Business are free and fast), then enter your item capacity, net % (97 is typical for trades) and how much money you want to spend per trip."],
    ["Tell it when you're awake", "Set your active start/end times and, if you like, how many hours you'll sleep. Departure times and recommendations are timed around this."],
    ["Hit Refresh", "The script pulls live foreign stock, restock cycles and prices, then scores every destination by profit per hour."],
    ["Pick a route from the table", "The highlighted row is the best route right now. Every row shows round-trip time, profit, profit-per-hour and departure times so you know exactly when to leave."],
    ["Read the stock badges", "IN STOCK = on the shelf when you land. RESTOCKS = item refills near your arrival (timing shown). EMPTY / GONE = don't bother — it won't be there."],
    ["Optional: sleep plan", "Enter your sleep hours and the planner times a departure so the best item is freshly restocked exactly when you wake up."],
    ["Optional: nerve + API key", "Tick Nerve waste and add an API key to get a warning when a round trip would waste nerve, plus how much to spend before flying."],
    ["Optional: item tracker", "Switch to the Item tracker tab, search for items you're hunting, and it tells you exactly when to leave for each destination so they're freshly restocked when you land."],
  ];
  function showHelp() {
    const old = document.getElementById("ttp-help");
    if (old) {
      old.remove();
      return;
    }
    const ov = document.createElement("div");
    ov.id = "ttp-help";
    ov.className = "ttp-help-ov";
    ov.addEventListener("click", (e) => {
      if (e.target === ov) ov.remove();
    });
    const card = document.createElement("div");
    card.className = "ttp-help-card";
    const h = document.createElement("h3");
    h.textContent = "Travel Planner — how to use";
    const close = document.createElement("button");
    close.className = "ttp-input";
    close.textContent = "Close";
    close.style.cssText = "margin-top:10px;cursor:pointer;";
    close.addEventListener("click", () => ov.remove());
    card.appendChild(h);
    // Step-by-step flow
    const fh = document.createElement("div");
    fh.className = "h-sec";
    fh.textContent = "The flow";
    card.appendChild(fh);
    HELP_FLOW.forEach(([k, d], i) => {
      const row = document.createElement("div");
      row.className = "h-row";
      const key = document.createElement("span");
      key.className = "h-k";
      key.textContent = i + 1 + ". " + k + " — ";
      const desc = document.createElement("span");
      desc.className = "h-d";
      desc.textContent = d;
      row.appendChild(key);
      row.appendChild(desc);
      card.appendChild(row);
    });
    // Field reference
    const rh = document.createElement("div");
    rh.className = "h-sec";
    rh.textContent = "Settings reference";
    card.appendChild(rh);
    for (const [k, d] of HELP_ITEMS) {
      const row = document.createElement("div");
      row.className = "h-row";
      const key = document.createElement("span");
      key.className = "h-k";
      key.textContent = k + " — ";
      const desc = document.createElement("span");
      desc.className = "h-d";
      desc.textContent = d;
      row.appendChild(key);
      row.appendChild(desc);
      card.appendChild(row);
    }
    card.appendChild(close);
    ov.appendChild(card);
    document.body.appendChild(ov);
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
      "background:#0d1117;color:#fff;border:1px solid #30363d;border-radius:8px;" +
      "display:flex;flex-direction:column;box-sizing:border-box;" +
      "box-shadow:0 6px 24px rgba(0,0,0,0.7);overflow-y:auto;overflow-x:auto;" +
      "font-family:Arial,sans-serif;font-size:13px;";
    rootEl = container;

    const header = document.createElement("div");
    header.id = "ttp-header";
    header.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;padding:9px 14px;background:#161b22;border-bottom:1px solid #30363d;cursor:grab;user-select:none;";
    const title = document.createElement("span");
    title.textContent = "Torn Travel Planner";
    title.style.cssText = "font-weight:bold;font-size:15px;color:#58a6ff;";
    const btns = document.createElement("div");
    btns.style.cssText = "display:flex;gap:6px;";
    const minBtn = document.createElement("button");
    minBtn.className = "ttp-min";
    minBtn.textContent = "–";
    minBtn.title = "Minimize";
    minBtn.style.cssText = btnStyle();
    minBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setMinimized(!panelMinimized);
    });
    const helpBtn = document.createElement("button");
    helpBtn.className = "ttp-helpbtn";
    helpBtn.textContent = "?";
    helpBtn.title = "How to use the travel planner";
    helpBtn.style.cssText =
      "background:#21262d;color:#e6edf3;border:1px solid #6e7681;border-radius:50%;width:22px;height:22px;font-size:13px;font-weight:bold;line-height:1;padding:0;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;";
    helpBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showHelp();
    });
    btns.appendChild(helpBtn);
    btns.appendChild(minBtn);
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
    modeSel.className = "ttp-sel";
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
      { max: 10000, integer: true, title: "Items you can carry home in one trip" },
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
      { max: 100, title: "Percent of market value you actually receive when selling" },
    );
    const budInp = moneyInput(state.budget, (v) => {
      state.budget = v;
      onSettingsChange();
    }, "110px");
    const bufInp = numInput(
      state.bufferMin,
      0,
      1,
      (v) => {
        state.bufferMin = Math.max(0, v || 0);
        onSettingsChange();
      },
      "55px",
      { max: 240, integer: true, title: "Minutes you'll spend buying after you land" },
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
      { max: 24, title: "Hours you'll be asleep before returning" },
    );

    const startInp = document.createElement("input");
    startInp.type = "time";
    startInp.className = "ttp-input";
    startInp.title = "When you're normally awake and flying";
    startInp.value = state.activeStart;
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
    endInp.className = "ttp-input";
    endInp.title = "When you normally go to sleep";
    endInp.value = state.activeEnd;
    endInp.style.width = "90px";
    endInp.addEventListener("change", () => {
      state.activeEnd = endInp.value;
      onSettingsChange();
    });

    const respectCb = document.createElement("input");
    respectCb.type = "checkbox";
    respectCb.className = "ttp-cb";
    respectCb.title = "Only buy items that will actually be in stock when you land";
    respectCb.checked = state.respectStock;
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
      { max: 2880, integer: true, title: "Land ~N min after a restock (negative = as soon as possible)" },
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
      { max: 1000, integer: true, title: "Warn when the round trip wastes more than this much nerve" },
    );
    // Nerve waste only matters when the user says so — the checkbox gates it.
    const nerveCb = document.createElement("input");
    nerveCb.type = "checkbox";
    nerveCb.className = "ttp-cb";
    nerveCb.checked = !!state.nerveCare;
    nerveCb.title = "Care about nerve capping while you're in the air";
    const nwRow = document.createElement("div");
    nwRow.style.cssText = "display:flex;gap:5px;align-items:center;";
    nwRow.appendChild(nerveCb);
    nwRow.appendChild(nwInp);
    nerveCb.addEventListener("change", () => {
      state.nerveCare = nerveCb.checked;
      nwInp.disabled = !nerveCb.checked;
      nwInp.style.opacity = nerveCb.checked ? "1" : "0.45";
      onSettingsChange();
    });
    if (!state.nerveCare) {
      nwInp.disabled = true;
      nwInp.style.opacity = "0.45";
    }
    const keyInp = document.createElement("input");
    keyInp.type = "password";
    keyInp.placeholder = "API key (items + nerve)";
    keyInp.value = state.apiKey || "";
    keyInp.className = "ttp-input";
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
    confSel.className = "ttp-sel";
    confSel.addEventListener("change", () => {
      state.restockConfidence = confSel.value;
      onSettingsChange();
    });

    const autoCb = document.createElement("input");
    autoCb.type = "checkbox";
    autoCb.className = "ttp-cb";
    autoCb.title = "Re-fetch live prices and restock data every 10 minutes";
    autoCb.checked = state.autoRefresh;
    autoCb.addEventListener("change", () => {
      state.autoRefresh = autoCb.checked;
      saveState();
    });
    const refreshBtn = document.createElement("button");
    refreshBtn.id = "ttp-refresh";
    refreshBtn.textContent = "Refresh";
    refreshBtn.style.cssText =
      "padding:5px 14px;background:#238636;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;";
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
    ctl.appendChild(field("Nerve waste", nwRow));
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

    // ---- Tabs: keep the planner uncluttered; item tracking gets its own view ----
    const tabBar = document.createElement("div");
    tabBar.style.cssText = "display:flex;gap:6px;padding:8px 14px 0;";
    function tabBtn(label, key) {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText =
        "padding:5px 14px;border:1px solid #30363d;border-bottom:none;border-radius:6px 6px 0 0;background:#161b22;color:#9aa4b2;font-size:12px;font-weight:bold;cursor:pointer;";
      b.addEventListener("click", () => setTab(key));
      return b;
    }
    tabBtnPlanner = tabBtn("Planner", "planner");
    tabBtnTracker = tabBtn("Item tracker", "tracker");
    tabBar.appendChild(tabBtnPlanner);
    tabBar.appendChild(tabBtnTracker);

    // Wrap everything that belongs to the planner view so tabs toggle one node.
    plannerWrap = document.createElement("div");
    while (body.firstChild) plannerWrap.appendChild(body.firstChild);
    body.appendChild(tabBar);
    body.appendChild(plannerWrap);

    // Tracker view: item search + tracked list + leave-times.
    trackerWrap = document.createElement("div");
    trackerWrap.style.display = "none";
    trackerWrap.style.cssText = "padding:10px 14px;";
    const trackRow = document.createElement("div");
    trackRow.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap;";
    trackSearchInp = document.createElement("input");
    trackSearchInp.className = "ttp-input";
    trackSearchInp.placeholder = "Search item to track…";
    trackSearchInp.style.cssText = "flex:1;min-width:180px;";
    trackSearchInp.setAttribute("list", "ttp-items-dl");
    trackDatalistEl = document.createElement("datalist");
    trackDatalistEl.id = "ttp-items-dl";
    const addBtn = document.createElement("button");
    addBtn.textContent = "Track";
    addBtn.title = "Add this item to the tracker";
    addBtn.style.cssText =
      "padding:5px 12px;background:#238636;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;";
    addBtn.addEventListener("click", () => addTrackedItem(trackSearchInp.value));
    trackSearchInp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addTrackedItem(trackSearchInp.value);
    });
    trackRow.appendChild(trackSearchInp);
    trackRow.appendChild(trackDatalistEl);
    trackRow.appendChild(addBtn);
    trackerWrap.appendChild(trackRow);
    const trackChips = document.createElement("div");
    trackChips.id = "ttp-track-chips";
    trackChips.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;";
    trackerWrap.appendChild(trackChips);
    trackResultsEl = document.createElement("div");
    trackResultsEl.style.cssText = "margin-top:10px;";
    trackerWrap.appendChild(trackResultsEl);
    body.appendChild(trackerWrap);

    setTab(state.tab === "tracker" ? "tracker" : "planner");

    container.appendChild(body);
    document.body.appendChild(container);

    // ---- Minified left-side button (Torn PDA / mobile friendly) ----
    const miniBtn = document.createElement("button");
    miniBtn.style.cssText =
      "display:none;position:fixed;left:8px;top:" +
      (state.miniTop || 130) +
      "px;" +
      "z-index:100000;width:46px;height:46px;border-radius:50%;" +
      "background:#161b22;border:2px solid #4fc3f7;color:#58a6ff;font-size:20px;cursor:pointer;" +
      "box-shadow:0 3px 10px rgba(0,0,0,0.6);align-items:center;justify-content:center;" +
      "touch-action:none;user-select:none;";
    miniBtn.textContent = "Travel";
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

    const st = document.createElement("style");
    st.textContent =
      "#ttp-root{--ttp-bg:#0d1117;--ttp-panel:#161b22;--ttp-border:#30363d;--ttp-muted:#8b949e;--ttp-accent:#58a6ff;} " +
      "#ttp-root .ttp-table tbody tr.ttp-row:hover{background:rgba(88,166,255,0.07);} " +
      "#ttp-root .ttp-table tbody tr.ttp-row{cursor:pointer;} " +
      "#ttp-root .ttp-table tbody tr.ttp-detail:hover{background:rgba(88,166,255,0.04) !important;} " +
      "#ttp-root .ttp-table thead th{position:sticky;top:0;background:#161b22;z-index:2;} " +
      "#ttp-root table th:hover{color:#fff;} " +
      "#ttp-root .ttp-badge{display:inline-block;padding:1px 7px;border-radius:9px;font-size:10px;font-weight:700;letter-spacing:0.3px;white-space:nowrap;vertical-align:middle;} " +
      "#ttp-root .ttp-badge.ok{color:#3fb950;background:rgba(63,185,80,0.15);border:1px solid rgba(63,185,80,0.45);} " +
      "#ttp-root .ttp-badge.wait{color:#d29922;background:rgba(210,153,34,0.13);border:1px solid rgba(210,153,34,0.45);} " +
      "#ttp-root .ttp-badge.bad{color:#f85149;background:rgba(248,81,73,0.13);border:1px solid rgba(248,81,73,0.45);} " +
      "#ttp-root .ttp-badge.mut{color:#8b949e;background:rgba(139,148,158,0.12);border:1px solid rgba(139,148,158,0.4);} " +
      "#ttp-root .ttp-conf{color:#8b949e;font-size:10px;} " +
      "@media (max-width:700px){#ttp-root{top:12px;left:50%;width:calc(100vw - 16px)!important;" +
      "max-height:calc(100vh - 24px)!important;max-height:calc(100dvh - 24px)!important;} #ttp-root #ttp-body{padding:8px;}" +
      "#ttp-root #ttp-controls{gap:6px;} #ttp-root #ttp-summary{font-size:12px;}" +
      "#ttp-root .ttp-table{font-size:11px;} #ttp-root .ttp-table th,#ttp-root .ttp-table td{padding:4px 4px;}" +
      "#ttp-root .ttp-badge{font-size:9px;padding:1px 5px;letter-spacing:0;} " +
      "#ttp-root .ttp-detail td{padding:4px 8px !important;}}" +
      "@media (max-width:520px){" +
      "#ttp-root th[data-key=\"windowProfit\"],#ttp-root td:nth-child(5)," +
      "#ttp-root th[data-key=\"budgetSpent\"],#ttp-root td:nth-child(6){display:none;}" +
      "#ttp-root .ttp-table{display:block;overflow-x:auto;white-space:nowrap;}}" +
      "#ttp-root .ttp-label{color:#9aa4b2;font-size:10px;text-transform:uppercase;letter-spacing:.4px;font-weight:600;} " +
      "#ttp-root .ttp-err{color:#f85149;font-size:10px;line-height:1.25;} " +
      "#ttp-root .ttp-input,#ttp-root .ttp-sel{background:#0b0f14;border:1px solid #30363d;color:#e6edf3;border-radius:5px;padding:4px 8px;font-size:12px;transition:border-color .15s,box-shadow .15s;} " +
      "#ttp-root .ttp-input:hover,#ttp-root .ttp-sel:hover{border-color:#4d5763;} " +
      "#ttp-root .ttp-input:focus,#ttp-root .ttp-sel:focus{border-color:#58a6ff;outline:none;box-shadow:0 0 0 2px rgba(88,166,255,.25);} " +
      "#ttp-root .ttp-input.ttp-bad,#ttp-root .ttp-sel.ttp-bad{border-color:#f85149;background:rgba(248,81,73,.07);} " +
      "#ttp-root .ttp-input:disabled{opacity:.45;} " +
      "#ttp-root .ttp-cb{width:14px;height:14px;accent-color:#238636;cursor:pointer;} " +
      "#ttp-help{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif;}" +
      "#ttp-help .ttp-help-card{background:#161b22;border:1px solid #30363d;border-radius:10px;max-width:640px;width:92vw;max-height:80vh;overflow-y:auto;padding:16px 20px;box-shadow:0 8px 30px rgba(0,0,0,.8);color:#e6edf3;font-size:12px;}" +
      "#ttp-help h3{margin:0 0 12px;color:#58a6ff;font-size:14px;}" +
      "#ttp-help .h-row{margin-bottom:8px;line-height:1.45;}" +
      "#ttp-help .h-k{color:#e6edf3;font-weight:700;}" +
      "#ttp-help .h-d{color:#9aa4b2;}" +
      "#ttp-help .h-sec{margin:14px 0 6px;padding-top:8px;border-top:1px solid #30363d;color:#58a6ff;font-weight:700;font-size:12px;}";
    document.head.appendChild(st);
  }

  function btnStyle() {
    return "background:none;border:none;color:#aaa;font-size:15px;cursor:pointer;padding:0 6px;line-height:1;";
  }

  function setMinimized(min) {
    panelMinimized = !!min;
    if (rootEl) rootEl.style.display = panelMinimized ? "none" : "flex";
    if (miniButtonEl) miniButtonEl.style.display = panelMinimized ? "flex" : "none";
    state.panelHidden = panelMinimized;
    saveState();
    const mb = document.querySelector("#ttp-root #ttp-header .ttp-min");
    if (mb) mb.textContent = panelMinimized ? "+" : "–";
  }

  // ========== INIT ==========
  let refreshTimer = null;
  let statusTimer = null;
  let feedTimer = null;
  function scheduleAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (state.autoRefresh) loadData();
    }, CONFIG.autoRefreshMs);
    // Spud-style minute cadence: keeps the local restock history granular.
    // loadData() is cache- and rate-limited, so this stays network-cheap.
    if (feedTimer) clearInterval(feedTimer);
    feedTimer = setInterval(() => {
      if (state.autoRefresh) loadData();
    }, 60000);
    // Keep tracker countdowns fresh every minute even without new data.
    setInterval(() => {
      if (!panelMinimized && state.tab === "tracker" && lastData) buildTracker();
    }, 60000);
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
      computeItemTimer,
      RESTOCK_CUSHION_MIN,
      POST_ARRIVAL_MINS,
      SELL_SAFETY,
      HIST_KEY,
      getHistory,
      recordSnapshot,
      localRestockCycles,
      localDepletionRate,
      restockSource,
      departurePlan,
      localHHMM,
      setBackend(v) {
        _backend = v;
      },
    };
    module.exports.__setClock = function (fn) {
      _ttpNow = fn || Date.now;
    };
  }
})();
