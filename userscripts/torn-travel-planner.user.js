// ==UserScript==
// @name         Torn Travel Planner
// @namespace    http://tampermonkey.net/
// @version      1.9
// @description  Plan profitable travel routes using live abroad prices (YATA /api/v1/travel/export/) + Torn market values. Hero card answers where to fly, when to leave (with a live countdown) and what to buy; route cards below for the rest. Budget allocation, catch-the-restock departures, sleep planning, item tracker, cash on hand from your API key.
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
  // v1.9: route-card UI (hero + cards), replacing the sortable table. See HELP_ITEMS
  // for what every control does now.

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
              // Carry the Torn error code so callers can tell "key access too
              // low" (16) from a real failure.
              const err = new Error("API Error: " + data.error.error);
              err.code = data.error.code;
              reject(err);
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

  // Nerve comes from the bars selection, NOT basic: basic returns only
  // level/gender/player_id/name/status, so the old `nerve.nerve` /
  // `nerve_maximum` / `nerve_fulltime` reads were all undefined and the nerve
  // warning could never fire. bars returns
  // {current, maximum, increment, interval, ticktime, fulltime} (the last two
  // are relative seconds, not timestamps).
  function normalizeBars(data) {
    const n = data && data.nerve;
    if (!n || typeof n.current !== "number" || typeof n.maximum !== "number") return null;
    const perNerveSec = n.increment > 0 && n.interval > 0 ? n.interval / n.increment : 300;
    return {
      nerve: n.current,
      nerve_maximum: n.maximum,
      // Unix seconds when the bar is full (nerveInfo wants an absolute time).
      nerve_fulltime: Math.floor(Date.now() / 1000) + Math.max(0, (n.maximum - n.current) * perNerveSec),
    };
  }

  async function fetchBars(force) {
    const key = state.apiKey;
    if (!key) return null;
    if (!force && ttpInBackoff()) return null; // cool-down after error, skip
    const url = "https://api.torn.com/user/?selections=bars&key=" + encodeURIComponent(key);
    if (!force) {
      const cached = getCached(url);
      if (cached) return cached;
    }
    try {
      const data = await gmFetch(url);
      const bars = normalizeBars(data);
      if (!bars) {
        ttpApiErr();
        return null;
      }
      apiCache[url] = { data: bars, ts: Date.now() };
      ttpApiOk();
      return bars;
    } catch (e) {
      ttpApiErr();
      return null;
    }
  }

  // Non-fatal: a missing/invalid API key must not break price/stock planning.
  async function fetchBarsSafe(force) {
    return (await fetchBars(force)) || null;
  }

  // Money on hand. This is its OWN request: money needs at least Limited key
  // access, and Torn answers error 16 for the whole response when one selection
  // is out of reach, so sharing a request with bars would take the nerve read
  // down with it. Returns {state, amount} with state one of
  // ok | nokey | toolow | error (never throws).
  function moneyOnHand(data) {
    if (!data) return null;
    if (typeof data.money_onhand === "number") return data.money_onhand;
    if (typeof data.money === "number") return data.money;
    if (data.money && typeof data.money.money_onhand === "number") return data.money.money_onhand;
    return null;
  }
  let _cashKey = null; // key the cached access verdict was decided for
  let _cash = { state: "nokey", amount: null };

  async function fetchCash(force) {
    const key = state.apiKey;
    if (!key) return { state: "nokey", amount: null };
    // A key that can't read money won't start being able to until it changes,
    // so don't re-ask the API every refresh.
    if (_cashKey === key && _cash.state === "toolow" && !force) return _cash;
    const url = "https://api.torn.com/user/?selections=money&key=" + encodeURIComponent(key);
    if (!force) {
      const cached = getCached(url);
      if (cached) {
        _cashKey = key;
        _cash = cached;
        return cached;
      }
    }
    let out;
    try {
      const data = await gmFetch(url);
      const amount = moneyOnHand(data);
      out = amount == null ? { state: "error", amount: null } : { state: "ok", amount: amount };
    } catch (e) {
      out = e && e.code === 16 ? { state: "toolow", amount: null } : { state: "error", amount: null };
    }
    _cashKey = key;
    _cash = out;
    if (out.state !== "error") apiCache[url] = { data: out, ts: Date.now() };
    return out;
  }

  async function fetchCashSafe(force) {
    try {
      return await fetchCash(force);
    } catch (e) {
      return { state: "error", amount: null };
    }
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
    return h > 0 ? h + "h" + (m ? " " + m + "m" : "") : m + "m";
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

  // The history blob is hundreds of KB, and the planner reads it per item from
  // inside nested loops, so JSON.parse-ing it on every lookup froze the tab for
  // seconds on each settings change (measured: ~2.5s with a 4h-old history).
  // Keep the parsed object in memory instead, and coalesce writes to one
  // localStorage.setItem per second.
  const HISTORY_FLUSH_MS = 1000;
  let _history = null;
  let _historyDirty = false;
  let _historyFlushTimer = null;
  function getHistory() {
    if (_history) return _history;
    try {
      _history = JSON.parse(localStorage.getItem(HIST_KEY) || "{}");
    } catch (e) {
      _history = {};
    }
    return _history;
  }
  function saveHistory(h) {
    _history = h;
    _historyDirty = true;
    if (_historyFlushTimer) return;
    _historyFlushTimer = setTimeout(() => {
      _historyFlushTimer = null;
      flushHistory();
    }, HISTORY_FLUSH_MS);
  }
  // Write pending records out now (also called on tab hide/close so a pending
  // change isn't lost between flushes).
  function flushHistory() {
    if (!_historyDirty || !_history) return;
    _historyDirty = false;
    try {
      localStorage.setItem(HIST_KEY, JSON.stringify(_history));
    } catch (e) {
      /* ignore (quota / private mode) */
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
      }
      cands.sort((a, b) => b.unitNet - a.unitNet);

      // --- Items you can only get by leaving LATER (land right after a restock) ---
      // landingAvailability() calls these "empty at landing" (their restock lands
      // after you would arrive now), so the arrival-now filter above threw them
      // away, and departurePlan() is only consulted for items already in the buy
      // list. The one function that can time a departure could therefore never see
      // the item that needed it, which hid the most profitable item in the country
      // from the table and scored each route on the leftovers. Japan: Xanax at
      // +$100,248/unit was never mentioned, only the $437k Chopsticks plan.
      const timedCands = [];
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
        const dep = departurePlan(s, entry, nowMs, oneWay, key, state.stockWindow);
        if (!dep || dep.status !== "timed") continue; // buyable on arrival is handled above
        const lvl = dep.source ? dep.source.level : "low";
        // Same confidence gate the out-of-stock path uses: never time a departure
        // to a restock estimate we would not trust.
        if (confRank(state.restockConfidence || "med") > confRank(lvl)) continue;
        const shelf =
          modelRestockQty(entry) ||
          (typeof s.quantity === "number" && s.quantity > 0 ? s.quantity : cap * 3);
        // Landing right after the restock, so nothing has sold out yet.
        const qty = Math.floor(
          restockSurvival(shelf, entry && entry.sellRate, dep.landAtMs, dep.landAtMs),
        );
        if (!(qty > 0)) continue;
        timedCands.push({
          id: s.id,
          name: it.name || "#" + s.id,
          stockQty: qty,
          cost: s.cost,
          received,
          unitNet,
          s,
          entry,
          departAtMs: dep.departAtMs,
          landing: {
            status: "restock",
            qty,
            timed: true, // catch it by leaving later
            leaveAtMs: dep.departAtMs,
            landAtMs: dep.landAtMs,
            restockIn: Math.max(0, Math.round((dep.landAtMs - nowMs) / 60000)),
            beforeLanding: 0,
            conf: { level: lvl, label: dep.source ? dep.source.label : "low" },
            note: "leave at " + localHHMM(dep.departAtMs) + " to land right after the restock",
          },
        });
      }
      timedCands.sort((a, b) => b.unitNet - a.unitNet);

      // --- Budget allocation, capped by flight capacity ---
      // Two greedy orders, keep the better list: unit-net order can strand a small
      // budget on one expensive item, ROI order can leave slots empty with money
      // unspent. The better of the two beats either alone (measured: Mexico on a
      // $100k budget earned 18% more when the ROI order won).
      function allocate(pool) {
        const byUnit = [...pool].sort((a, b) => b.unitNet - a.unitNet);
        const ratio = (c) => (c.cost > 0 ? c.unitNet / c.cost : Infinity);
        const byRoi = [...pool].sort((a, b) => ratio(b) - ratio(a) || b.unitNet - a.unitNet);
        let best = null;
        for (const order of [byUnit, byRoi]) {
          let remaining = state.budget;
          let slots = 0;
          const list = [];
          for (const c of order) {
            if (remaining < 1) break;
            const perCap = Math.min(c.stockQty, cap);
            const byBudget = Math.floor(remaining / c.cost);
            const qty = Math.min(perCap, byBudget, cap - slots);
            if (qty <= 0) {
              if (cap > 0 && slots >= cap) break; // flight capacity full
              continue;
            }
            list.push({
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
            slots += qty;
          }
          let profit = 0,
            spend = 0;
          for (const b of list) {
            profit += b.profit;
            spend += b.spent;
          }
          const plan = { buyList: list, tripProfit: profit, budgetSpent: spend, slots };
          if (!best || plan.tripProfit > best.tripProfit) best = plan;
        }
        return best;
      }

      // Catch a restock only when that earns more than buying what is on the shelf
      // today; otherwise the plain arrival plan stands. This mirrors the
      // now-vs-timed choice computeSleepPlan already makes.
      const nowPlan = allocate(cands);
      const timedPlan = timedCands.length ? allocate(timedCands) : null;
      const useTimed =
        !!timedPlan && timedPlan.tripProfit - travelCost > nowPlan.tripProfit - travelCost;
      const pool = useTimed ? timedCands : cands;
      const buyList = (useTimed ? timedPlan : nowPlan).buyList;
      const tripProfit = (useTimed ? timedPlan : nowPlan).tripProfit;
      const budgetSpent = (useTimed ? timedPlan : nowPlan).budgetSpent;
      const slotsUsed = (useTimed ? timedPlan : nowPlan).slots;
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
      if (trips > 1 && pool.length) {
        const sim = simulateWindowProfit(
          pool,
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
      // otherwise the earliest timed departure across the chosen buy list. When a
      // timed plan won above, every item in it departs in the future, so the
      // earliest one is what the Depart column shows.
      const poolById = new Map();
      for (const c of pool) poolById.set(c.id, c);
      let timedDepart = null;
      for (const b of buyList) {
        const c0 = poolById.get(b.id);
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
        kind: useTimed ? "timed" : "now", // "timed" = leave later to catch a restock
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
  // Route cards replace the sortable table: the recommended route is the hero, every
  // other route is a peer card, and sorting is one select instead of seven clickable
  // column headers. The compute layer is untouched.
  const SORTS = [
    { key: "pph", label: "Profit per hour" },
    { key: "tripProfitNet", label: "Profit per trip" },
    { key: "windowProfit", label: "Window profit" },
    { key: "departSort", label: "Leave time" },
    { key: "budgetSpent", label: "Capital" },
    { key: "roi", label: "Return on capital" },
  ];
  let sortMetric = null; // null = the planner's own ranking

  // Panel element refs
  let rootEl = null,
    panelBody = null,
    statusEl = null,
    ageEl = null; // "feed Ns old", the only node the 1s ticker rewrites
  let summaryEl = null, // hero + sleep card
    cardsEl = null, // route card list
    cardsHeadEl = null, // count + sort control
    sortSelEl = null,
    chipsEl = null, // settings summary chips
    settingsEl = null, // the collapsible control panel
    settingsBtnEl = null;
  let countdownEl = null, // hero countdown text
    countdownTargetMs = null; // ms until the hero departure
  let miniButtonEl = null;
  let panelMinimized = false;
  let cashTxtEl = null,
    cashBtnEl = null; // cash-on-hand readout + "use it as capital" button
  // Tab + item tracker refs
  let plannerWrap = null,
    trackerWrap = null,
    trackResultsEl = null,
    trackDatalistEl = null,
    trackSearchInp = null,
    tabBtnPlanner = null,
    tabBtnTracker = null;
  // What the panel is showing right now, so loading and failure get real states
  // instead of a blank where the answer should be.
  let viewState = "idle"; // idle | loading | error
  let viewMessage = "";

  // Item names come from the feed, so they never go into innerHTML raw.
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }
  // Money is the only thing that earns colour: green up, red down.
  function colorFor(v) {
    return v >= 0 ? "var(--accent)" : "var(--neg)";
  }
  // Status chip for a buy-list item. cls: ok | wait | bad | mut.
  function badge(text, cls, title) {
    return `<span class="ttp-badge ${cls}"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</span>`;
  }
  // What the shelf will look like when you arrive. Every branch answers the same
  // question ("can I buy it when I land, and if not, when?") in the same shape.
  function landingTag(ld) {
    if (!ld) return "";
    const conf = ld.conf ? ld.conf.label : "";
    const confBit = conf && conf !== "high" ? ` <span class="ttp-conf">${esc(conf)}</span>` : "";
    // Leave-later plan: the restock lands after you would arrive now, so the
    // departure time is the actionable bit, not the arrival.
    if (ld.status === "restock" && ld.timed) {
      return badge("catch restock", "wait", ld.note + (conf ? " (" + conf + ")" : "")) + confBit;
    }
    if (ld.status === "restock") {
      const before = ld.beforeLanding != null ? ld.beforeLanding : "?";
      const inMin = ld.restockIn != null ? ld.restockIn : "?";
      if (typeof before === "number" && before <= 0) {
        return (
          badge("restocks " + Math.max(1, -before) + "m after landing", "wait",
            "Restocks in ~" + inMin + "m from now (~" + -before + "m after you land), " + conf) + confBit
        );
      }
      return (
        badge("restocks ~" + before + "m before landing", "wait",
          "Restocks in ~" + inMin + "m from now, " + conf) + confBit
      );
    }
    if (ld.status === "instock" && ld.depletion) {
      if (ld.depletion.sellsOutBeforeLand) {
        return badge("gone before landing", "bad",
          "In stock now, but predicted sold out ~" + ld.depletion.beforeLanding + "m before you land");
      }
      if (ld.depletion.beforeLanding != null) {
        return badge("in stock", "ok") +
          ` <span class="ttp-conf">sells out ~${ld.depletion.beforeLanding}m after you land</span>`;
      }
    }
    if (ld.status === "instock") return badge("in stock", "ok");
    if (ld.note && ld.note !== "empty at landing") return badge("empty", "bad", ld.note) + confBit;
    return badge("empty", "bad");
  }
  // Compact chip version for a collapsed card.
  function statusChip(row) {
    const t0 = row.top.length ? row.top[0] : null;
    const ld = t0 ? t0.landing : null;
    if (ld && ld.status === "restock" && ld.timed) return badge("catch restock", "wait", "Leave later to land right after the restock");
    if (ld && ld.status === "restock") return badge("restock at landing", "wait", "Refills around your arrival");
    if (ld && ld.status === "instock") return badge("in stock", "ok", "On the shelf when you land");
    if (ld && ld.status === "empty") return badge("empty", "bad", ld.note || "Not buyable when you land");
    return "";
  }

  // ========== HERO (the route to fly, with the countdown) ==========
  function fmtCountdown(ms) {
    const t = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(t / 3600),
      m = Math.floor((t % 3600) / 60),
      s = t % 60;
    if (h > 0) return h + "h " + m + "m" + (t < 600 ? " " + s + "s" : "");
    if (m > 0) return m + "m " + s + "s";
    return s + "s";
  }
  // One text node, rewritten only when the string changes, and never while the
  // panel is minimized or the tab is hidden.
  function tickCountdown() {
    if (!countdownEl || countdownTargetMs == null) return;
    if (panelMinimized || (typeof document !== "undefined" && document.hidden)) return;
    const left = countdownTargetMs - Date.now();
    const txt = left <= 0 ? "leave now" : "in " + fmtCountdown(left);
    if (txt !== countdownEl.textContent) countdownEl.textContent = txt;
  }

  function heroStats(row, computed) {
    const useWindow = computed.windowMin != null;
    const stats = [];
    if (row.depart && row.depart.status === "timed") {
      stats.push(
        `<div class="ttp-stat"><span class="lbl">leave at</span>` +
          `<span class="val clock" id="ttp-leave">${localHHMM(row.depart.departAtMs)}</span>` +
          `<span class="rel" id="ttp-countdown"></span></div>`,
      );
    } else {
      stats.push(
        `<div class="ttp-stat"><span class="lbl">leave</span>` +
          `<span class="val clock go" id="ttp-leave">now</span>` +
          `<span class="rel" id="ttp-countdown"></span></div>`,
      );
    }
    stats.push(
      `<div class="ttp-stat"><span class="lbl">profit per trip</span>` +
        `<span class="val pos">${signed(row.tripProfitNet)}</span></div>`,
    );
    stats.push(
      `<div class="ttp-stat"><span class="lbl">per hour</span><span class="val sm">${pphStr(row.pph)}</span></div>`,
    );
    stats.push(
      `<div class="ttp-stat"><span class="lbl">capital</span><span class="val sm">${money(row.budgetSpent)}</span>` +
        `<span class="rel">ROI ${row.roi != null ? row.roi.toFixed(1) + "%" : "n/a"}</span></div>`,
    );
    if (useWindow) {
      stats.push(
        `<div class="ttp-stat"><span class="lbl">your ${hours(computed.windowMin)} window</span>` +
          `<span class="val sm pos">${money(row.windowProfit)}</span>` +
          `<span class="rel">${row.trips} trips back to back</span></div>`,
      );
    }
    return stats.join("");
  }

  function buyListHtml(row) {
    if (!row.buyList.length) return '<div class="ttp-muted">Nothing worth buying at this destination right now.</div>';
    return (
      '<ul class="ttp-buy">' +
      row.buyList
        .map(
          (b) =>
            `<li><span class="nm">${esc(b.name)}</span><span class="qty">x${b.qty}</span>` +
            `<span class="cash">${money(b.spent)}</span><span class="cash pos">+${signed(b.unitNet)}</span>` +
            `<span class="tag">${landingTag(b.landing)}</span></li>`,
        )
        .join("") +
      "</ul>"
    );
  }

  function buildHero(computed, sleep, nerve) {
    const useWindow = computed.windowMin != null;
    // A destination row exists even when it has nothing to buy, so the hero has to
    // pick the best row that actually has a buy list, not just rows[0].
    const best = computed.rows.filter((r) => r.buyList.length && r.tripProfitNet > 0)[0] || null;
    let html = "";

    if (!best) {
      // Empty state: say which knob to loosen instead of showing nothing.
      html +=
        '<div class="ttp-hero ttp-hero-empty">' +
        '<span class="ttp-kicker">no route to fly</span>' +
        '<h2>Nothing clears a profit with these settings</h2>' +
        '<p class="ttp-muted">Every candidate is either unprofitable after trading fees or will not be on the shelf when you land. ' +
        "Try a bigger budget, a lower net % if your trades lose more than you think, or set Restock confidence to Low to see speculative routes.</p>" +
        "</div>";
      summaryEl.innerHTML = html;
      countdownEl = null;
      countdownTargetMs = null;
      return;
    }

    const topBuy = best.top.length ? best.top.map((t) => esc(t.name) + " x" + t.qty).join(", ") : "n/a";
    html += '<div class="ttp-hero">';
    html += `<span class="ttp-kicker">fly this${useWindow ? " · active window" : ""}</span>`;
    html +=
      `<div class="ttp-hero-top"><h2>${esc(best.name)}<small>${esc(best.city)} · round trip ${hours(best.roundTripMin)} · ${best.slots}/${best.cap} slots</small></h2>` +
      statusChip(best) +
      "</div>";
    html += `<div class="ttp-answer">${heroStats(best, computed)}</div>`;
    html += `<div class="ttp-hero-buy"><span class="lbl">buy before you fly</span>${buyListHtml(best)}</div>`;
    html += `<div class="ttp-hero-foot"><span>Headline: <b>${topBuy}</b></span>`;
    if (best.travelCost) html += `<span>fare ${money(best.travelCost)}</span>`;
    if (best.depart && best.depart.source && best.depart.source.label) {
      html += `<span>restock data: ${esc(best.depart.source.label)}/${esc(best.depart.source.level || "-")}</span>`;
    }
    html += "</div>";
    // Nerve warning, only when the user said they care.
    if (best.nerve && typeof best.nerve.now === "number" && state.nerveCare && best.nerve.waste > state.nerveWasteLimit) {
      const n = best.nerve;
      const doSpend = Math.max(0, n.waste - state.nerveWasteLimit);
      html += `<div class="ttp-warn">Nerve ${n.now}/${n.max}: this round trip wastes about ${n.waste} nerve. Spend ${doSpend} (down to about ${n.spendTo}) before leaving so you do not cap mid flight.</div>`;
    }
    html += "</div>";

    // Sleep plan: a different decision (what is stocked when you wake), so its own card.
    if (sleep && sleep.rows.length) {
      const c = sleep.chosen;
      const list = c.buyList.length
        ? c.buyList
            .map(
              (b) =>
                `<li><span class="nm">${esc(b.name)}</span><span class="qty">x${b.qty}</span>` +
                `<span class="cash">${money(b.spent)}</span><span class="cash pos">+${signed(b.unitNet)}</span>` +
                (b.after != null ? `<span class="tag">${b.after}m after restock</span>` : "") +
                "</li>",
            )
            .join("")
        : "";
      const timedPick = c.kind === "timed" && c.buyList[0] && c.buyList[0].dep != null;
      html += '<div class="ttp-card ttp-sleep">';
      html += '<span class="ttp-kicker">sleep plan</span>';
      html += `<div class="ttp-hero-top"><h2>${esc(c.name)}<small>${esc(c.city)} · one way ${hours(c.oneWay)}</small></h2>` +
        (c.fits ? badge("fits your sleep", "ok", "You will be awake before landing") : badge("wakes mid trip", "wait", "Arrival overruns your sleep hours")) +
        "</div>";
      html +=
        '<div class="ttp-answer ttp-answer-sm">' +
        `<div class="ttp-stat"><span class="lbl">${timedPick ? "depart in" : "leave"}</span><span class="val sm clock${timedPick ? "" : " go"}">${timedPick ? hours(c.buyList[0].dep) : "now"}</span>` +
        (timedPick ? `<span class="rel">lands ${c.buyList[0].after}m after the restock</span>` : '<span class="rel">stock verified at arrival</span>') +
        "</div>" +
        `<div class="ttp-stat"><span class="lbl">profit</span><span class="val sm pos">${signed(c.profitNet)}</span></div>` +
        `<div class="ttp-stat"><span class="lbl">spend</span><span class="val sm">${money(c.budgetSpent)}</span><span class="rel">${c.slots} slots</span></div>` +
        "</div>";
      if (list) html += `<div class="ttp-hero-buy"><span class="lbl">buy</span><ul class="ttp-buy">${list}</ul></div>`;
      if (sleep.rows.length > 1) {
        html +=
          '<div class="ttp-hero-foot"><span>Also: ' +
          sleep.rows
            .slice(1, 4)
            .map((r) => `${esc(r.name)} ${signed(r.profitNet)}${r.fits ? "" : " (over sleep)"}`)
            .join(" · ") +
          "</span></div>";
      }
      html += "</div>";
    } else if (sleep) {
      html +=
        '<div class="ttp-card ttp-sleep"><span class="ttp-kicker">sleep plan</span>' +
        '<div class="ttp-muted">No item is profitably in stock at any destination inside these settings, so there is nothing to time a wake up for.</div></div>';
    }

    summaryEl.innerHTML = html;
    // arm the countdown for the hero departure
    countdownEl = document.getElementById("ttp-countdown");
    countdownTargetMs =
      best.depart && best.depart.status === "timed" ? best.depart.departAtMs : null;
    if (countdownEl && countdownTargetMs) tickCountdown();
  }

  // ========== ROUTE CARDS ==========
  function buildCards(computed) {
    // Only routes with something to buy get a card; the hero takes the best one.
    const rows = computed.rows.filter((r) => r.buyList.length && r.tripProfitNet > 0).slice(1);
    const metric = sortMetric || (computed.windowMin != null ? "windowProfit" : "pph");
    const sorted = sortMetric
      ? rows.slice().sort((a, b) => (b[metric] || 0) - (a[metric] || 0) || b.pph - a.pph)
      : rows;
    if (sortMetric === "departSort") sorted.sort((a, b) => a.departSort - b.departSort);

    const head =
      `<span class="ttp-count">${computed.rows.length} route${computed.rows.length === 1 ? "" : "s"}` +
      `${computed.rows.length > 1 ? " · best first" : ""}</span>`;
    cardsHeadEl.innerHTML =
      head +
      `<label class="ttp-sort"><span>sort</span><select id="ttp-sort-sel">` +
      `<option value="">Recommended order</option>` +
      SORTS.map((s) => `<option value="${s.key}"${sortMetric === s.key ? " selected" : ""}>${s.label}</option>`).join("") +
      `</select></label>`;
    sortSelEl = document.getElementById("ttp-sort-sel");
    if (sortSelEl) {
      sortSelEl.addEventListener("change", () => {
        sortMetric = sortSelEl.value || null;
        renderResults();
      });
    }

    if (!sorted.length) {
      cardsEl.innerHTML =
        '<div class="ttp-muted">No other route is worth a trip right now. The hero above is the only one.</div>';
      return;
    }

    cardsEl.innerHTML = sorted
      .map((r) => {
        const dep = r.depart
          ? r.depart.status === "timed"
            ? `<span class="leave">leave ${localHHMM(r.depart.departAtMs)}</span>`
            : '<span class="leave go">leave now</span>'
          : '<span class="leave dim">no window</span>';
        const rowsHtml = r.buyList.length
          ? '<ul class="ttp-buy">' +
            r.buyList
              .map(
                (b) =>
                  `<li><span class="nm">${esc(b.name)}</span><span class="qty">x${b.qty}</span>` +
                  `<span class="cash">${money(b.spent)}</span><span class="cash pos">+${signed(b.unitNet)}</span>` +
                  `<span class="cash">${signed(b.profit)}</span><span class="tag">${landingTag(b.landing)}</span></li>`,
              )
              .join("") +
            "</ul>"
          : '<div class="ttp-muted">No buy list.</div>';
        return (
          `<article class="ttp-route" tabindex="0" role="button" aria-expanded="false">` +
          `<div class="ttp-route-top"><h3>${esc(r.name)}<small>${esc(r.city)}</small></h3>` +
          `<span class="pph">${pphStr(r.pph)}</span></div>` +
          `<div class="ttp-route-line">${dep}` +
          `<span>${signed(r.tripProfitNet)} per trip</span>` +
          `<span class="dim">${hours(r.roundTripMin)} round trip</span>` +
          `<span class="dim">${money(r.budgetSpent)} capital</span>` +
          statusChip(r) +
          "</div>" +
          `<div class="ttp-route-more">` +
          rowsHtml +
          `<div class="ttp-hero-foot"><span>ROI ${r.roi != null ? r.roi.toFixed(1) + "%" : "n/a"}</span>` +
          `<span>${r.slots}/${r.cap} slots</span>` +
          (computed.windowMin != null ? `<span>window ${signed(r.windowProfit)} over ${r.trips} trips</span>` : "") +
          (r.travelCost ? `<span>fare ${money(r.travelCost)}</span>` : "") +
          `</div></div></article>`
        );
      })
      .join("");

    cardsEl.querySelectorAll(".ttp-route").forEach((card) => {
      const toggle = () => {
        card.classList.toggle("open");
        card.setAttribute("aria-expanded", card.classList.contains("open") ? "true" : "false");
      };
      card.addEventListener("click", toggle);
      card.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          toggle();
        }
      });
    });
  }

  // Loading and failure get their own card in the hero slot: a panel that says
  // nothing while it works (or after it breaks) is worse than one that says so.
  function buildPlaceholder(kind, message) {
    const spinner = kind === "loading" ? '<span class="ttp-bars" aria-hidden="true"></span>' : "";
    const title = kind === "loading" ? "Fetching live prices and stock" : "Could not load the planner data";
    const body =
      kind === "loading"
        ? "Pulling abroad stock, restock cycles and market values, then scoring every route."
        : esc(message || "The last request failed. Check your connection or API key and refresh.");
    summaryEl.innerHTML =
      `<div class="ttp-hero ttp-hero-${kind}">${spinner}<span class="ttp-kicker">${title}</span>` +
      `<p class="ttp-muted">${body}</p>` +
      (kind === "error" ? '<button class="ttp-btn" id="ttp-retry">Retry</button>' : "") +
      "</div>";
    cardsHeadEl.innerHTML = "";
    cardsEl.innerHTML = "";
    countdownEl = null;
    countdownTargetMs = null;
    const retry = document.getElementById("ttp-retry");
    if (retry) retry.addEventListener("click", () => loadData(true));
  }

  function log(...a) {
    if (CONFIG.debug) console.log("[Travel Planner]", ...a);
  }
  // ========== RENDER ==========
  // ---- Tab switching ----
  // Shared tab styling: the active tab gets accent colors + underline so the
  // user always sees which view they're in.
  function applyTabStyles() {
    // Styling lives in the stylesheet; the markup only says which tab is current.
    if (tabBtnPlanner) tabBtnPlanner.setAttribute("aria-current", state.tab === "planner" ? "true" : "false");
    if (tabBtnTracker) tabBtnTracker.setAttribute("aria-current", state.tab === "tracker" ? "true" : "false");
  }
  function setTab(tab) {
    state.tab = tab === "tracker" ? "tracker" : "planner";
    saveState();
    if (plannerWrap) plannerWrap.style.display = state.tab === "planner" ? "" : "none";
    if (trackerWrap) trackerWrap.style.display = state.tab === "tracker" ? "" : "none";
    applyTabStyles();
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
    if (!summaryEl || !cardsEl || !cardsHeadEl) return;
    if (viewState === "loading" && !lastData) {
      buildPlaceholder("loading");
      updateStatus();
      return;
    }
    if (viewState === "error") {
      buildPlaceholder("error", viewMessage);
      updateStatus();
      return;
    }
    if (!lastData) {
      buildPlaceholder("loading");
      updateStatus();
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
      buildPlaceholder("error", "Scoring the routes failed: " + (e.message || e));
      return;
    }
    let sleep = null;
    try {
      sleep = sleepRecommendation(lastData.abroad, lastData.items, lastData.model || {});
    } catch (e) {
      sleep = null; // the sleep plan is a bonus, never a blocker
    }
    buildHero(computed, sleep, lastData.nerve);
    buildCards(computed);
    updateItemOptions();
    buildTracker();
    updateStatus();
    updateCash();
  }

  function buildTracker() {
    if (!trackResultsEl) return;
    // Tracked item chips
    const chips = document.getElementById("ttp-track-chips");
    if (chips) {
      chips.innerHTML = "";
      if (!state.trackedItems.length) {
        const hint = document.createElement("span");
        hint.className = "ttp-muted";
        hint.textContent = "Nothing tracked yet. Search an item above and hit Track.";
        chips.appendChild(hint);
      }
      for (const id of state.trackedItems) {
        const chip = document.createElement("span");
        chip.className = "ttp-chip";
        const it = lastData && lastData.items[id];
        const nm = document.createElement("span");
        nm.textContent = it ? it.name : "#" + id;
        chip.appendChild(nm);
        const x = document.createElement("button");
        x.type = "button";
        x.textContent = "×";
        x.title = "Stop tracking " + (it ? it.name : "#" + id);
        x.className = "ttp-chip-x";
        x.addEventListener("click", () => removeTrackedItem(id));
        chip.appendChild(x);
        chips.appendChild(chip);
      }
    }
    if (!lastData) {
      trackResultsEl.innerHTML =
        '<div class="ttp-muted">Hit Refresh to load stock data, then add an item to track.</div>';
      return;
    }
    if (!state.trackedItems.length) {
      trackResultsEl.innerHTML = "";
      return;
    }
    const t = computeItemTimer(lastData.abroad, lastData.items, lastData.model || {});
    let html = "";
    for (const g of t.groups) {
      html += `<div class="ttp-track-group"><h3>${esc(g.name)}</h3>`;
      if (!g.rows.length) {
        html +=
          '<div class="ttp-muted">No usable restock window at any destination with your stock window and confidence settings.</div>';
      }
      for (const r of g.rows) {
        const qty = r.ld && r.ld.qty != null ? r.ld.qty : "?";
        const conf =
          r.ld && r.ld.conf && r.ld.conf.level !== "high"
            ? `<span class="ttp-conf">${esc(r.ld.conf.label)}</span>`
            : "";
        const after =
          r.ld && r.ld.beforeLanding != null ? ` · ${Math.max(0, r.ld.beforeLanding)}m after restock` : "";
        const when =
          r.status === "now"
            ? '<span class="leave go">leave now</span>'
            : `<span class="leave">leave ${localHHMM(r.departAtMs)}</span>` +
              ` <span class="dim">in ${hours(Math.max(0, (r.departAtMs - t.nowMs) / 60000))}</span>`;
        const net =
          r.unitNet != null
            ? `<span style="color:${colorFor(r.unitNet)}">${signed(r.unitNet)}/unit</span>`
            : "";
        html +=
          `<div class="ttp-track-row"><b>${esc(r.name)}</b> <span class="dim">${esc(r.city)}</span> · ${when}` +
          ` · <span class="dim">about ${qty} on the shelf${after}</span> ${net} ${conf}</div>`;
      }
      html += "</div>";
    }
    trackResultsEl.innerHTML = html;
  }

  function updateStatus() {
    if (!statusEl) return;
    const age =
      lastData && lastData.fetchedAt
        ? Math.max(0, Math.round((Date.now() - lastData.fetchedAt) / 1000))
        : -1;
    let html = viewState === "loading" ? '<span class="ttp-loading">refreshing</span> · ' : "";
    html += `<span id="ttp-age">feed ${age >= 0 ? age + "s old" : "not loaded"}</span>`;
    if (lastData && lastData.nerve && typeof lastData.nerve.nerve === "number") {
      html += ` · nerve ${lastData.nerve.nerve}/${lastData.nerve.nerve_maximum || 100}`;
    }
    statusEl.innerHTML = html;
    ageEl = document.getElementById("ttp-age");
  }

  // The 1s ticker rewrites two small text nodes and nothing else: the feed age and
  // the hero countdown. It never re-renders the panel.
  function tick() {
    tickCountdown();
    if (ageEl && lastData && lastData.fetchedAt) {
      const s = Math.max(0, Math.round((Date.now() - lastData.fetchedAt) / 1000));
      const txt = "feed " + s + "s old";
      if (ageEl.textContent !== txt) ageEl.textContent = txt;
    }
  }

  // Cash-on-hand readout. Every state is spelled out instead of leaving a blank,
  // so a key that cannot read money says so rather than looking broken.
  function updateCash() {
    if (!cashTxtEl) return;
    const c = lastData ? lastData.cash : null;
    let text;
    let canUse = false;
    if (!c) text = "cash on hand: reading";
    else if (c.state === "ok") {
      text = "cash on hand: " + money(c.amount);
      canUse = true;
    } else if (c.state === "nokey") text = "cash on hand: add an API key to read it";
    else if (c.state === "toolow") text = "cash on hand: this key cannot read money (needs Limited access)";
    else text = "cash on hand: unavailable, hit Refresh to retry";
    cashTxtEl.textContent = text;
    if (cashBtnEl) {
      cashBtnEl.disabled = !canUse;
      cashBtnEl.title = canUse
        ? "Set Budget (capital) to " + money(c.amount)
        : "Reads money on hand from your API key. Needs money access on the key.";
    }
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
      btn.textContent = "Loading";
    }
    viewState = "loading";
    // Only blank the panel on a first load. On a refresh the old numbers stay up,
    // because stale numbers beat no numbers.
    if (!lastData) renderResults();
    else updateStatus();

    try {
      const [abroad, items, model, nerve, cash, backend] = await Promise.all([
        fetchAbroad(force),
        fetchItems(force),
        fetchModelSafe(force),
        fetchBarsSafe(force),
        fetchCashSafe(force),
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
        cash,
        fetchedAt: Date.now(),
      };
      _backend = backend; // shared 24/7 restock predictions (may be null)
      recordSnapshot(abroad); // feed the locally-learned restock history
      viewState = "idle";
      viewMessage = "";
      renderResults();
    } catch (e) {
      if (seq !== updateSeq) return;
      viewState = "error";
      viewMessage = e && e.message ? e.message : String(e);
      renderResults(); // an error card with a Retry button, not a red line
      updateCash(); // don't leave the readout stuck on "reading"
    } finally {
      loading = false;
      if (seq === updateSeq) {
        const b = document.getElementById("ttp-refresh");
        if (b) {
          b.disabled = false;
          b.textContent = "Refresh";
        }
        updateStatus(); // clears the "refreshing" marker
      }
    }
  }

  function onSettingsChange() {
    saveState();
    updateChips(); // the chip strip mirrors the settings it just changed
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
  // Budget input: accepts short-hand (2k / 2m / 1.5b), commas and plain numbers.
  // Commas appear as you type; invalid text shows an inline error and reverts to
  // the last good value on commit.
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
  // Group a digit run in threes. String-based on purpose: a 19-digit amount
  // would lose its tail if it went through Number first.
  function groupDigits(digits) {
    return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  // Re-group what the user is typing and say where the caret goes back to: it
  // stays after the same digit it was after before the commas moved. Pure, so
  // the harness can check the caret math.
  function formatMoneyTyping(raw, caret) {
    const s = String(raw);
    const upTo = s.slice(0, caret == null ? s.length : caret);
    const at = upTo.replace(/\D/g, "").length; // digits left of the caret
    let digits = s.replace(/\D/g, "");
    if (digits.length > 1) digits = digits.replace(/^0+/, ""); // no 0001234
    if (!digits) return { text: "", caret: 0 };
    const text = groupDigits(digits);
    if (at <= 0) return { text, caret: 0 };
    let seen = 0,
      pos = 0;
    while (pos < text.length) {
      if (/\d/.test(text[pos])) seen++;
      pos++;
      if (seen === at) break;
    }
    return { text, caret: pos };
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
      const raw = inp.value;
      // Plain numbers get grouped live; shorthand (2k / 1.5b) is left alone so
      // the k/m/b can still be typed.
      if (raw && !/[a-z]/i.test(raw) && raw.indexOf(".") === -1) {
        const f = formatMoneyTyping(raw, inp.selectionStart);
        if (f.text !== raw) {
          inp.value = f.text;
          inp.setSelectionRange(f.caret, f.caret);
        }
      }
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
  // "?" header button opens a modal explaining every control.
  const HELP_ITEMS = [
    ["Travel method", "Flight class. Airstrip, WLT and Business are free and faster. Only Standard pays the fare shown per destination."],
    ["Item capacity", "How many items you can carry home in one trip."],
    ["Net % (trade)", "Percent of market value you actually receive when selling. 97 is typical."],
    ["Budget (capital)", "Money you are willing to spend per trip. Short-hand works: 2m = 2,000,000, 1.5b = 1,500,000,000. Commas appear as you type. Use my money copies your cash on hand from the API key."],
    ["Active start / end", "Your awake window. Leave times and the window profit target this period. Now sets start to the current time."],
    ["Sleep (h)", "Hours you will be asleep. The sleep plan times a departure so the best item is freshly restocked when you wake."],
    ["Buy buffer (min)", "Minutes you realistically spend buying after landing."],
    ["Stock window (min)", "Aim to land this many minutes after a restock. Negative means as soon as possible after it."],
    ["Restock confidence", "Minimum trust level for restock predictions. Low shows more speculative routes."],
    ["Stock at landing", "On: only buy items that will still be on the shelf when you land. Off: also count items predicted to sell out while you are in the air."],
    ["Nerve waste", "Tick it if you care about nerve capping mid flight, then set the threshold. It warns when a round trip wastes that much nerve and says how much to spend first."],
    ["API key", "Your Torn API key. Reads market values, your nerve bar and your cash on hand. Money needs at least Limited access, market values and nerve work on a minimal key. Stored in your browser only."],
    ["Auto-refresh", "Re-fetch live prices and restock data every 10 minutes."],
    ["Settings button", "The chips above the hero show your settings at a glance. Settings opens the form, Hide settings closes it."],
    ["Route cards", "The hero card is the route to fly. Every other route is a card below. Tap or press Enter on a card for its full buy list, capital, ROI and slots."],
    ["Leave at", "Now means the item is on the shelf when you land. A clock time means leave then to land right after a restock, and the hero counts down to it. Catch restock marks those items."],
    ["Item tracker (tab)", "Track up to 10 items and get an exact leave time for every destination that stocks them."],
  ];
  const HELP_FLOW = [
    ["Set your trip basics", "Pick a travel method, then enter capacity, net % and the money you want to spend per trip."],
    ["Tell it when you are awake", "Set your active window and, if you like, how many hours you sleep. Departure times are timed around it."],
    ["Hit Refresh", "The script pulls live foreign stock, restock cycles and market values, then scores every route."],
    ["Read the hero card", "It answers the only three questions: where to fly, when to leave, and what to buy. If the leave time is a clock time, it counts down."],
    ["Check the other routes", "Cards below the hero are the alternatives, best first. Open one for its full buy list and arrival status."],
    ["Optional: sleep plan", "Fill in sleep hours and a second card times a departure so the best item is freshly restocked when you wake."],
    ["Optional: cash and nerve", "Paste an API key to see your cash on hand (one button copies it into Budget) and nerve, which warns when a round trip would cap it."],
    ["Optional: item tracker", "Switch to Item tracker, search for an item, and it tells you when to leave for each destination that stocks it."],
  ];
  function showHelp() {
    const old = document.getElementById("ttp-help");
    if (old) {
      old.remove();
      return;
    }
    const ov = document.createElement("div");
    ov.id = "ttp-help";
    const close = () => {
      ov.remove();
      document.removeEventListener("keydown", onKey);
    };
    // Escape has to close it: the click-outside path alone leaves keyboard users stuck.
    const onKey = (e) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    ov.addEventListener("click", (e) => {
      if (e.target === ov) close();
    });
    const card = document.createElement("div");
    card.className = "ttp-help-card";
    const h = document.createElement("h3");
    h.textContent = "Travel planner: how to use";
    card.appendChild(h);
    const flowHead = document.createElement("div");
    flowHead.className = "h-sec";
    flowHead.textContent = "The flow";
    card.appendChild(flowHead);
    HELP_FLOW.forEach(([k, d], i) => {
      const row = document.createElement("div");
      row.className = "h-row";
      const key = document.createElement("span");
      key.className = "h-k";
      key.textContent = i + 1 + ". " + k + " ";
      const desc = document.createElement("span");
      desc.className = "h-d";
      desc.textContent = d;
      row.appendChild(key);
      row.appendChild(desc);
      card.appendChild(row);
    });
    const refHead = document.createElement("div");
    refHead.className = "h-sec";
    refHead.textContent = "Settings reference";
    card.appendChild(refHead);
    for (const [k, d] of HELP_ITEMS) {
      const row = document.createElement("div");
      row.className = "h-row";
      const key = document.createElement("span");
      key.className = "h-k";
      key.textContent = k + ": ";
      const desc = document.createElement("span");
      desc.className = "h-d";
      desc.textContent = d;
      row.appendChild(key);
      row.appendChild(desc);
      card.appendChild(row);
    }
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "ttp-btn";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", close);
    card.appendChild(closeBtn);
    ov.appendChild(card);
    document.body.appendChild(ov);
    closeBtn.focus();
  }

  // Chips: the settings you can see at a glance. They change rarely, the answer
  // changes constantly, so the answer gets the space and these stay one line.
  function updateChips() {
    if (!chipsEl) return;
    const items = [
      state.mode.charAt(0).toUpperCase() + state.mode.slice(1),
      state.capacity + " slots",
      "net " + state.netPct + "%",
      "budget " + money(state.budget),
      state.respectStock ? "stock at landing" : "stock ignored",
      (state.restockConfidence || "med") + " confidence",
      state.activeEnd ? "window " + state.activeStart + " to " + state.activeEnd : "no active window",
    ];
    chipsEl.innerHTML = items.map((c) => `<span class="ttp-chip">${esc(c)}</span>`).join("");
  }

  function buildPanel() {
    const existing = document.getElementById("ttp-root");
    if (existing) {
      rootEl = existing;
      panelBody = document.getElementById("ttp-body");
      statusEl = document.getElementById("ttp-status");
      summaryEl = document.getElementById("ttp-summary");
      cardsEl = document.getElementById("ttp-cards");
      cardsHeadEl = document.getElementById("ttp-cards-head");
      chipsEl = document.getElementById("ttp-chips");
      settingsEl = document.getElementById("ttp-settings");
      settingsBtnEl = document.getElementById("ttp-settings-btn");
      return;
    }

    const container = document.createElement("div");
    container.id = "ttp-root";
    rootEl = container;

    const header = document.createElement("div");
    header.id = "ttp-header";
    const title = document.createElement("span");
    title.className = "ttp-title";
    title.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
      '<path fill="currentColor" d="M21.5 15.5 13.5 11V5.5A1.5 1.5 0 0 0 12 4a1.5 1.5 0 0 0-1.5 1.5V11l-8 4.5V17l8-2.5v5L8.5 21v1l3.5-1 3.5 1v-1l-2-1.5v-5l8 2.5v-1.5Z"/>' +
      "</svg>";
    title.appendChild(document.createTextNode("Travel planner"));
    const btns = document.createElement("div");
    btns.className = "ttp-head-btns";
    const helpBtn = document.createElement("button");
    helpBtn.type = "button";
    helpBtn.className = "ttp-icon-btn";
    helpBtn.textContent = "?";
    helpBtn.title = "How to use the planner";
    helpBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showHelp();
    });
    const minBtn = document.createElement("button");
    minBtn.type = "button";
    minBtn.className = "ttp-icon-btn ttp-min";
    minBtn.textContent = "–";
    minBtn.title = "Minimize to the side button";
    minBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setMinimized(!panelMinimized);
    });
    btns.appendChild(helpBtn);
    btns.appendChild(minBtn);
    header.appendChild(title);
    header.appendChild(btns);
    container.appendChild(header);

    // Drag by the header. Any control inside it is excluded.
    let dragging = false,
      dx = 0,
      dy = 0;
    header.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      dragging = true;
      const box = container.getBoundingClientRect();
      dx = e.clientX - box.left;
      dy = e.clientY - box.top;
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

    const body = document.createElement("div");
    body.id = "ttp-body";
    panelBody = body;

    // Tabs: the planner and the item tracker are two different questions.
    const tabBar = document.createElement("div");
    tabBar.className = "ttp-tabs";
    function tabBtn(label, key) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ttp-tab";
      b.textContent = label;
      b.addEventListener("click", () => setTab(key));
      return b;
    }
    tabBtnPlanner = tabBtn("Routes", "planner");
    tabBtnTracker = tabBtn("Item tracker", "tracker");
    tabBar.appendChild(tabBtnPlanner);
    tabBar.appendChild(tabBtnTracker);
    body.appendChild(tabBar);

    // ---- planner view ----
    plannerWrap = document.createElement("div");
    plannerWrap.className = "ttp-view";

    const chipsWrap = document.createElement("div");
    chipsWrap.className = "ttp-chips";
    // The chip row is the node updateChips() rewrites, so the button lives beside it
    // in the wrapper: writing innerHTML over a container destroys its other children.
    const chips = document.createElement("div");
    chips.id = "ttp-chips";
    chips.className = "ttp-chip-row";
    chipsEl = chips;
    chipsWrap.appendChild(chips);
    settingsBtnEl = document.createElement("button");
    settingsBtnEl.type = "button";
    settingsBtnEl.id = "ttp-settings-btn";
    settingsBtnEl.className = "ttp-btn ttp-settings-btn";
    settingsBtnEl.textContent = "Settings";
    settingsBtnEl.setAttribute("aria-expanded", "false");
    settingsBtnEl.addEventListener("click", () => {
      const open = settingsEl.classList.toggle("open");
      settingsBtnEl.setAttribute("aria-expanded", open ? "true" : "false");
      settingsBtnEl.textContent = open ? "Hide settings" : "Settings";
    });
    chipsWrap.appendChild(settingsBtnEl);
    plannerWrap.appendChild(chipsWrap);

    const ctl = document.createElement("div");
    ctl.id = "ttp-settings";
    ctl.className = "ttp-settings";
    settingsEl = ctl;

    const modeSel = document.createElement("select");
    modeSel.className = "ttp-sel";
    ["airstrip", "standard", "wlt", "business"].forEach((m) => {
      const o = document.createElement("option");
      o.value = m;
      o.textContent = m[0].toUpperCase() + m.slice(1);
      modeSel.appendChild(o);
    });
    modeSel.value = state.mode;
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
    const budInp = moneyInput(
      state.budget,
      (v) => {
        state.budget = v;
        onSettingsChange();
      },
      "110px",
    );
    // Cash on hand from the API key, next to the budget it can fill. Copying it in
    // is a button, never automatic: the budget is a spending decision.
    const cashRow = document.createElement("div");
    cashRow.className = "ttp-cash-row";
    cashTxtEl = document.createElement("span");
    cashTxtEl.className = "ttp-cash";
    cashBtnEl = document.createElement("button");
    cashBtnEl.type = "button";
    cashBtnEl.className = "ttp-btn";
    cashBtnEl.textContent = "Use my money";
    cashBtnEl.addEventListener("click", () => {
      const c = lastData ? lastData.cash : null;
      if (!c || c.state !== "ok") return;
      state.budget = c.amount;
      budInp.value = c.amount.toLocaleString("en-US");
      if (budInp.__setErr) budInp.__setErr(null);
      saveState();
      onSettingsChange();
      updateCash();
    });
    cashRow.appendChild(cashTxtEl);
    cashRow.appendChild(cashBtnEl);
    const budWrap = document.createElement("div");
    budWrap.className = "ttp-stack";
    budWrap.appendChild(budInp);
    budWrap.appendChild(cashRow);

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
    startInp.addEventListener("change", () => {
      state.activeStart = startInp.value;
      onSettingsChange();
    });
    const nowBtn = document.createElement("button");
    nowBtn.type = "button";
    nowBtn.className = "ttp-btn";
    nowBtn.textContent = "Now";
    nowBtn.title = "Set Active start to the current time";
    nowBtn.addEventListener("click", () => {
      state.activeStart = nowHHMM();
      startInp.value = state.activeStart;
      onSettingsChange();
    });
    const startWrap = document.createElement("div");
    startWrap.className = "ttp-row";
    startWrap.appendChild(startInp);
    startWrap.appendChild(nowBtn);
    const endInp = document.createElement("input");
    endInp.type = "time";
    endInp.className = "ttp-input";
    endInp.title = "When you normally go to sleep";
    endInp.value = state.activeEnd;
    endInp.addEventListener("change", () => {
      state.activeEnd = endInp.value;
      onSettingsChange();
    });

    const respectCb = document.createElement("input");
    respectCb.type = "checkbox";
    respectCb.className = "ttp-cb";
    respectCb.id = "ttp-respect";
    respectCb.title = "Only buy items that will still be on the shelf when you land";
    respectCb.checked = state.respectStock;
    respectCb.addEventListener("change", () => {
      state.respectStock = respectCb.checked;
      onSettingsChange();
    });
    const respectWrap = document.createElement("label");
    respectWrap.className = "ttp-check";
    respectWrap.setAttribute("for", "ttp-respect");
    respectWrap.appendChild(respectCb);
    respectWrap.appendChild(document.createTextNode("only what is there on landing"));

    const swInp = numInput(
      state.stockWindow,
      -30,
      1,
      (v) => {
        state.stockWindow = v;
        onSettingsChange();
      },
      "50px",
      { max: 2880, integer: true, title: "Land this many minutes after a restock (negative = as soon as possible)" },
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
    const nerveCb = document.createElement("input");
    nerveCb.type = "checkbox";
    nerveCb.className = "ttp-cb";
    nerveCb.id = "ttp-nerve";
    nerveCb.checked = !!state.nerveCare;
    nerveCb.title = "Care about nerve capping while you are in the air";
    const nwRow = document.createElement("div");
    nwRow.className = "ttp-row";
    // Same labelled target as the other checkboxes: a bare 15px box is not a tap
    // target and gives screen readers nothing.
    const nerveLbl = document.createElement("label");
    nerveLbl.className = "ttp-check";
    nerveLbl.setAttribute("for", "ttp-nerve");
    nerveLbl.appendChild(nerveCb);
    nerveLbl.appendChild(document.createTextNode("care about nerve"));
    nwRow.appendChild(nerveLbl);
    nwRow.appendChild(nwInp);
    nerveCb.addEventListener("change", () => {
      state.nerveCare = nerveCb.checked;
      nwInp.disabled = !nerveCb.checked;
      onSettingsChange();
    });
    if (!state.nerveCare) nwInp.disabled = true;

    const keyInp = document.createElement("input");
    keyInp.type = "password";
    keyInp.className = "ttp-input";
    keyInp.placeholder = "Paste your key";
    keyInp.title =
      "Torn API key: reads market values, your nerve bar and your cash on hand (money needs Limited access)";
    keyInp.value = state.apiKey || "";
    keyInp.addEventListener("change", () => {
      state.apiKey = keyInp.value.trim();
      saveState();
      loadData(true); // refetch so items, nerve and cash use the new key
    });

    const confSel = document.createElement("select");
    confSel.className = "ttp-sel";
    ["med", "high", "low"].forEach((v) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = v[0].toUpperCase() + v.slice(1);
      confSel.appendChild(o);
    });
    confSel.value = state.restockConfidence || "med";
    confSel.addEventListener("change", () => {
      state.restockConfidence = confSel.value;
      onSettingsChange();
    });

    const autoCb = document.createElement("input");
    autoCb.type = "checkbox";
    autoCb.className = "ttp-cb";
    autoCb.id = "ttp-auto";
    autoCb.title = "Re-fetch live prices and restock data every 10 minutes";
    autoCb.checked = state.autoRefresh;
    autoCb.addEventListener("change", () => {
      state.autoRefresh = autoCb.checked;
      saveState();
    });
    const autoWrap = document.createElement("label");
    autoWrap.className = "ttp-check";
    autoWrap.setAttribute("for", "ttp-auto");
    autoWrap.appendChild(autoCb);
    autoWrap.appendChild(document.createTextNode("auto refresh"));

    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.id = "ttp-refresh";
    refreshBtn.className = "ttp-btn ttp-btn-primary";
    refreshBtn.textContent = "Refresh";
    refreshBtn.addEventListener("click", () => loadData(true));

    ctl.appendChild(field("Travel method", modeSel));
    ctl.appendChild(field("Item capacity", capInp));
    ctl.appendChild(field("Net % (trade)", netInp));
    ctl.appendChild(field("Budget (capital)", budWrap, "grid-column: span 2;"));
    ctl.appendChild(field("Active start", startWrap));
    ctl.appendChild(field("Active end", endInp));
    ctl.appendChild(field("Sleep (h)", sleepInp));
    ctl.appendChild(field("Buy buffer (min)", bufInp));
    ctl.appendChild(field("Stock window (min)", swInp));
    ctl.appendChild(field("Restock confidence", confSel));
    ctl.appendChild(field("Stock at landing", respectWrap));
    ctl.appendChild(field("Nerve waste", nwRow));
    ctl.appendChild(field("API key", keyInp));
    ctl.appendChild(field("Auto-refresh", autoWrap));
    ctl.appendChild(
      field(
        "\u00a0",
        (() => {
          const w = document.createElement("div");
          w.className = "ttp-row";
          w.appendChild(refreshBtn);
          return w;
        })(),
      ),
    );
    plannerWrap.appendChild(ctl);

    const status = document.createElement("div");
    status.id = "ttp-status";
    status.className = "ttp-status";
    status.textContent = "starting up";
    statusEl = status;
    plannerWrap.appendChild(status);

    const summary = document.createElement("div");
    summary.id = "ttp-summary";
    summaryEl = summary;
    plannerWrap.appendChild(summary);

    const cardsHead = document.createElement("div");
    cardsHead.id = "ttp-cards-head";
    cardsHead.className = "ttp-cards-head";
    cardsHeadEl = cardsHead;
    plannerWrap.appendChild(cardsHead);

    const cards = document.createElement("div");
    cards.id = "ttp-cards";
    cards.className = "ttp-cards";
    cardsEl = cards;
    plannerWrap.appendChild(cards);

    body.appendChild(plannerWrap);

    // ---- item tracker view ----
    trackerWrap = document.createElement("div");
    trackerWrap.className = "ttp-view";
    trackerWrap.style.display = "none";
    const trackRow = document.createElement("div");
    trackRow.className = "ttp-track-search";
    trackSearchInp = document.createElement("input");
    trackSearchInp.className = "ttp-input";
    trackSearchInp.placeholder = "Search an item to track";
    trackSearchInp.setAttribute("list", "ttp-items-dl");
    trackDatalistEl = document.createElement("datalist");
    trackDatalistEl.id = "ttp-items-dl";
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "ttp-btn ttp-btn-primary";
    addBtn.textContent = "Track";
    addBtn.title = "Add this item to the tracker";
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
    trackChips.className = "ttp-track-chips";
    trackerWrap.appendChild(trackChips);
    trackResultsEl = document.createElement("div");
    trackResultsEl.className = "ttp-track-results";
    trackerWrap.appendChild(trackResultsEl);
    body.appendChild(trackerWrap);

    container.appendChild(body);
    document.body.appendChild(container);

    // ---- minimized left-side button (PDA friendly) ----
    const miniBtn = document.createElement("button");
    miniBtn.type = "button";
    miniBtn.className = "ttp-mini";
    miniBtn.style.top = (state.miniTop || 130) + "px";
    miniBtn.title = "Travel planner, tap to open (drag to move)";
    miniBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
      '<path fill="currentColor" d="M21.5 15.5 13.5 11V5.5A1.5 1.5 0 0 0 12 4a1.5 1.5 0 0 0-1.5 1.5V11l-8 4.5V17l8-2.5v5L8.5 21v1l3.5-1 3.5 1v-1l-2-1.5v-5l8 2.5v-1.5Z"/>' +
      "</svg>";
    let miniDragged = false;
    miniBtn.addEventListener("click", () => {
      if (miniDragged) {
        miniDragged = false;
        return;
      }
      setMinimized(false);
    });
    miniBtn.addEventListener("pointerdown", (e) => {
      miniDragged = false;
      const startY = e.clientY,
        startX = e.clientX;
      const startTop = miniBtn.getBoundingClientRect().top;
      const move = (ev) => {
        const maxY = Math.max(8, (window.innerHeight || document.documentElement.clientHeight) - 54);
        miniBtn.style.top = Math.max(8, Math.min(maxY, startTop + (ev.clientY - startY))) + "px";
        miniBtn.style.left = Math.max(8, Math.min(24, 8 + (ev.clientX - startX))) + "px";
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
    st.id = "ttp-css";
    st.textContent = TTP_CSS;
    document.head.appendChild(st);

    updateChips(); // fill the chip strip from the loaded state
    setTab(state.tab === "tracker" ? "tracker" : "planner");
    updateCash(); // the readout starts in its "reading" state
  }

  // Every colour and size in one place. Two rules drive it: money is the only thing
  // that gets colour (green up, red down), and the recommended route is the only
  // tinted surface. Amber is a restock status marker, never decoration.
  const TTP_CSS = `
#ttp-root, #ttp-help {
  --bg:#0d1117; --panel:#161b22; --raise:#1c232c; --line:#2b333d; --line-soft:#212934;
  --ink:#e8edf4; --ink-2:#9aa4b2; --ink-3:#8a94a3;
  --accent:#3fb950; --neg:#f2545b; --amber:#d7a33c;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
}
#ttp-root{position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:99999;
  width:min(820px,96vw);max-height:calc(100vh - 40px);display:flex;flex-direction:column;
  background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:12px;
  box-shadow:0 12px 34px rgba(0,0,0,.6);overflow:hidden;font-family:var(--sans);font-size:13px;line-height:1.45;}
#ttp-header{display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:10px 14px;background:var(--panel);border-bottom:1px solid var(--line);cursor:grab;user-select:none;}
#ttp-root .ttp-title{display:inline-flex;align-items:center;gap:8px;font-weight:650;font-size:14px;}
#ttp-root .ttp-title svg{color:var(--accent)}
#ttp-root .ttp-head-btns{display:flex;gap:6px}
#ttp-root .ttp-icon-btn{background:none;border:1px solid var(--line);border-radius:6px;min-width:26px;height:26px;
  color:var(--ink-2);cursor:pointer;font-size:13px;line-height:1;padding:0 6px;}
#ttp-root .ttp-icon-btn:hover{color:var(--ink);border-color:var(--ink-3)}
#ttp-body{overflow-y:auto;overflow-x:hidden}
#ttp-root .ttp-tabs{display:flex;gap:18px;padding:12px 14px 0}
#ttp-root .ttp-tab{background:none;border:0;color:var(--ink-3);font:inherit;font-size:13px;padding:0 0 6px;cursor:pointer}
#ttp-root .ttp-tab:hover{color:var(--ink-2)}
#ttp-root .ttp-tab[aria-current="true"]{color:var(--ink);box-shadow:inset 0 -2px 0 var(--accent)}
#ttp-root .ttp-view{padding:12px 14px 16px}

/* settings: a chip strip that opens into the form */
#ttp-root .ttp-chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:10px}
#ttp-root .ttp-chip-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
#ttp-root .ttp-chip{font-family:var(--mono);font-size:11px;color:var(--ink-2);border:1px solid var(--line);
  border-radius:4px;padding:2px 7px;white-space:nowrap}
#ttp-root .ttp-settings-btn{margin-left:auto}
#ttp-root .ttp-settings{display:none;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px 12px;
  padding:12px;margin-bottom:10px;background:var(--raise);border:1px solid var(--line);border-radius:10px}
#ttp-root .ttp-settings.open{display:grid}
#ttp-root .ttp-label{color:var(--ink-3);font-size:11px;margin-bottom:4px}
#ttp-root .ttp-err{color:var(--neg);font-size:10px;line-height:1.25}
#ttp-root .ttp-stack,#ttp-root .ttp-row{display:flex;flex-direction:column;gap:4px}
#ttp-root .ttp-row{flex-direction:row;align-items:center;gap:6px}
#ttp-root .ttp-cash-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
#ttp-root .ttp-cash{color:var(--ink-3);font-size:10px}
#ttp-root .ttp-check{display:flex;align-items:center;gap:6px;color:var(--ink-2);font-size:12px;cursor:pointer}
#ttp-root .ttp-input,#ttp-root .ttp-sel{background:#0b0f14;border:1px solid var(--line);color:var(--ink);
  border-radius:6px;padding:5px 8px;font-size:13px;font-family:inherit;width:100%;box-sizing:border-box}
#ttp-root .ttp-input:hover,#ttp-root .ttp-sel:hover{border-color:#3c4654}
#ttp-root .ttp-input:focus-visible,#ttp-root .ttp-sel:focus-visible,#ttp-root .ttp-btn:focus-visible,
#ttp-root .ttp-tab:focus-visible,#ttp-root .ttp-route:focus-visible,#ttp-root .ttp-icon-btn:focus-visible{
  outline:2px solid var(--accent);outline-offset:1px}
#ttp-root .ttp-input.ttp-bad{border-color:var(--neg);background:rgba(242,84,91,.08)}
#ttp-root .ttp-input:disabled{opacity:.5}
#ttp-root .ttp-cb{width:15px;height:15px;accent-color:var(--accent);cursor:pointer}
#ttp-root .ttp-btn{background:var(--raise);border:1px solid var(--line);color:var(--ink);border-radius:6px;
  font:inherit;font-size:12px;padding:5px 11px;cursor:pointer}
#ttp-root .ttp-btn:hover{border-color:var(--accent)}
#ttp-root .ttp-btn:disabled{opacity:.5;cursor:default}
#ttp-root .ttp-btn-primary{background:var(--accent);border-color:var(--accent);color:#08130c;font-weight:650}

/* status strip */
#ttp-root .ttp-status{color:var(--ink-3);font-size:11px;font-family:var(--mono);padding:2px 0 10px}
#ttp-root .ttp-loading{color:var(--amber)}

/* hero */
#ttp-root .ttp-hero{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:10px;
  padding:16px 18px 14px;overflow:hidden}
#ttp-root .ttp-hero::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--accent)}
#ttp-root .ttp-kicker{display:block;color:var(--accent);font-size:11px;font-weight:650;letter-spacing:.5px;text-transform:uppercase}
#ttp-root .ttp-hero-top{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin:6px 0 0}
#ttp-root .ttp-hero h2{font-size:22px;font-weight:650;letter-spacing:-.2px;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
#ttp-root .ttp-hero h2 small{font-size:12px;font-weight:400;color:var(--ink-3);letter-spacing:0}
#ttp-root .ttp-answer{display:flex;flex-wrap:wrap;gap:22px;margin:14px 0 0}
#ttp-root .ttp-answer-sm{gap:18px;margin-top:10px}
#ttp-root .ttp-stat{display:flex;flex-direction:column;gap:1px;min-width:78px}
#ttp-root .ttp-stat .lbl{color:var(--ink-3);font-size:11px}
#ttp-root .ttp-stat .val{font-size:24px;font-weight:650;line-height:1.15}
#ttp-root .ttp-stat .val.sm{font-size:17px;font-weight:600}
#ttp-root .ttp-stat .val.clock{font-family:var(--mono);font-size:26px;letter-spacing:-.5px}
#ttp-root .ttp-stat .val.clock.go{color:var(--accent)}
#ttp-root .ttp-stat .val.pos{color:var(--accent)}
#ttp-root .ttp-stat .rel{color:var(--ink-2);font-size:12px}
#ttp-root .ttp-hero-buy{margin-top:14px;padding-top:12px;border-top:1px solid var(--line-soft)}
#ttp-root .ttp-hero-foot{display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:10px;color:var(--ink-3);font-size:11px}
#ttp-root .ttp-hero-foot b{color:var(--ink-2);font-weight:600}
#ttp-root .ttp-warn{margin-top:12px;padding:8px 10px;border:1px solid rgba(215,163,60,.45);border-radius:8px;
  background:rgba(215,163,60,.10);color:var(--amber);font-size:12px}
#ttp-root .ttp-hero-empty::before,#ttp-root .ttp-hero-error::before{background:var(--ink-3)}
#ttp-root .ttp-hero-error .ttp-kicker{color:var(--neg)}
#ttp-root .ttp-muted{color:var(--ink-2);font-size:12px;margin-top:6px}
#ttp-root .ttp-bars{display:inline-block;width:14px;height:14px;margin-right:8px;border-radius:50%;
  border:2px solid var(--line);border-top-color:var(--accent);animation:ttp-spin 1s linear infinite;vertical-align:-2px}
@keyframes ttp-spin{to{transform:rotate(360deg)}}

/* buy list */
#ttp-root .ttp-buy{list-style:none;margin:6px 0 0;padding:0}
#ttp-root .ttp-buy li{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--line-soft)}
#ttp-root .ttp-buy li:last-child{border-bottom:0}
#ttp-root .ttp-buy .nm{font-weight:600}
#ttp-root .ttp-buy .qty{font-family:var(--mono);color:var(--ink-2)}
#ttp-root .ttp-buy .cash{font-family:var(--mono);color:var(--ink-2)}
#ttp-root .ttp-buy .cash.pos{color:var(--accent)}
#ttp-root .ttp-buy .tag{margin-left:auto}
#ttp-root .ttp-badge{display:inline-block;padding:1px 7px;border-radius:999px;font-size:10px;white-space:nowrap;
  vertical-align:middle;border:1px solid transparent}
#ttp-root .ttp-badge.ok{color:var(--accent);background:rgba(63,185,80,.14);border-color:rgba(63,185,80,.42)}
#ttp-root .ttp-badge.wait{color:var(--amber);background:rgba(215,163,60,.13);border-color:rgba(215,163,60,.42)}
#ttp-root .ttp-badge.bad{color:var(--neg);background:rgba(242,84,91,.13);border-color:rgba(242,84,91,.42)}
#ttp-root .ttp-badge.mut{color:var(--ink-3);background:rgba(138,148,163,.12);border-color:rgba(138,148,163,.38)}
#ttp-root .ttp-conf{color:var(--ink-3);font-size:10px}

/* route cards */
#ttp-root .ttp-cards-head{display:flex;align-items:baseline;gap:12px;margin:16px 0 8px;
  color:var(--ink-3);font-size:11px}
#ttp-root .ttp-sort{margin-left:auto;display:inline-flex;align-items:center;gap:6px}
#ttp-root .ttp-sort select{background:#0b0f14;border:1px solid var(--line);color:var(--ink);
  border-radius:6px;padding:3px 6px;font:inherit;font-size:11px}
#ttp-root .ttp-cards{display:grid;grid-template-columns:1fr 1fr;gap:8px}
#ttp-root .ttp-route{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:11px 13px;cursor:pointer}
#ttp-root .ttp-route:hover{border-color:#3c4654;background:var(--raise)}
#ttp-root .ttp-route-top{display:flex;align-items:baseline;gap:10px}
#ttp-root .ttp-route h3{font-size:13px;font-weight:600;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
#ttp-root .ttp-route h3 small{color:var(--ink-3);font-weight:400;font-size:11px}
#ttp-root .ttp-route .pph{margin-left:auto;font-family:var(--mono);color:var(--accent);font-weight:600;white-space:nowrap}
#ttp-root .ttp-route-line{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:5px;color:var(--ink-2);font-size:12px}
#ttp-root .ttp-route-line .leave{font-family:var(--mono);color:var(--ink)}
#ttp-root .ttp-route-line .leave.go{color:var(--accent)}
#ttp-root .ttp-route-line .dim{color:var(--ink-3)}
#ttp-root .ttp-route-more{display:none;margin-top:9px;padding-top:9px;border-top:1px solid var(--line-soft)}
#ttp-root .ttp-route.open .ttp-route-more{display:block}
#ttp-root .ttp-card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-top:10px}
#ttp-root .ttp-sleep .ttp-kicker{color:var(--ink-2)}

/* item tracker */
#ttp-root .ttp-track-search{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
#ttp-root .ttp-track-search .ttp-input{flex:1;min-width:180px}
#ttp-root .ttp-track-chips{display:flex;flex-wrap:wrap;gap:6px}
#ttp-root .ttp-chip .ttp-chip-x{background:none;border:0;color:var(--neg);cursor:pointer;font-size:13px;line-height:1;padding:0 0 0 4px}
#ttp-root .ttp-track-results{margin-top:12px}
#ttp-root .ttp-track-group{margin-bottom:12px}
#ttp-root .ttp-track-group h3{font-size:13px;font-weight:650;color:var(--ink);margin-bottom:4px}
#ttp-root .ttp-track-row{font-size:12px;color:var(--ink-2);padding:3px 0}
#ttp-root .ttp-track-row .leave{font-family:var(--mono);color:var(--ink)}
#ttp-root .ttp-track-row .leave.go{color:var(--accent)}
#ttp-root .ttp-track-row .dim{color:var(--ink-3)}

/* minimized button */
#ttp-root .ttp-mini{display:none;position:fixed;left:8px;z-index:100000;width:46px;height:46px;border-radius:50%;
  background:var(--panel);border:2px solid var(--accent);color:var(--accent);cursor:pointer;
  box-shadow:0 4px 14px rgba(0,0,0,.55);align-items:center;justify-content:center;touch-action:none;user-select:none}

/* help overlay */
#ttp-help{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.65);display:flex;align-items:center;
  justify-content:center;font-family:var(--sans)}
#ttp-help .ttp-help-card{background:var(--panel);border:1px solid var(--line);border-radius:12px;
  max-width:640px;width:92vw;max-height:80vh;overflow-y:auto;padding:16px 20px;color:var(--ink);font-size:12px}
#ttp-help h3{margin:0 0 12px;color:var(--accent);font-size:14px}
#ttp-help .h-row{margin-bottom:8px;line-height:1.45}
#ttp-help .h-k{color:var(--ink);font-weight:650}
#ttp-help .h-d{color:var(--ink-2)}
#ttp-help .h-sec{margin:14px 0 6px;padding-top:8px;border-top:1px solid var(--line);color:var(--accent);font-weight:650}
#ttp-help .ttp-btn{background:var(--raise);border:1px solid var(--line);color:var(--ink);border-radius:6px;
  font:inherit;font-size:12px;padding:6px 12px;cursor:pointer;margin-top:10px}
#ttp-help .ttp-btn:focus-visible{outline:2px solid var(--accent);outline-offset:1px}

/* phone and touch: the panel is used on Torn PDA, so controls clear 44px and the
   cards stop being a two column grid long before the desktop layout would break. */
@media (max-width:700px){
  #ttp-root{top:12px;width:calc(100vw - 16px);max-height:calc(100vh - 24px);max-height:calc(100dvh - 24px)}
  #ttp-root .ttp-view{padding:10px 10px 14px}
  #ttp-root .ttp-cards{grid-template-columns:1fr}
  #ttp-root .ttp-settings{grid-template-columns:1fr 1fr}
  #ttp-root .ttp-answer{gap:16px}
  #ttp-root .ttp-stat .val.clock{font-size:22px}
}
@media (max-width:430px){
  #ttp-root .ttp-settings{grid-template-columns:1fr}
  #ttp-root .ttp-hero h2{font-size:19px}
}
@media (max-width:700px), (pointer:coarse){
  #ttp-root .ttp-btn,#ttp-root .ttp-tab,#ttp-root .ttp-icon-btn{min-height:44px;min-width:44px}
  #ttp-root .ttp-input,#ttp-root .ttp-sel{min-height:44px}
  #ttp-root .ttp-sort select{min-height:44px}
  #ttp-root .ttp-chip{padding:6px 9px}
  #ttp-root .ttp-check{min-height:44px}
}
`;
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
    // One second tick that rewrites two text nodes (feed age, hero countdown) and
    // never re-renders the panel.
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(tick, 1000);
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
    // Flush any pending restock records before the tab goes away.
    window.addEventListener("pagehide", flushHistory);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) flushHistory();
    });
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
      parseMoney,
      groupDigits,
      formatMoneyTyping,
      normalizeBars,
      moneyOnHand,
      buildHero,
      buildCards,
      renderResults,
      fmtCountdown,
      statusChip,
      updateChips,
      updateCash,
      esc,
      tick,
      flushHistory,
      // Test-only plumbing: lets the harness capture hero HTML and drive the panel
      // (cash button, loading state) headlessly.
      __setSummaryEl(el) {
        summaryEl = el;
      },
      __setLastData(v) {
        lastData = v;
      },
      __setView(kind, message) {
        viewState = kind || "idle";
        viewMessage = message || "";
      },
      setBackend(v) {
        _backend = v;
      },
    };
    module.exports.__setClock = function (fn) {
      _ttpNow = fn || Date.now;
    };
  }
})();
