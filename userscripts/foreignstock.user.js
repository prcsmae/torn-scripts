// ==UserScript==
// @name         Torn Foreign Stock (Modified)
// @namespace    RussianRob + motherBarker
// @version      0.9.32
// @description  Live abroad item stock, restock countdown timers & travel profit on Torn's travel page — mobile panels + desktop table.
// @author       RussianRob + motherBarker
// @license      GPL-3.0-or-later
// @match        https://www.torn.com/page.php*
// @match        https://www.torn.com/travelagency.php*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      api.prombot.co.uk
// @connect      raw.githubusercontent.com
// @connect      yata.yt
// @connect      api.torn.com
// @run-at       document-idle

// ==/UserScript==
(function () {
  "use strict";
  var SCRIPT_VERSION = "0.9.32";
  var YATA_URL = "https://yata.yt/api/v1/travel/export/";
  var PROMBOT_URL = "https://api.prombot.co.uk/api/travel";
  var TORN_ITEMS_URL = "https://api.torn.com/v2/torn?selections=items&key=";
  var MODEL_URL =
    "https://raw.githubusercontent.com/russianrob/torn-foreign-restock/main/restock-model.json";
  var MODEL_TTL = 600;
  var STOCK_TTL = 60,
    PRICE_TTL = 21600,
    STALE_MIN = 30,
    TRAVEL_TTL = 30;
  var TORN_TRAVEL_URL = "https://api.torn.com/user/?selections=travel,basic&key=";
  var SAFETY = 1.15,
    MARGIN_SAFE_MIN = 8;
  // --- API rate-limit backoff: after a Torn API error we skip requests for
  // BACKOFF_MS rather than hammering the API (Torn v2 is sensitive to burst).
  var TFS_BACKOFF_MS = 300000; // 5 min
  var _tfsApiBackoffUntil = 0; // unix sec, 0 = clear
  function tfsApiInBackoff() { return _nowSec() < _tfsApiBackoffUntil; }
  function tfsApiErr() { _tfsApiBackoffUntil = _nowSec() + Math.ceil(TFS_BACKOFF_MS / 1000); }
  function tfsApiOk() { _tfsApiBackoffUntil = 0; }
  var IS_PDA = (function () {
    try {
      if (typeof window !== "undefined" && window.flutter_inappwebview) return true;
      return (
        typeof navigator !== "undefined" &&
        /TornPDA|tornpda|DalvikTornPDA|com\.manuito/i.test(navigator.userAgent || "")
      );
    } catch (e) {
      return false;
    }
  })();

  // ─── pure helpers (unit-tested) ──────────────────────────
  var COUNTRY_MAP = {
    mexico: "mex",
    "cayman islands": "cay",
    canada: "can",
    hawaii: "haw",
    "united kingdom": "uni",
    uk: "uni",
    argentina: "arg",
    switzerland: "swi",
    japan: "jap",
    china: "chi",
    uae: "uae",
    "united arab emirates": "uae",
    "south africa": "sou",
  };
  function normalizeCountryName(name) {
    if (!name) return null;
    var k = String(name).trim().toLowerCase().replace(/\s+/g, " ");
    return COUNTRY_MAP[k] || null;
  }
  function parseYataExport(json) {
    var out = {},
      stocks = (json && json.stocks) || {};
    for (var code in stocks) {
      if (!Object.prototype.hasOwnProperty.call(stocks, code)) continue;
      var c = stocks[code] || {};
      var items = (c.stocks || []).map(function (it) {
        return {
          id: it.id,
          name: it.name,
          qty: it.quantity,
          cost: it.cost,
          nextRestock: it.nextRestock != null ? it.nextRestock : null,
        };
      });
      out[code] = { update: c.update || 0, items: items };
    }
    return out;
  }
  function groupThousands(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  function fmtMoney(n) {
    if (typeof n !== "number" || !isFinite(n)) return "—";
    return "$" + groupThousands(Math.round(n));
  }
  function fmtProfit(n) {
    if (typeof n !== "number" || !isFinite(n)) return "—";
    return (n < 0 ? "-$" : "+$") + groupThousands(Math.round(Math.abs(n)));
  }
  function formatAge(updateSec, nowSecVal) {
    var diff = Math.max(0, Math.floor(nowSecVal - updateSec));
    var mins = Math.floor(diff / 60),
      text;
    if (diff < 60) text = "just now";
    else if (mins < 60) text = mins + "m ago";
    else text = Math.floor(mins / 60) + "h " + (mins % 60) + "m ago";
    return { text: text, stale: mins >= STALE_MIN };
  }
  function buildRows(items, opts) {
    opts = opts || {};
    var mode = opts.mode || "stock";
    var getValue =
      opts.getValue ||
      function () {
        return undefined;
      };
    return items.map(function (it) {
      var value = mode === "profit" ? getValue(it.id) : undefined;
      value = typeof value === "number" && isFinite(value) ? value : null;
      var profit = value == null ? null : value - it.cost;
      return {
        id: it.id,
        name: it.name,
        qty: it.qty,
        cost: it.cost,
        value: value,
        profit: profit,
        nextRestock: it.nextRestock || null,
      };
    });
  }
  function restockEta(nextRestock, nowMs) {
    if (!nextRestock) return null;
    var t = Date.parse(nextRestock);
    if (isNaN(t)) return null;
    if (t > nowMs) {
      var mins = Math.ceil((t - nowMs) / 60000);
      return {
        mins: mins,
        text: mins < 60 ? mins + "m" : Math.floor(mins / 60) + "h " + (mins % 60) + "m",
        due: false,
      };
    }
    if (nowMs - t <= 3600000) return { mins: 0, text: "due", due: true };
    return null;
  }
  function fmtDuration(sec) {
    var m = Math.round(sec / 60);
    return m < 60 ? m + "m" : Math.floor(m / 60) + "h " + (m % 60) + "m";
  }
  function modelEstimate(entry, nowMs) {
    if (!entry || !entry.interval) return null;
    var nowSec = Math.floor(nowMs / 1000);
    var interval = entry.interval;
    var since = nowSec - entry.last;
    var leftSec = since < 0 ? -since : interval - (since % interval);
    if (leftSec <= 0) leftSec = interval;
    return (
      "~every " +
      fmtDuration(interval) +
      " · ~" +
      fmtDuration(leftSec) +
      " (" +
      (entry.rel || "low") +
      ")"
    );
  }
  function restockDisplay(nextRestock, entry, nowMs, qty) {
    var live = restockEta(nextRestock, nowMs);
    if (live && !live.due) return "restocks in " + live.text;
    var est = modelEstimate(entry, nowMs);
    if (est) return est;
    if (live && live.due) return "restock due";
    return qty > 0 ? "in stock" : "out of stock";
  }
  var BASE_MIN = {
    mex: 26,
    cay: 35,
    can: 41,
    haw: 134,
    uni: 159,
    arg: 167,
    swi: 175,
    jap: 225,
    chi: 242,
    uae: 271,
    sou: 297,
  };
  var METHOD_MULT = { standard: 1, airstrip: 0.7, private: 0.5, business: 0.3 };
  function parseFlightMinutes(text) {
    if (text == null) return null;
    var s = String(text).trim();
    if (!s) return null;
    var hm = s.match(/(\d+)\s*h\s*(\d+)\s*m/i);
    if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
    var clock = s.match(/^(\d{1,3}):(\d{1,2})(?::(\d{2}))?$/);
    if (clock) {
      if (clock[3] != null)
        return Math.round(Number(clock[1]) * 60 + Number(clock[2]) + Number(clock[3]) / 60);
      return Number(clock[1]) * 60 + Number(clock[2]);
    }
    return null;
  }
  function nextRestockSec(nextRestock, entry, nowSec) {
    var best = null;
    if (nextRestock) {
      var t = Date.parse(nextRestock);
      if (!isNaN(t)) {
        var s = Math.floor(t / 1000);
        if (s > nowSec) best = s;
      }
    }
    if (entry && entry.interval && entry.last != null && (entry.rel || "low") !== "low") {
      var interval = entry.interval,
        since = nowSec - entry.last,
        leftSec;
      if (since < 0) leftSec = -since;
      else leftSec = interval - (since % interval);
      if (leftSec <= 0) leftSec = interval;
      var slot = nowSec + leftSec;
      if (best == null || slot < best) best = slot;
    }
    return best;
  }
  function landVerdict(ctx) {
    ctx = ctx || {};
    if (!ctx.sellReady || ctx.flightMinutes == null) return null;
    var qty = ctx.qty,
      F = ctx.flightMinutes;
    var lowConf = ctx.srel === "low";
    var nowSec = Math.floor((ctx.nowMs != null ? ctx.nowMs : Date.now()) / 1000);
    var rSec = nextRestockSec(ctx.nextRestock, ctx.restockEntry, nowSec);
    var R = rSec == null ? null : (rSec - nowSec) / 60;
    if (qty <= 0) {
      if (R != null && R <= F) {
        return {
          state: "GONE_THEN_RESTOCKED",
          text: "🔄 Restocks ~" + Math.max(1, Math.round(R)) + "m before you land",
          lowConf: lowConf,
        };
      }
      return { state: "GONE", text: "❌ Out of stock", lowConf: lowConf };
    }
    if (ctx.sellRate < 0 || !isFinite(ctx.sellRate)) return null;
    var bufferedRate = ctx.sellRate * SAFETY;
    var M = bufferedRate > 0 && isFinite(bufferedRate) ? qty / bufferedRate : Infinity;
    var margin = M - F;
    if (margin >= MARGIN_SAFE_MIN || M >= 1.5 * F) {
      var safeText = "✅ In stock when you land";
      if (!lowConf) safeText += " (~" + Math.max(1, Math.round(margin)) + "m buffer)";
      return { state: "SAFE", text: safeText, lowConf: lowConf };
    }
    if (margin >= 0) {
      var riskyText = "⚠️ Cutting it close — selling fast";
      if (!lowConf) riskyText += " (~" + Math.max(1, Math.round(margin)) + "m to spare)";
      return { state: "RISKY", text: riskyText, lowConf: lowConf };
    }
    if (R != null && R <= F && R > M) {
      return {
        state: "GONE_THEN_RESTOCKED",
        text: "🔄 Sells out, but restocks ~" + Math.max(1, Math.round(R)) + "m before you land",
        lowConf: lowConf,
      };
    }
    return {
      state: "GONE",
      text: "❌ Will sell out before you land",
      lowConf: lowConf,
    };
  }
  function parseTravelState(api) {
    if (!api || !api.status || !api.status.state) return null;
    var state = api.status.state;
    var travel = api.travel || {};
    if (state === "Traveling") {
      var dest = travel.destination;
      if (dest === "Torn") return null;
      var code = normalizeCountryName(dest);
      if (!code) return null;
      return {
        mode: "flight",
        code: code,
        countryName: dest,
        arrivalSec: travel.timestamp,
        timeLeftSec: travel.time_left,
      };
    }
    if (state === "Abroad") {
      var name = null;
      var m = String(api.status.description || "").match(/^In (.+)$/);
      if (m) name = m[1].trim();
      var ccode = normalizeCountryName(name);
      if (!ccode) {
        name = travel.destination;
        ccode = normalizeCountryName(name);
      }
      if (!ccode) return null;
      return {
        mode: "abroad",
        code: ccode,
        countryName: name,
        arrivalSec: null,
        timeLeftSec: null,
      };
    }
    return null;
  }
  function parseAriaTravel(label) {
    var m = /Travell?ing from .+? to (.+?)\s*$/i.exec(String(label || ""));
    if (!m) m = /Travell?ing to (.+?)\s*$/i.exec(String(label || ""));
    if (!m) return null;
    var dest = m[1].trim();
    if (/^torn$/i.test(dest)) return null;
    var code = normalizeCountryName(dest);
    return code
      ? {
          mode: "flight",
          code: code,
          countryName: dest,
          arrivalSec: null,
          timeLeftSec: null,
        }
      : null;
  }
  function domTravelState() {
    if (typeof document === "undefined") return null;
    var a = document.querySelector('a[aria-label^="Traveling from"]');
    return a ? parseAriaTravel(a.getAttribute("aria-label")) : null;
  }
  function sortRows(rows, mode, nowMs) {
    if (nowMs == null) nowMs = Date.now();
    var arr = rows.slice();
    arr.sort(function (a, b) {
      var ai = a.qty > 0,
        bi = b.qty > 0;
      if (ai !== bi) return ai ? -1 : 1;
      if (ai) {
        var pa, pb;
        if (mode === "profit") {
          pa = a.profit == null ? -Infinity : a.profit;
          pb = b.profit == null ? -Infinity : b.profit;
        } else {
          pa = a.cost;
          pb = b.cost;
        }
        if (pb !== pa) return pb - pa;
        if (b.qty !== a.qty) return b.qty - a.qty;
        return String(a.name).localeCompare(String(b.name));
      }
      var ea = restockEta(a.nextRestock, nowMs),
        eb = restockEta(b.nextRestock, nowMs);
      var ma = ea ? (ea.due ? 1e9 : ea.mins) : Infinity,
        mb = eb ? (eb.due ? 1e9 : eb.mins) : Infinity;
      if (ma !== mb) return ma - mb;
      return String(a.name).localeCompare(String(b.name));
    });
    return arr;
  }
  var ITEM_CATEGORY = {
    4: "Weapon",
    8: "Weapon",
    11: "Weapon",
    20: "Weapon",
    21: "Weapon",
    26: "Weapon",
    31: "Weapon",
    50: "Armor",
    63: "Weapon",
    99: "Weapon",
    108: "Weapon",
    110: "Weapon",
    111: "Weapon",
    175: "Weapon",
    177: "Weapon",
    178: "Armor",
    196: "Drug",
    197: "Drug",
    198: "Drug",
    199: "Drug",
    200: "Drug",
    201: "Drug",
    203: "Drug",
    204: "Drug",
    205: "Drug",
    206: "Drug",
    217: "Weapon",
    218: "Weapon",
    219: "Weapon",
    220: "Weapon",
    221: "Weapon",
    222: "Weapon",
    223: "Weapon",
    224: "Weapon",
    225: "Weapon",
    226: "Weapon",
    227: "Weapon",
    228: "Weapon",
    229: "Weapon",
    230: "Weapon",
    231: "Weapon",
    232: "Weapon",
    233: "Weapon",
    234: "Weapon",
    235: "Weapon",
    236: "Weapon",
    237: "Weapon",
    238: "Weapon",
    239: "Weapon",
    240: "Weapon",
    241: "Weapon",
    242: "Weapon",
    243: "Weapon",
    244: "Weapon",
    245: "Weapon",
    246: "Weapon",
    247: "Weapon",
    248: "Weapon",
    249: "Weapon",
    250: "Weapon",
    251: "Weapon",
    252: "Weapon",
    253: "Weapon",
    255: "Weapon",
    256: "Weapon",
    257: "Weapon",
    258: "Plushie",
    260: "Flower",
    261: "Plushie",
    263: "Flower",
    264: "Flower",
    266: "Plushie",
    267: "Flower",
    268: "Plushie",
    269: "Plushie",
    271: "Flower",
    272: "Flower",
    273: "Plushie",
    274: "Plushie",
    276: "Flower",
    277: "Flower",
    281: "Plushie",
    282: "Flower",
    332: "Armor",
    333: "Armor",
    334: "Armor",
    382: "Weapon",
    384: "Plushie",
    385: "Flower",
    387: "Weapon",
    388: "Weapon",
    391: "Weapon",
    395: "Weapon",
    397: "Weapon",
    398: "Weapon",
    399: "Weapon",
    400: "Weapon",
    402: "Weapon",
    435: "Flower",
    438: "Weapon",
    439: "Weapon",
    440: "Weapon",
    612: "Weapon",
    613: "Weapon",
    614: "Weapon",
    615: "Weapon",
    616: "Weapon",
    617: "Flower",
    618: "Plushie",
    640: "Armor",
    641: "Armor",
    645: "Armor",
    651: "Armor",
    652: "Armor",
    653: "Armor",
    654: "Armor",
  };
  function itemCategory(id) {
    return ITEM_CATEGORY[id] || "Other";
  }
  function rowVisible(row, mode, filters) {
    if (filters.hideOos && row.qty === 0) return false;
    if (mode === "profit" && filters.hideNeg && row.profit != null && row.profit < 0) return false;
    if (filters.excludedCats && filters.excludedCats.indexOf(itemCategory(row.id)) !== -1)
      return false;
    return true;
  }
  function countryVisible(code, filters) {
    if (filters.focusCountry) return code === filters.focusCountry;
    return !(filters.hiddenCountries && filters.hiddenCountries.indexOf(code) !== -1);
  }

  // ─── GM / data layer ─────────────────────────────────────
  var _fetchJson = function (url) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: "GET",
        url: url,
        timeout: 15000,
        onload: function (r) {
          try {
            resolve(JSON.parse(r.responseText));
          } catch (e) {
            reject(e);
          }
        },
        onerror: function () {
          reject(new Error("network"));
        },
        ontimeout: function () {
          reject(new Error("timeout"));
        },
      });
    });
  };
  var _nowSec = function () {
    return Math.floor(Date.now() / 1000);
  };
  function gmGet(key, def) {
    try {
      var g =
        typeof GM_getValue === "function"
          ? GM_getValue
          : typeof globalThis !== "undefined"
            ? globalThis.GM_getValue
            : null;
      var v = g ? g(key, null) : null;
      return v == null ? def : JSON.parse(v);
    } catch (e) {
      return def;
    }
  }
  function gmSet(key, val) {
    try {
      var s =
        typeof GM_setValue === "function"
          ? GM_setValue
          : typeof globalThis !== "undefined"
            ? globalThis.GM_setValue
            : null;
      if (s) s(key, JSON.stringify(val));
    } catch (e) {}
  }
  function getFilters() {
    return {
      hideOos: gmGet("tfs_hide_oos", false),
      hideNeg: gmGet("tfs_hide_negprofit", false),
      excludedCats: gmGet("tfs_cats", []),
      hiddenCountries: gmGet("tfs_hidden_countries", []),
      focusCountry: gmGet("tfs_focus_country", ""),
    };
  }
  function getStock(force) {
    var cached = gmGet("tfs_stock", null);
    if (!force && cached && _nowSec() - cached.t < STOCK_TTL) return Promise.resolve(cached.data);
    function store(json) {
      var data = parseYataExport(json);
      gmSet("tfs_stock", { t: _nowSec(), data: data });
      return data;
    }
    return _fetchJson(PROMBOT_URL)
      .then(store)
      .catch(function () {
        return _fetchJson(YATA_URL)
          .then(store)
          .catch(function () {
            return cached ? cached.data : null;
          });
      });
  }
  function getPrices(key) {
    if (!key) return Promise.resolve({});
    if (tfsApiInBackoff()) {
      var cached = gmGet("tfs_prices", null);
      return Promise.resolve(cached && cached.key === key ? cached.map : {});
    }
    var cached = gmGet("tfs_prices", null);
    if (cached && cached.key === key && _nowSec() - cached.t < PRICE_TTL)
      return Promise.resolve(cached.map);
    return _fetchJson(TORN_ITEMS_URL + encodeURIComponent(key)).then(function (json) {
      if (json && json.error) { tfsApiErr(); throw new Error((json.error && json.error.error) || "API error"); }
      tfsApiOk();
      var items = (json && json.items) || {};
      var list = Array.isArray(items)
        ? items
        : Object.keys(items).map(function (k) {
            var o = items[k] || {};
            if (o.id == null) o.id = Number(k);
            return o;
          });
      var map = {};
      list.forEach(function (it) {
        var v =
          it.value && it.value.market_price != null
            ? it.value.market_price
            : it.market_value != null
              ? it.market_value
              : it.marketValue;
        if (v != null) map[it.id] = v;
      });
      gmSet("tfs_prices", { t: _nowSec(), key: key, map: map });
      return map;
    }).catch(function (e) {
      tfsApiErr();
      throw e;
    });
  }
  function getModel() {
    var cached = gmGet("tfs_model", null);
    if (cached && _nowSec() - cached.t < MODEL_TTL) return Promise.resolve(cached.data);
    return _fetchJson(MODEL_URL)
      .then(function (json) {
        var data = json && json.items ? json.items : {};
        gmSet("tfs_model", { t: _nowSec(), data: data });
        return data;
      })
      .catch(function () {
        return cached ? cached.data : {};
      });
  }
  function tfsVisible(el) {
    if (!el) return false;
    return (
      el.offsetWidth > 0 ||
      el.offsetHeight > 0 ||
      (el.getClientRects && el.getClientRects().length > 0)
    );
  }
  // Flight-progress UI is visible → we're mid-flight (Torn keeps the destination
  // list on screen while traveling, so this must be checked BEFORE the agency
  // early-return in getTravelState).
  function isFlightPage() {
    if (typeof document === "undefined") return false;
    var sels = [
      '[class*="flightProgressSection"]',
      '[class*="nodesAndProgress"]',
      '[class*="planeBg"]',
    ];
    for (var i = 0; i < sels.length; i++) {
      var el = document.querySelector(sels[i]);
      if (el && tfsVisible(el)) return true;
    }
    return false;
  }
  function isAgencyPage() {
    if (typeof document === "undefined") return false;
    return (
      tfsVisible(document.querySelector('span[class*="country___"]')) ||
      tfsVisible(document.querySelector('[class*="destinationList___"]'))
    );
  }
  function getTravelState() {
    var key = getKey();
    var domState = domTravelState();
    if (domState) return Promise.resolve(domState);
    var flying = isFlightPage();
    if (!flying && isAgencyPage()) return Promise.resolve(null);
    if (!key) {
      // Mid-flight with no API key and no DOM flight link: we can't know the
      // destination, so at least explain why the panel is missing.
      return flying
        ? Promise.resolve({
            mode: "nokey",
            msg: "Add a Torn API key (Profit mode) to see live stock & countdown while traveling.",
          })
        : Promise.resolve(null);
    }
    var cached = gmGet("tfs_travel", null);
    if (cached && _nowSec() - cached.t < TRAVEL_TTL) return Promise.resolve(cached.state);
    if (tfsApiInBackoff()) return Promise.resolve(cached ? cached.state : domTravelState());
    function keepLast() {
      var last = cached ? cached.state : null;
      gmSet("tfs_travel", { t: _nowSec(), state: last });
      return last;
    }
    return _fetchJson(TORN_TRAVEL_URL + encodeURIComponent(key))
      .then(function (json) {
        if (json && json.error) {
          tfsApiErr();
          var errState = {
            mode: "apierror",
            code: json.error.code,
            msg: json.error.error,
          };
          gmSet("tfs_travel", { t: _nowSec(), state: errState });
          return errState;
        }
        tfsApiOk();
        var state = parseTravelState(json) || domTravelState();
        gmSet("tfs_travel", { t: _nowSec(), state: state });
        return state;
      })
      .catch(function () {
        tfsApiErr();
        return domTravelState() || keepLast();
      });
  }

  // ─── DOM: settings, injector, observer ───────────────────
  function getMode() {
    var m = gmGet("tfs_mode", "stock");
    return m === "profit" ? "profit" : "stock";
  }
  function setMode(m) {
    gmSet("tfs_mode", m);
  }
  function getHidden() {
    return gmGet("tfs_hidden", false) === true;
  }
  function setHidden(v) {
    gmSet("tfs_hidden", !!v);
  }
  function getKey() {
    return gmGet("tfs_key", "") || "";
  }
  function setKey(k) {
    gmSet("tfs_key", String(k || "").trim());
  }
  function maskKey(k) {
    k = String(k || "");
    return k.length > 4 ? new Array(k.length - 3).join("•") + k.slice(-4) : k;
  }
  function tfsMsg(s) {
    var m = document.querySelector("#tfs-bar .tfs-msg");
    if (m) m.textContent = s ? " " + s : "";
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function injectCss() {
    if (document.getElementById("tfs-css")) return;
    var s = document.createElement("style");
    s.id = "tfs-css";
    s.textContent =
      ".tfs-bar{display:flex;box-sizing:border-box;align-items:center;gap:6px;flex-wrap:wrap;padding:7px 10px;margin:8px 0;background:#16181d;border:1px solid #262a33;border-radius:7px;box-shadow:0 1px 3px rgba(0,0,0,.35);font-size:12px;color:#cfd4dc;}" +
      "body.tfs-desk .tfs-bar{width:auto;max-width:680px;margin-left:auto;margin-right:auto;}" +
      "body.tfs-desk .tfs-bar .tfs-frow.flags{flex-wrap:wrap;}" +
      ".tfs-bar .tfs-title{font-weight:700;color:#e8c44a;letter-spacing:.3px;margin-right:4px;}" +
      ".tfs-seg{display:inline-flex;border:1px solid #2e333d;border-radius:7px;overflow:hidden;background:#14161b;}" +
      ".tfs-toggle{background:transparent;color:#8a909a;border:0;border-radius:0;padding:4px 16px;cursor:pointer;font-weight:600;transition:background .12s,color .12s;}" +
      ".tfs-toggle:hover{background:#20242c;color:#cfd4dc;}" +
      ".tfs-toggle.on{background:#3b6dff;color:#fff;}" +
      ".tfs-toggle+.tfs-toggle{border-left:1px solid #2e333d;}" +
      ".tfs-focuswrap{display:inline-flex;align-items:center;gap:4px;color:#8a909a;}" +
      ".tfs-focus{background:#0e0f12;color:#dde2e8;border:1px solid #2e333d;border-radius:6px;padding:3px 6px;font-size:12px;cursor:pointer;max-width:160px;}" +
      ".tfs-refresh,.tfs-save,.tfs-filterbtn,.tfs-hide{background:#20242c;color:#aeb4bd;border:1px solid #2e333d;border-radius:7px;padding:4px 10px;cursor:pointer;transition:background .12s,color .12s;}" +
      ".tfs-refresh{width:27px;height:26px;padding:0;border-radius:50%;font-size:13px;display:inline-flex;align-items:center;justify-content:center;}" +
      ".tfs-refresh:hover,.tfs-save:hover,.tfs-filterbtn:hover,.tfs-hide:hover{background:#262b34;color:#e6e9ee;border-color:#3a4150;}" +
      ".tfs-autoref{display:inline-flex;align-items:center;gap:3px;color:#8a909a;font-size:11px;cursor:pointer;user-select:none;}" +
      ".tfs-autoref input{accent-color:#3b6dff;margin:0;}" +
      ".tfs-hide.on{border-color:#3b6dff;color:#cfd4dc;}" +
      ".tfs-key{background:#0e0f12;border:1px solid #2e333d;color:#dde2e8;border-radius:6px;padding:3px 8px;width:150px;}" +
      ".tfs-msg{color:#e08a7a;}" +
      ".tfs-filters{display:none;flex-basis:100%;margin-top:7px;padding-top:8px;border-top:1px solid #262a33;}" +
      ".tfs-filters.open{display:block;}" +
      ".tfs-frow{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:5px 0;}" +
      ".tfs-frow.flags{flex-wrap:nowrap;gap:6px;}" +
      ".tfs-frow .lbl{color:#7a818c;margin-right:2px;width:66px;flex:0 0 66px;font-size:10px;text-transform:uppercase;letter-spacing:.5px;}" +
      ".tfs-ricon{margin-right:5px;font-size:11px;opacity:.95;}" +
      ".tfs-chip{cursor:pointer;font-size:11px;transition:all .12s;}" +
      ".tfs-chip.cat{display:inline-flex;align-items:center;gap:3px;background:#202a40;color:#aec4ff;border:1px solid #2c3650;border-radius:11px;padding:2px 10px;}" +
      ".tfs-chip.cat:hover{border-color:#3b6dff;}" +
      ".tfs-chip.cat.off{background:transparent;color:#5b626d;border-color:#2a2e38;}" +
      ".tfs-chip.cat.off .tfs-cicon{filter:grayscale(1);opacity:.55;}" +
      ".tfs-chip.flag{background:transparent;border:0;border-radius:5px;font-size:15px;line-height:1;padding:1px 2px;flex:0 0 auto;}" +
      ".tfs-chip.flag:hover{background:#20242c;}" +
      ".tfs-chip.flag.off{filter:grayscale(1);opacity:.3;}" +
      ".tfs-ftog{background:#1a1e26;color:#8a909a;border:1px solid #2e333d;border-radius:7px;padding:3px 11px;cursor:pointer;transition:all .12s;}" +
      ".tfs-ftog:hover{border-color:#3a4150;color:#cfd4dc;}" +
      ".tfs-ftog.on{background:#3b6dff;color:#fff;border-color:#3b6dff;}" +
      ".tfs-ftog.on::before{content:'✓ ';}" +
      ".tfs-panel{margin:5px 0 10px;font-size:12px;max-width:540px;}" +
      ".tfs-head{display:flex;align-items:center;padding:2px 6px 3px;}" +
      ".tfs-age{margin-left:auto;font-size:10px;color:#6f7681;background:#20242c;padding:1px 7px;border-radius:8px;white-space:nowrap;}" +
      ".tfs-age.stale{opacity:.5;}" +
      ".tfs-row,.tfs-tr{display:grid;grid-template-columns:minmax(0,1fr) 50px 96px;gap:8px;align-items:baseline;padding:2px 6px;border-radius:4px;}" +
      ".tfs-row.mp,.tfs-tr.mp{grid-template-columns:minmax(0,1fr) 46px 92px 112px;}" +
      ".tfs-row.out,.tfs-tr.out{grid-template-columns:minmax(0,1fr) auto;opacity:.72;}" +
      ".tfs-row:hover,.tfs-tr:hover{background:#20242c;}" +
      ".tfs-name,.tfs-tn{min-width:0;color:#cfd4dc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
      ".tfs-qty,.tfs-tq{color:#7a818c;text-align:right;font-variant-numeric:tabular-nums;}" +
      ".tfs-cost,.tfs-tcost{color:#aeb4bd;text-align:right;font-variant-numeric:tabular-nums;}" +
      ".tfs-profit,.tfs-tp{text-align:right;font-variant-numeric:tabular-nums;}" +
      ".tfs-profit.pos,.tfs-tp.pos{color:#51c97a;}.tfs-profit.neg,.tfs-tp.neg{color:#b06a5a;}" +
      ".tfs-oos,.tfs-toos{text-align:right;color:#d8a463;font-style:italic;white-space:nowrap;}" +
      "#tfs-desktop{margin:8px 0;}" +
      ".tfs-thost{background:#16181d;border:1px solid #262a33;border-radius:7px;box-shadow:0 1px 4px rgba(0,0,0,.4);overflow:hidden;font-size:12px;color:#cfd4dc;}" +
      ".tfs-thead{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#1c1f26;border-bottom:1px solid #262a33;}" +
      ".tfs-ttitle{font-weight:600;color:#8a909a;font-size:11px;text-transform:uppercase;letter-spacing:.6px;}" +
      ".tfs-bar .tfs-ico{font-size:13px;}" +
      ".tfs-tcollapse{background:none;border:0;color:#8a909a;cursor:pointer;font-size:13px;line-height:1;}" +
      ".tfs-tbody{padding:6px 12px 10px;max-height:64vh;overflow-y:auto;}" +
      ".tfs-tbody::-webkit-scrollbar{width:9px;}.tfs-tbody::-webkit-scrollbar-thumb{background:#2e333d;border-radius:5px;}" +
      ".tfs-tc{margin:0 0 12px;max-width:540px;}" +
      ".tfs-tch{display:flex;align-items:center;gap:7px;font-weight:600;color:#e6e9ee;padding:5px 6px 4px;border-bottom:1px solid #262a33;margin-bottom:3px;position:sticky;top:-1px;background:#16181d;}" +
      ".tfs-flag{font-size:14px;}" +
      ".tfs-tempty{color:#7a818c;padding:6px 6px;}" +
      ".tfs-verdict{font-size:11px;line-height:1.3;margin:0 0 4px;padding:2px 6px 4px;color:#aeb4bd;border-left:2px solid #2e333d;}" +
      ".tfs-verdict.safe{color:#51c97a;border-left-color:#2f6b45;}" +
      ".tfs-verdict.risky{color:#e0b35a;border-left-color:#7a5e22;}" +
      ".tfs-verdict.gone{color:#d8736a;border-left-color:#6b322c;}" +
      ".tfs-verdict.restock{color:#6aa6e0;border-left-color:#2c4d6b;}" +
      ".tfs-verdict.lowconf{opacity:.6;}" +
      ".tfs-verdict .tfs-lc{color:#7a818c;font-style:italic;}" +
      "#tfs-travel{margin:8px 0 10px;font-size:12px;max-width:540px;background:#16181d;border:1px solid #262a33;border-radius:7px;box-shadow:0 1px 4px rgba(0,0,0,.4);overflow:hidden;color:#cfd4dc;}" +
      ".tfs-travel-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:8px 12px;background:#1c1f26;border-bottom:1px solid #262a33;font-weight:600;color:#e6e9ee;}" +
      ".tfs-travel-head .tfs-flag{font-size:16px;}" +
      ".tfs-travel-head .tfs-cn{color:#e6e9ee;}" +
      ".tfs-countdown{margin-left:auto;font-size:11px;color:#e8c44a;background:#20242c;padding:2px 9px;border-radius:9px;white-space:nowrap;font-variant-numeric:tabular-nums;}" +
      "#tfs-travel .tfs-rows{padding:6px 12px 10px;}" +
      "#tfs-travel .tfs-tempty{color:#7a818c;padding:6px 0;}" +
      ".tfs-budget-btn{background:#20242c;color:#aeb4bd;border:1px solid #2e333d;border-radius:7px;padding:4px 10px;cursor:pointer;font-size:12px;margin-left:4px;transition:background .12s,color .12s;}" +
      ".tfs-budget-btn:hover{background:#262b34;color:#e6e9ee;border-color:#3a4150;}" +
      ".tfs-budget-btn.on{background:#3b6dff;color:#fff;}" +
      "#tfs-budget-panel{margin:8px 0 0;max-width:680px;border:1px solid #262a33;border-radius:7px;box-shadow:0 1px 4px rgba(0,0,0,.4);overflow:hidden;font-size:12px;color:#cfd4dc;background:#16181d;display:none;}" +
      "body.tfs-desk #tfs-budget-panel{margin-left:auto;margin-right:auto;}" +
      ".tfs-bhead{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#1c1f26;border-bottom:1px solid #262a33;font-weight:600;color:#e6e9ee;}" +
      ".tfs-btitle{display:flex;align-items:center;gap:6px;}" +
      ".tfs-budget-controls{display:inline-flex;align-items:center;gap:6px;}" +
      ".tfs-budget-input{background:#0e0f12;border:1px solid #2e333d;color:#dde2e8;border-radius:6px;padding:3px 8px;width:110px;font-size:12px;}" +
      ".tfs-bplan{background:#3b6dff;color:#fff;border:1px solid #3b6dff;border-radius:7px;padding:3px 10px;cursor:pointer;font-size:12px;}" +
      ".tfs-bplan:hover{background:#4a7cff;}" +
      ".tfs-bclose{background:transparent;border:0;color:#8a909a;cursor:pointer;font-size:16px;line-height:1;padding:0 4px;}" +
      ".tfs-bsummary{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:8px 12px;background:#14161b;border-bottom:1px solid #262a33;font-size:12px;}" +
      ".tfs-bsummary .tfs-sitem{display:inline-flex;align-items:center;gap:3px;}" +
      ".tfs-slabel{color:#7a818c;}" +
      ".tfs-sval{color:#e6e9ee;font-weight:600;}" +
      ".tfs-btable{padding:6px 12px 10px;max-height:56vh;overflow:auto;-webkit-overflow-scrolling:touch;}" +
      ".tfs-bhead-row{display:flex;align-items:center;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#8a909a;padding:4px 6px;border-bottom:1px solid #262a33;}" +
      ".tfs-brow{display:flex;align-items:center;padding:2px 6px;}" +
      ".tfs-brow.out{color:#5b626d;}" +
      ".b-name{flex:2 0;min-width:90px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}" +
      ".b-flag{width:24px;text-align:center;font-size:14px;}" +
      ".b-stock{width:44px;text-align:right;}" +
      ".b-restock{flex:1 0;min-width:70px;font-size:10px;color:#8a909a;}" +
      ".b-qty{width:36px;text-align:right;}" +
      ".b-cost{width:60px;text-align:right;}" +
      ".b-value{width:60px;text-align:right;}" +
      ".b-profit{width:56px;text-align:right;}" +
      ".b-tprofit{width:70px;text-align:right;font-weight:600;}" +
      ".tfs-brow .tfs-profit.pos{color:#51c97a;}" +
      ".tfs-brow .tfs-profit.neg{color:#d8736a;}" +
      ".tfs-bempty{color:#7a818c;padding:8px 12px;}" +
      ".tfs-btoggle{background:#20242c;color:#cfd4dc;border:1px solid #2e333d;border-radius:5px;width:22px;height:22px;line-height:1;cursor:pointer;font-size:14px;flex:0 0 auto;}" +
      ".tfs-btoggle:hover{background:#2b303b;border-color:#3a4150;}" +
      ".b-roi{width:44px;text-align:right;font-size:10px;color:#c9a227;}" +
      ".tfs-brow .tfs-roi{color:#c9a227;}" +
      ".tfs-bhead-row,.tfs-brow{min-width:640px;}";
    document.head.appendChild(s);
  }

  var TFS_CATS = ["Plushie", "Flower", "Drug", "Temporary", "Weapon", "Armor", "Other"];
  var TFS_COUNTRIES = [
    ["mex", "Mexico"],
    ["cay", "Cayman"],
    ["can", "Canada"],
    ["haw", "Hawaii"],
    ["uni", "UK"],
    ["arg", "Argentina"],
    ["swi", "Switz"],
    ["jap", "Japan"],
    ["chi", "China"],
    ["uae", "UAE"],
    ["sou", "S.Africa"],
  ];
  var TFS_FLAGS = {
    mex: "🇲🇽",
    cay: "🇰🇾",
    can: "🇨🇦",
    haw: "🏝",
    uni: "🇬🇧",
    arg: "🇦🇷",
    swi: "🇨🇭",
    jap: "🇯🇵",
    chi: "🇨🇳",
    uae: "🇦🇪",
    sou: "🇿🇦",
  };
  function tfsFlag(code) {
    return TFS_FLAGS[code] || "🏳";
  }
  var TFS_CATICON = {
    Plushie: "🧸",
    Flower: "🌸",
    Drug: "💊",
    Temporary: "⏳",
    Weapon: "⚔️",
    Armor: "🛡️",
    Other: "📦",
  };
  function tfsRowIcon(id) {
    var ic = TFS_CATICON[itemCategory(id)];
    return ic ? '<span class="tfs-ricon">' + ic + "</span>" : "";
  }

  function buildFilterPanel(onChange) {
    var f = getFilters();
    var panel = document.createElement("div");
    panel.className = "tfs-filters";
    panel.id = "tfs-filters";
    var html =
      '<div class="tfs-frow">' +
      '<button class="tfs-ftog' +
      (f.hideOos ? " on" : "") +
      '" data-t="oos">Hide out-of-stock</button>' +
      '<button class="tfs-ftog' +
      (f.hideNeg ? " on" : "") +
      '" data-t="neg">Hide -profit</button>' +
      '</div><div class="tfs-frow"><span class="lbl">Items</span>';
    for (var i = 0; i < TFS_CATS.length; i++)
      html +=
        '<span class="tfs-chip cat' +
        (f.excludedCats.indexOf(TFS_CATS[i]) !== -1 ? " off" : "") +
        '" data-cat="' +
        TFS_CATS[i] +
        '" title="' +
        TFS_CATS[i] +
        '"><span class="tfs-cicon">' +
        (TFS_CATICON[TFS_CATS[i]] || "") +
        "</span>" +
        TFS_CATS[i] +
        "</span>";
    html += '</div><div class="tfs-frow flags"><span class="lbl">Countries</span>';
    for (var k = 0; k < TFS_COUNTRIES.length; k++)
      html +=
        '<span class="tfs-chip ctry flag' +
        (f.hiddenCountries.indexOf(TFS_COUNTRIES[k][0]) !== -1 ? " off" : "") +
        '" data-code="' +
        TFS_COUNTRIES[k][0] +
        '" title="' +
        TFS_COUNTRIES[k][1] +
        '">' +
        tfsFlag(TFS_COUNTRIES[k][0]) +
        "</span>";
    html += "</div>";
    panel.innerHTML = html;
    var togs = panel.querySelectorAll(".tfs-ftog");
    for (var t = 0; t < togs.length; t++) {
      (function (b) {
        b.addEventListener("click", function () {
          var which = b.getAttribute("data-t");
          if (which === "oos") gmSet("tfs_hide_oos", !gmGet("tfs_hide_oos", false));
          else gmSet("tfs_hide_negprofit", !gmGet("tfs_hide_negprofit", false));
          b.classList.toggle("on");
          onChange(false);
        });
      })(togs[t]);
    }
    var catChips = panel.querySelectorAll(".tfs-chip.cat");
    for (var ci = 0; ci < catChips.length; ci++) {
      (function (c) {
        c.addEventListener("click", function () {
          var cat = c.getAttribute("data-cat");
          var ex = gmGet("tfs_cats", []);
          var idx = ex.indexOf(cat);
          if (idx === -1) {
            ex.push(cat);
            c.classList.add("off");
          } else {
            ex.splice(idx, 1);
            c.classList.remove("off");
          }
          gmSet("tfs_cats", ex);
          onChange(false);
        });
      })(catChips[ci]);
    }
    var ctryChips = panel.querySelectorAll(".tfs-chip.ctry");
    for (var di = 0; di < ctryChips.length; di++) {
      (function (c) {
        c.addEventListener("click", function () {
          var code = c.getAttribute("data-code");
          var hc = gmGet("tfs_hidden_countries", []);
          var idx = hc.indexOf(code);
          if (idx === -1) {
            hc.push(code);
            c.classList.add("off");
          } else {
            hc.splice(idx, 1);
            c.classList.remove("off");
          }
          gmSet("tfs_hidden_countries", hc);
          onChange(false);
        });
      })(ctryChips[di]);
    }
    return panel;
  }

  function isMapLayout() {
    return (
      !!document.querySelector('[class*="worldMap___"]') &&
      !document.querySelector('span[class*="country___"]')
    );
  }
  function desktopHost() {
    var h = document.getElementById("tfs-desktop");
    if (h) return h;
    h = document.createElement("div");
    h.id = "tfs-desktop";
    var map = document.querySelector('[class*="worldMap___"]');
    var cont =
      (map && (map.closest('[class*="content-wrapper"]') || map.parentElement)) ||
      document.querySelector('[class*="content-wrapper"]') ||
      document.querySelector(".content") ||
      document.body;
    cont.appendChild(h);
    return h;
  }
  function ensureTablePanel() {
    var panel = document.getElementById("tfs-table-host");
    if (panel) return panel;
    panel = document.createElement("div");
    panel.id = "tfs-table-host";
    panel.className = "tfs-thost";
    panel.innerHTML =
      '<div class="tfs-thead"><span class="tfs-ttitle">Stock by country</span><button class="tfs-tcollapse" title="Collapse">▾</button></div><div class="tfs-tbody"></div>';
    panel.querySelector(".tfs-tcollapse").addEventListener("click", function () {
      var b = panel.querySelector(".tfs-tbody"),
        btn = panel.querySelector(".tfs-tcollapse");
      var show = b.style.display === "none";
      b.style.display = show ? "" : "none";
      btn.textContent = show ? "▾" : "▸";
    });
    desktopHost().appendChild(panel);
    return panel;
  }
  function paintTable(stock, mode, prices, model) {
    var filters = getFilters();
    var panel = ensureTablePanel();
    var body = panel.querySelector(".tfs-tbody");
    var nowMs = Date.now();
    var html = "";
    for (var ci = 0; ci < TFS_COUNTRIES.length; ci++) {
      var code = TFS_COUNTRIES[ci][0],
        cname = TFS_COUNTRIES[ci][1];
      if (!countryVisible(code, filters)) continue;
      var country = stock[code];
      if (!country) continue;
      var rows = sortRows(
        buildRows(country.items, {
          mode: mode,
          getValue: function (id) {
            return prices[id];
          },
        }),
        mode,
        nowMs,
      );
      rows = rows.filter(function (r) {
        return rowVisible(r, mode, filters);
      });
      if (!rows.length) continue;
      var age = formatAge(country.update, Math.floor(nowMs / 1000));
      html +=
        '<div class="tfs-tc"><div class="tfs-tch"><span class="tfs-flag">' +
        tfsFlag(code) +
        '</span><span class="tfs-cn">' +
        cname +
        '</span><span class="tfs-age' +
        (age.stale ? " stale" : "") +
        '">updated ' +
        age.text +
        "</span></div>";
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (r.qty === 0) {
          var entry = model && model[code] ? model[code][String(r.id)] : null;
          html +=
            '<div class="tfs-tr out"><span class="tfs-tn">' +
            tfsRowIcon(r.id) +
            escapeHtml(r.name) +
            '</span><span class="tfs-toos">' +
            restockDisplay(r.nextRestock, entry, nowMs, r.qty) +
            "</span></div>";
        } else {
          html +=
            '<div class="tfs-tr' +
            (mode === "profit" ? " mp" : "") +
            '"><span class="tfs-tn">' +
            tfsRowIcon(r.id) +
            escapeHtml(r.name) +
            '</span><span class="tfs-tq">×' +
            r.qty +
            '</span><span class="tfs-tcost">' +
            fmtMoney(r.cost) +
            "</span>" +
            (mode === "profit"
              ? '<span class="tfs-tp ' +
                (r.profit != null && r.profit > 0 ? "pos" : "neg") +
                '">' +
                fmtProfit(r.profit) +
                " ea</span>"
              : "") +
            "</div>";
        }
      }
      html += "</div>";
    }
    body.innerHTML = html || '<div class="tfs-tempty">No items match your filters.</div>';
  }

  function fmtClock(sec) {
    var s = Math.max(0, Math.floor(sec));
    var h = Math.floor(s / 3600),
      m = Math.floor((s % 3600) / 60),
      ss = s % 60;
    function p(n) {
      return (n < 10 ? "0" : "") + n;
    }
    return h > 0 ? h + ":" + p(m) + ":" + p(ss) : p(m) + ":" + p(ss);
  }
  function travelHost() {
    return (
      document.querySelector('[class*="content-wrapper"]') ||
      document.getElementById("mainContainer") ||
      document.body
    );
  }
  function tfsHash(s) {
    var h = 0;
    s = String(s);
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return h;
  }
  // ── Live stock from Torn's own store grid (overrides the lagging API) ──
  // Torn's foreign-store row = div[class*="row___"]; each column is a
  // div[class*="cell___"] whose screen-reader span (class*="srOnly") names it
  // ("type", "stock", …). The stock count is a bare text node after that span,
  // so we read the whole cell's digits. Keyed on the label, not the hashed class.
  function tfsCellLabel(cell) {
    var sr = cell.querySelector('[class*="srOnly"]');
    return sr ? String(sr.textContent || "").toLowerCase() : "";
  }
  function tfsStockFromRow(rowEl) {
    var cells = rowEl.querySelectorAll('[class*="cell___"]');
    var stockN = null,
      availN = null;
    for (var c = 0; c < cells.length; c++) {
      var label = tfsCellLabel(cells[c]);
      var isStock = label.indexOf("stock") !== -1;
      var isAvail = label.indexOf("available") !== -1;
      if (!isStock && !isAvail) continue;
      var digits = String(cells[c].textContent || "").replace(/[^\d]/g, "");
      if (isStock)
        stockN = digits ? parseInt(digits, 10) : 0; // no digits = "Out of stock"
      else if (digits) availN = parseInt(digits, 10);
    }
    return stockN != null ? stockN : availN;
  }
  function tfsStoreRowImgId(rowEl) {
    var img = rowEl.querySelector('img[src*="/images/items/"]');
    if (!img) return null;
    var m = String(img.getAttribute("src") || "").match(/\/images\/items\/(\d+)/);
    return m ? m[1] : null;
  }
  function tfsLiveStock(rows) {
    var live = {},
      byId = {};
    try {
      for (var i = 0; i < rows.length; i++) byId[String(rows[i].id)] = rows[i];
      var storeRows = document.querySelectorAll('div[class*="row___"]');
      for (var j = 0; j < storeRows.length; j++) {
        var id = tfsStoreRowImgId(storeRows[j]);
        if (!id || !byId[id]) continue;
        var q = tfsStockFromRow(storeRows[j]);
        if (q != null) live[id] = q;
      }
    } catch (e) {}
    return live;
  }
  function travelRowsHtml(state, stock, model, prices, mode, nowMs) {
    var country = stock && stock[state.code];
    if (!country || !country.items || !country.items.length)
      return '<div class="tfs-tempty">no stock data</div>';
    var built = buildRows(country.items, {
      mode: mode,
      getValue: function (id) {
        return prices[id];
      },
    });
    if (state.mode === "abroad") {
      var live = tfsLiveStock(built);
      for (var liv = 0; liv < built.length; liv++) {
        var lv = live[String(built[liv].id)];
        if (lv != null) built[liv].qty = lv;
      }
    }
    var rows = sortRows(built, mode, nowMs);
    rows = rows.filter(function (r) {
      return rowVisible(r, mode, getFilters());
    });
    if (!rows.length) return '<div class="tfs-tempty">no stock data</div>';
    var flightMinutes =
      state.mode === "flight" && state.timeLeftSec != null ? state.timeLeftSec / 60 : null;
    var html = "";
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var entry = model && model[state.code] ? model[state.code][String(r.id)] : null;
      if (r.qty === 0) {
        html +=
          '<div class="tfs-row out"><span class="tfs-name">' +
          tfsRowIcon(r.id) +
          escapeHtml(r.name) +
          "</span>" +
          '<span class="tfs-oos">' +
          restockDisplay(r.nextRestock, entry, nowMs, r.qty) +
          "</span></div>";
      } else {
        html +=
          '<div class="tfs-row' +
          (mode === "profit" ? " mp" : "") +
          '"><span class="tfs-name">' +
          tfsRowIcon(r.id) +
          escapeHtml(r.name) +
          '</span><span class="tfs-qty">×' +
          r.qty +
          '</span><span class="tfs-cost">' +
          fmtMoney(r.cost) +
          "</span>" +
          (mode === "profit"
            ? '<span class="tfs-profit ' +
              (r.profit != null && r.profit > 0 ? "pos" : "neg") +
              '">' +
              fmtProfit(r.profit) +
              " ea</span>"
            : "") +
          "</div>";
        if (state.mode === "flight") {
          var verdict = entry
            ? landVerdict({
                qty: r.qty,
                sellRate: entry.sellRate,
                srel: entry.srel,
                sellReady: !!entry.sellReady,
                flightMinutes: flightMinutes,
                nextRestock: r.nextRestock,
                restockEntry: entry,
                nowMs: nowMs,
              })
            : null;
          if (verdict) {
            var cls =
              {
                SAFE: "safe",
                RISKY: "risky",
                GONE: "gone",
                GONE_THEN_RESTOCKED: "restock",
              }[verdict.state] || "";
            html +=
              '<div class="tfs-verdict ' +
              cls +
              (verdict.lowConf ? " lowconf" : "") +
              '">' +
              escapeHtml(verdict.text) +
              (verdict.lowConf ? ' <span class="tfs-lc">(low confidence)</span>' : "") +
              "</div>";
          }
        } else {
          html +=
            '<div class="tfs-verdict">' +
            restockDisplay(r.nextRestock, entry, nowMs, r.qty) +
            "</div>";
        }
      }
    }
    return html;
  }
  function autoMatchTravelWidth(panel) {
    try {
      if (typeof document === "undefined" || !document.body) return;
      if (IS_PDA || !document.body || !document.body.classList.contains("tfs-desk")) return; // desktop only, never PDA
      if (!panel || !panel.parentElement) return;
      var sels = [
        '[class*="flightProgressSection"]',
        '[class*="viewport___"]',
        '[class*="content-wrapper"]',
      ];
      var ref = null;
      for (var i = 0; i < sels.length; i++) {
        var el = document.querySelector(sels[i]);
        if (!el) continue;
        var w = el.getBoundingClientRect().width;
        if (w >= 320 && w <= 1400) {
          ref = el;
          break;
        }
      }
      if (!ref) return;
      var rb = ref.getBoundingClientRect(),
        hb = panel.parentElement.getBoundingClientRect();
      panel.style.maxWidth = Math.round(rb.width) + "px";
      panel.style.marginLeft = Math.max(0, Math.round(rb.left - hb.left)) + "px";
      panel.style.marginRight = "0";
    } catch (e) {}
  }
  function renderTravelPanel(state, stock, model, prices, nowMs) {
    if (!state) return;
    prices = prices || {};
    model = model || {};
    var mode = getMode() === "profit" && Object.keys(prices).length ? "profit" : "stock";
    var hasTime = state.timeLeftSec != null || state.arrivalSec != null;
    var rowsHtml = travelRowsHtml(state, stock, model, prices, mode, nowMs);
    var sig =
      state.mode +
      "|" +
      state.code +
      "|" +
      mode +
      "|" +
      (hasTime ? "t" : "n") +
      "|" +
      tfsHash(rowsHtml);
    var panel = document.getElementById("tfs-travel");
    var fresh = false;
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "tfs-travel";
      var host = travelHost();
      host.insertBefore(panel, host.firstChild);
      fresh = true;
    }
    autoMatchTravelWidth(panel);
    var tfsBarEl = document.getElementById("tfs-bar");
    if (tfsBarEl) autoMatchTravelWidth(tfsBarEl);
    if (!fresh && panel.getAttribute("data-tfs-sig") === sig) return;
    panel.setAttribute("data-tfs-sig", sig);
    var head;
    if (state.mode === "flight") {
      if (hasTime) {
        var left =
          state.timeLeftSec != null
            ? state.timeLeftSec
            : (state.arrivalSec || 0) - Math.floor(nowMs / 1000);
        head =
          '<span class="tfs-flag">' +
          tfsFlag(state.code) +
          '</span><span class="tfs-cn">' +
          escapeHtml(state.countryName || "") +
          "</span>" +
          '<span class="tfs-countdown">Landing in ' +
          fmtClock(left) +
          "</span>";
      } else {
        head =
          '<span class="tfs-flag">' +
          tfsFlag(state.code) +
          '</span><span class="tfs-cn">Flying to ' +
          escapeHtml(state.countryName || "") +
          "</span>";
      }
    } else {
      head =
        '<span class="tfs-flag">' +
        tfsFlag(state.code) +
        '</span><span class="tfs-cn">You\'re in ' +
        escapeHtml(state.countryName || "") +
        "</span>";
    }
    panel.innerHTML =
      '<div class="tfs-travel-head">' + head + '</div><div class="tfs-rows">' + rowsHtml + "</div>";
  }
  var _travelTimer = null,
    _travelState = null,
    _travelLastMin = null,
    _travelCtx = null;
  var _tfsAutoTimer = null;
  function manageAutoRefresh() {
    if (_tfsAutoTimer) { clearInterval(_tfsAutoTimer); _tfsAutoTimer = null; }
    if (gmGet("tfs_autorefresh", true) !== false) {
      _tfsAutoTimer = setInterval(function () {
        if (gmGet("tfs_autorefresh", true) !== false) applyAll(false);
      }, 30000);
    }
  }
  function updateCountdown() {
    var panel = document.getElementById("tfs-travel");
    if (!panel || !_travelState || _travelState.mode !== "flight") {
      clearTravelTicker();
      return;
    }
    if (!IS_PDA && typeof document !== "undefined" && document.hidden) return;
    var left = (_travelState.arrivalSec || 0) - _nowSec();
    if (left < 0) left = 0;
    var cd = panel.querySelector(".tfs-countdown");
    if (cd) cd.textContent = "Landing in " + fmtClock(left);
    var min = Math.floor(left / 60);
    if (min !== _travelLastMin) {
      _travelLastMin = min;
      if (_travelCtx) {
        var rows = panel.querySelector(".tfs-rows");
        if (rows) {
          var st = {
            mode: "flight",
            code: _travelState.code,
            countryName: _travelState.countryName,
            arrivalSec: _travelState.arrivalSec,
            timeLeftSec: left,
          };
          var mode =
            getMode() === "profit" && Object.keys(_travelCtx.prices).length ? "profit" : "stock";
          rows.innerHTML = travelRowsHtml(
            st,
            _travelCtx.stock,
            _travelCtx.model,
            _travelCtx.prices,
            mode,
            Date.now(),
          );
        }
      }
    }
  }
  function startTravelTicker(state, ctx) {
    _travelState = state;
    if (state && state.mode === "flight") {
      _travelCtx = ctx || null;
      _travelLastMin = null;
      if (!_travelTimer) _travelTimer = setInterval(updateCountdown, 1000);
    } else {
      clearTravelTicker();
    }
  }
  function clearTravelTicker() {
    if (_travelTimer) {
      clearInterval(_travelTimer);
      _travelTimer = null;
    }
    _travelLastMin = null;
    _travelCtx = null;
  }
  function removeTravelPanel() {
    clearTravelTicker();
    _travelState = null;
    var panel = document.getElementById("tfs-travel");
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
  }
  // Hide button: strip every injected stock table (desktop, inline per-country,
  // and the in-flight panel) while leaving the control bar so it can be shown again.
  function removeAllTables() {
    var host = document.getElementById("tfs-table-host");
    if (host && host.parentNode) host.parentNode.removeChild(host);
    var panels = document.querySelectorAll(".tfs-panel");
    for (var i = 0; i < panels.length; i++) {
      if (panels[i].parentNode) panels[i].parentNode.removeChild(panels[i]);
    }
    removeTravelPanel();
  }

  function injectSettingsBar(onChange) {
    if (document.getElementById("tfs-bar")) return;
    var bar = document.createElement("div");
    bar.id = "tfs-bar";
    bar.className = "tfs-bar";
    var mode = getMode();
    var focusOpts =
      '<option value="">All countries</option>' +
      TFS_COUNTRIES.map(function (c) {
        return '<option value="' + c[0] + '">' + tfsFlag(c[0]) + " " + c[1] + "</option>";
      }).join("");
    bar.innerHTML =
      '<span class="tfs-title"><span class="tfs-ico">✈</span> Foreign Stocks</span>' +
      '<span class="tfs-seg"><button class="tfs-toggle" data-mode="stock">Stock</button><button class="tfs-toggle" data-mode="profit">Profit</button></span>' +
      '<span class="tfs-focuswrap">Show <select class="tfs-focus" title="Show only one country">' +
      focusOpts +
      "</select></span>" +
      '<button class="tfs-refresh" title="Refresh stock">↻</button>' +
      '<label class="tfs-autoref" title="Auto-refresh every 30s">🔁 Auto' +
      '<input id="tfs-autoref-cb" type="checkbox"' +
      (gmGet("tfs_autorefresh", true) !== false ? " checked" : "") + ">" +
      "</label>" +
      '<button class="tfs-filterbtn">Filters ▾</button>' +
      '<button class="tfs-hide" title="Hide or show the stock tables"></button>' +
      '<button class="tfs-budget-btn" title="Budget planner">💰 Budget</button>' +
      '<span class="tfs-keywrap" style="display:' +
      (mode === "profit" ? "inline-flex" : "none") +
      '">' +
      '<input class="tfs-key" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="Torn API key for profit"' +
      (getKey() ? ' value="' + maskKey(getKey()) + '" data-masked="1"' : "") +
      ">" +
      '<button class="tfs-save">Save</button></span>' +
      '<span class="tfs-msg"></span>';
    function paint() {
      var m = getMode();
      var tg = bar.querySelectorAll(".tfs-toggle");
      for (var i = 0; i < tg.length; i++) {
        tg[i].classList.toggle("on", tg[i].getAttribute("data-mode") === m);
      }
      bar.querySelector(".tfs-keywrap").style.display = m === "profit" ? "inline-flex" : "none";
      var hb = bar.querySelector(".tfs-hide");
      if (hb) {
        var h = getHidden();
        hb.textContent = h ? "👁 Show" : "🙈 Hide";
        hb.classList.toggle("on", h);
      }
    }
    var toggles = bar.querySelectorAll(".tfs-toggle");
    for (var t = 0; t < toggles.length; t++) {
      (function (btn) {
        btn.addEventListener("click", function () {
          setMode(btn.getAttribute("data-mode"));
          paint();
          onChange(false);
        });
      })(toggles[t]);
    }
    bar.querySelector(".tfs-refresh").addEventListener("click", function () {
      onChange(true);
    });
    var autoCb = bar.querySelector("#tfs-autoref-cb");
    if (autoCb) {
      autoCb.addEventListener("change", function () {
        gmSet("tfs_autorefresh", autoCb.checked);
        manageAutoRefresh();
      });
    }
    bar.querySelector(".tfs-hide").addEventListener("click", function () {
      setHidden(!getHidden());
      paint();
      onChange(false);
    });
    bar.querySelector(".tfs-save").addEventListener("click", function () {
      var el = bar.querySelector(".tfs-key");
      if (el.getAttribute("data-masked") === "1") {
        tfsMsg("unchanged");
        return;
      }
      var v = el.value.trim();
      if (!v) {
        tfsMsg(getKey() ? "unchanged" : "enter a key");
        return;
      }
      setKey(v);
      el.value = maskKey(v);
      el.setAttribute("data-masked", "1");
      tfsMsg("saved");
      onChange(true);
    });
    (function () {
      var keyEl = bar.querySelector(".tfs-key");
      keyEl.addEventListener("focus", function () {
        if (keyEl.getAttribute("data-masked") === "1") {
          keyEl.value = "";
          keyEl.removeAttribute("data-masked");
        }
      });
    })();
    var focusSel = bar.querySelector(".tfs-focus");
    if (focusSel) {
      focusSel.value = gmGet("tfs_focus_country", "");
      focusSel.addEventListener("change", function () {
        gmSet("tfs_focus_country", focusSel.value);
        onChange(false);
      });
    }
    paint();
    var fpanel = buildFilterPanel(onChange);
    bar.appendChild(fpanel);
    bar.querySelector(".tfs-filterbtn").addEventListener("click", function () {
      fpanel.classList.toggle("open");
    });
    var anchor = document.querySelector('[class*="destinationList___"]');
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(bar, anchor);
    } else if (isMapLayout()) {
      var dh = desktopHost();
      dh.insertBefore(bar, dh.firstChild);
    } else {
      var c = document.querySelector(".content") || document.body;
      c.insertBefore(bar, c.firstChild);
    }
    autoMatchTravelWidth(bar);
    // 💰 Budget Planner — create once, insert right after the settings bar
    (function () {
      var bpBtn = bar.querySelector(".tfs-budget-btn");
      if (!bpBtn) return;
      var bpPanel = ensureBudgetPanel();
      if (bpPanel && bar.parentNode) {
        bar.parentNode.insertBefore(bpPanel, bar.nextSibling);
        autoMatchTravelWidth(bpPanel);
      }
      bpBtn.addEventListener("click", function () {
        var showing = bpPanel.style.display !== "none";
        bpPanel.style.display = showing ? "none" : "block";
        bpBtn.classList.toggle("on", !showing);
        if (!showing) {
          // auto-plan with last-used budget, if any
          var saved = gmGet("tfs_budget", "");
          if (saved && parseFloat(saved) > 0) {
            var inp = bpPanel.querySelector(".tfs-budget-input");
            if (inp) inp.value = saved;
            renderBudgetPlan(parseFloat(saved));
          }
        }
      });
    })();
  }

  function findDestinations() {
    var out = [],
      seen = [];
    var spans = document.querySelectorAll('span[class*="country___"]');
    for (var i = 0; i < spans.length; i++) {
      var code = normalizeCountryName((spans[i].textContent || "").trim());
      if (!code) continue;
      var row = spans[i];
      for (var up = 0; up < 6 && row; up++) {
        var cn = (row.getAttribute && row.getAttribute("class")) || "";
        if (/destination___/.test(cn) && !/destinationList___|destinationDetails___/.test(cn))
          break;
        row = row.parentElement;
      }
      if (!row || !/destination___/.test((row.getAttribute && row.getAttribute("class")) || ""))
        continue;
      if (seen.indexOf(row) !== -1) continue;
      seen.push(row);
      out.push({ el: row, code: code });
    }
    return out;
  }

  function getTravelMethod() {
    var el = document.querySelector('input[name="travelType"][aria-checked="true"]');
    var v = el && el.value;
    return v && METHOD_MULT[v] != null ? v : "standard";
  }
  function readFlightMinutes(destEl, code) {
    if (destEl) {
      var t =
        destEl.querySelector('[class*="duration___"] time[datetime]') ||
        destEl.querySelector("time[datetime]");
      if (t) {
        var fromAttr = parseFlightMinutes(t.getAttribute("datetime"));
        if (fromAttr != null) return fromAttr;
        var vis = t.querySelector('span[aria-hidden="true"]');
        var fromText = parseFlightMinutes(vis ? vis.textContent : t.textContent);
        if (fromText != null) return fromText;
      }
    }
    if (BASE_MIN[code] != null) return Math.round(BASE_MIN[code] * METHOD_MULT[getTravelMethod()]);
    return null;
  }

  function renderPanel(destEl, code, stock, mode, prices, model, filters) {
    if (!filters) filters = {};
    var country = stock[code];
    if (!country) return;
    var rows = sortRows(
      buildRows(country.items, {
        mode: mode,
        getValue: function (id) {
          return prices[id];
        },
      }),
      mode,
    );
    rows = rows.filter(function (r) {
      return rowVisible(r, mode, filters);
    });
    if (!rows.length) {
      var gone = destEl.querySelector(".tfs-panel");
      if (gone) gone.parentNode.removeChild(gone);
      return;
    }
    var age = formatAge(country.update, Math.floor(Date.now() / 1000));
    var html =
      '<div class="tfs-head"><span class="tfs-age' +
      (age.stale ? " stale" : "") +
      '">updated ' +
      age.text +
      '</span></div><div class="tfs-rows">';
    var nowMs = Date.now();
    var flightMinutes = readFlightMinutes(destEl, code);
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var entry = model && model[code] ? model[code][String(r.id)] : null;
      if (r.qty === 0) {
        html +=
          '<div class="tfs-row out"><span class="tfs-name">' +
          tfsRowIcon(r.id) +
          escapeHtml(r.name) +
          "</span>" +
          '<span class="tfs-oos">' +
          restockDisplay(r.nextRestock, entry, nowMs, r.qty) +
          "</span></div>";
      } else {
        html +=
          '<div class="tfs-row' +
          (mode === "profit" ? " mp" : "") +
          '"><span class="tfs-name">' +
          tfsRowIcon(r.id) +
          escapeHtml(r.name) +
          '</span><span class="tfs-qty">×' +
          r.qty +
          '</span><span class="tfs-cost">' +
          fmtMoney(r.cost) +
          "</span>" +
          (mode === "profit"
            ? '<span class="tfs-profit ' +
              (r.profit != null && r.profit > 0 ? "pos" : "neg") +
              '">' +
              fmtProfit(r.profit) +
              " ea</span>"
            : "") +
          "</div>";
        var verdict = entry
          ? landVerdict({
              qty: r.qty,
              sellRate: entry.sellRate,
              srel: entry.srel,
              sellReady: !!entry.sellReady,
              flightMinutes: flightMinutes,
              nextRestock: r.nextRestock,
              restockEntry: entry,
              nowMs: nowMs,
            })
          : null;
        if (verdict) {
          var cls =
            {
              SAFE: "safe",
              RISKY: "risky",
              GONE: "gone",
              GONE_THEN_RESTOCKED: "restock",
            }[verdict.state] || "";
          html +=
            '<div class="tfs-verdict ' +
            cls +
            (verdict.lowConf ? " lowconf" : "") +
            '">' +
            escapeHtml(verdict.text) +
            (verdict.lowConf ? ' <span class="tfs-lc">(low confidence)</span>' : "") +
            "</div>";
        }
      }
    }
    html += "</div>";
    var existing = destEl.querySelector(".tfs-panel");
    if (existing) {
      existing.innerHTML = html;
    } else {
      var p = document.createElement("div");
      p.className = "tfs-panel";
      p.innerHTML = html;
      destEl.appendChild(p);
    }
  }

  var _applyTimer = null;
  function paintPanels(stock, mode, prices, model) {
    var filters = getFilters();
    var dests = findDestinations();
    for (var i = 0; i < dests.length; i++) {
      if (!countryVisible(dests[i].code, filters)) {
        var hidden = dests[i].el.querySelector(".tfs-panel");
        if (hidden) hidden.parentNode.removeChild(hidden);
        continue;
      }
      renderPanel(dests[i].el, dests[i].code, stock, mode, prices, model || {}, filters);
    }
  }
  function renderTravelError(state) {
    var panel = document.getElementById("tfs-travel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "tfs-travel";
      var host = travelHost();
      host.insertBefore(panel, host.firstChild);
    }
    var msg =
      state.code === 16
        ? "⚠️ Travel data needs a higher-access API key — yours is too low. Switch to Profit mode and paste a Limited or Full Torn API key in the box above."
        : "⚠️ Travel API error: " + escapeHtml(String(state.msg || ""));
    panel.innerHTML =
      '<div class="tfs-travel-head"><span class="tfs-cn">Foreign Stock — travel</span></div><div class="tfs-rows"><div class="tfs-tempty">' +
      msg +
      "</div></div>";
  }
  function renderTravelNoKey(msg) {
    var panel = document.getElementById("tfs-travel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "tfs-travel";
      var host = travelHost();
      host.insertBefore(panel, host.firstChild);
    }
    autoMatchTravelWidth(panel);
    panel.innerHTML =
      '<div class="tfs-travel-head"><span class="tfs-cn">Foreign Stock — traveling</span></div><div class="tfs-rows"><div class="tfs-tempty">✈️ ' +
      escapeHtml(msg || "Add a Torn API key in Profit mode to see live stock while traveling.") +
      "</div></div>";
  }
  function applyTravel(stock, model, prices) {
    getTravelState()
      .then(function (state) {
        if (!state) {
          removeTravelPanel();
          return;
        }
        if (state.mode === "nokey") {
          clearTravelTicker();
          renderTravelNoKey(state.msg);
          return;
        }
        if (state.mode === "apierror") {
          clearTravelTicker();
          renderTravelError(state);
          return;
        }
        var hasTime = state.timeLeftSec != null || state.arrivalSec != null;
        if (state.mode === "flight" && hasTime)
          startTravelTicker(state, {
            stock: stock,
            model: model || {},
            prices: prices || {},
          });
        else clearTravelTicker();
        renderTravelPanel(state, stock, model, prices, Date.now());
      })
      .catch(function () {
        removeTravelPanel();
      });
  }
  function applyAll(force) {
    var mode = getMode(),
      key = getKey();
    _tfsLastType = tfsSelectedType();
    Promise.all([getStock(force), getModel()]).then(function (res) {
      var stock = res[0],
        model = res[1] || {};
      if (!stock) {
        tfsMsg("stock unavailable");
        return;
      }
      function render(prices, m) {
        if (getHidden()) {
          removeAllTables();
          return;
        }
        if (isMapLayout()) paintTable(stock, m, prices, model);
        else paintPanels(stock, m, prices, model);
        applyTravel(stock, model, prices);
      }
      if (mode === "profit" && key) {
        return getPrices(key)
          .then(function (mp) {
            tfsMsg("");
            render(mp, "profit");
          })
          .catch(function (e) {
            tfsMsg(e && e.message ? e.message : "key error");
            render({}, "stock");
          });
      }
      if (mode === "profit" && !key) tfsMsg("add a key for profit");
      render({}, "stock");
    });
  }
  function scheduleApply() {
    if (_applyTimer) clearTimeout(_applyTimer);
    _applyTimer = setTimeout(function () {
      applyAll(false);
    }, 200);
  }
  var _tfsLastType = "",
    _tfsTypeTimer = null;
  function tfsSelectedType() {
    var el = document.querySelector('input[name="travelType"][aria-checked="true"]');
    return el
      ? String((el.value != null ? el.value : el.getAttribute && el.getAttribute("value")) || "")
      : "";
  }
  function tfsOnPageInteract() {
    if (_tfsTypeTimer) clearTimeout(_tfsTypeTimer);
    _tfsTypeTimer = setTimeout(function () {
      var t = tfsSelectedType();
      if (t && t !== _tfsLastType) {
        _tfsLastType = t;
        applyAll(false);
      }
    }, 250);
  }
  function isOurNode(node) {
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    return !!(el && el.closest && el.closest('[id^="tfs"], [class*="tfs-"]'));
  }
  function isVolatileNode(node) {
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    return !!(
      el &&
      el.closest &&
      el.closest(
        '[class*="flightProgressSection"], [class*="nodesAndProgress"], [class*="viewport___"], [class*="progressBar"], [class*="planeBg"]',
      )
    );
  }
  function startObserver() {
    var root =
      document.querySelector('[class*="destinationList___"]') ||
      document.querySelector(".content") ||
      document.body;
    var obs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        if (!isOurNode(muts[i].target) && !isVolatileNode(muts[i].target)) {
          scheduleApply();
          return;
        }
      }
    });
    obs.observe(root, { childList: true, subtree: true });
  }

  // ========== BUDGET PLANNER ==========
  // Greedy budget allocator — given a $, picks the most cost-efficient
  // profitable items across every country (highest profit-per-dollar,
  // i.e. ROI) until the budget runs out.  Out-of-stock items whose
  // restock ETA is within BUDGET_RESTOCK_MINS are still *considered*
  // (listed, marked "restocks in…") but aren't bought until restocked,
  // since there's nothing available to purchase right now.
  var BUDGET_RESTOCK_MINS = 30;

  function countryName(code) {
    for (var i = 0; i < TFS_COUNTRIES.length; i++)
      if (TFS_COUNTRIES[i][0] === code) return TFS_COUNTRIES[i][1];
    return code;
  }

  function collectBudgetCandidates(stock, prices, focusCode) {
    var filters = getFilters();
    var nowMs = Date.now();
    var focus = focusCode || filters.focusCountry;
    var codes = focus
      ? [focus]
      : TFS_COUNTRIES.map(function (c) {
          return c[0];
        });
    var out = [];
    for (var ci = 0; ci < codes.length; ci++) {
      var code = codes[ci];
      if (!countryVisible(code, filters)) continue;
      var country = stock[code];
      if (!country || !country.items) continue;
      for (var ii = 0; ii < country.items.length; ii++) {
        var it = country.items[ii];
        var value = prices[it.id];
        if (value == null || !isFinite(value)) continue;
        var cost = typeof it.cost === "number" ? it.cost : 0;
        if (!cost) continue;
        var profit = value - cost;
        if (profit <= 0) continue;
        var eta = restockEta(it.nextRestock, nowMs);
        var avail = it.qty > 0 ? it.qty : 0;
        var soon = !avail && eta && !eta.due && eta.mins <= BUDGET_RESTOCK_MINS;
        var dueNow = !avail && eta && eta.due;
        if (!avail && !soon && !dueNow) continue;
        out.push({
          id: it.id,
          name: it.name,
          code: code,
          cname: countryName(code),
          qty: it.qty,
          avail: avail,
          cost: cost,
          value: value,
          profit: profit,
          roi: profit / cost,
          eta: eta,
          soon: soon || dueNow,
          restockText: restockDisplay(it.nextRestock, null, nowMs, it.qty),
        });
      }
    }
    return out;
  }

  function budgetPlan(stock, prices, budget, focusCode, capacity) {
    var cans = collectBudgetCandidates(stock, prices, focusCode);
    capacity = isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : 0;
    // Single max-profit plan: the highest profit-per-item first, so you fill
    // your flight capacity with the most profitable items you can afford to
    // carry. Stops when the budget OR your inventory cap is reached.
    cans.sort(function (a, b) {
      if (b.profit !== a.profit) return b.profit - a.profit;
      return a.cost - b.cost;
    });
    var remaining = budget;
    var totalCost = 0,
      totalProfit = 0,
      slotsUsed = 0;
    var maxSlots = capacity; // 0 = unlimited
    for (var i = 0; i < cans.length; i++) {
      var c = cans[i];
      c.roiPct = c.cost > 0 ? (c.profit / c.cost) * 100 : 0;
      if (c.avail <= 0) {
        c.buyQty = 0;
        c.buyTotal = 0;
        c.profitTotal = 0;
        c.reason =
          c.eta && c.eta.due
            ? "stocking now"
            : c.eta
              ? "restocks in " + c.eta.mins + "m"
              : "out of stock";
        continue;
      }
      var byBudget = Math.floor(remaining / c.cost);
      var bySlots = maxSlots ? maxSlots - slotsUsed : Infinity;
      var buy = Math.min(c.avail, byBudget, bySlots);
      if (buy <= 0) {
        c.buyQty = 0;
        c.buyTotal = 0;
        c.profitTotal = 0;
        c.reason = maxSlots && slotsUsed >= maxSlots ? "capacity full" : "over budget";
        continue;
      }
      c.buyQty = buy;
      c.buyTotal = buy * c.cost;
      c.profitTotal = buy * c.profit;
      totalCost += c.buyTotal;
      totalProfit += c.profitTotal;
      remaining -= c.buyTotal;
      slotsUsed += buy;
      if (maxSlots && slotsUsed >= maxSlots) break;
    }
    return {
      candidates: cans,
      capacity: maxSlots,
      slots: slotsUsed,
      budget: budget,
      totalCost: totalCost,
      totalProfit: totalProfit,
      remaining: remaining,
    };
  }

  function budgetRestockShort(c) {
    if (c.avail > 0) return "stocked";
    if (c.eta && c.eta.due) return "due";
    if (c.eta) return c.eta.mins + "m";
    return "OOS";
  }

  function getCapacity() {
    var c = gmGet("tfs_capacity", 10);
    return isFinite(c) && c > 0 ? Math.floor(c) : 0;
  }
  function buildBudgetPanel() {
    var panel = document.createElement("div");
    panel.id = "tfs-budget-panel";
    panel.innerHTML =
      '<div class="tfs-bhead">' +
      '<span class="tfs-btitle"><span class="tfs-flag">💰</span> Budget Planner</span>' +
      '<span class="tfs-budget-controls">' +
      '<input class="tfs-budget-input" type="number" min="0" step="10" placeholder="Budget $" value="' +
      (gmGet("tfs_budget", "") || "") +
      '">' +
      '<input class="tfs-capacity" type="number" min="0" step="1" title="Max items you can carry per trip (0 = unlimited)" placeholder="Cap 10" value="' +
      (getCapacity() || "") +
      '">' +
      '<button class="tfs-bplan">Plan</button>' +
      '<button class="tfs-bclose" title="Close">×</button>' +
      "</span>" +
      "</div>" +
      '<div class="tfs-bsummary">' +
      '<span class="tfs-sitem" style="color:#8a909a;">Set your budget and click <b>Plan</b> to see the best items to buy.</span>' +
      "</div>" +
      '<div class="tfs-btable"></div>';

    var input = panel.querySelector(".tfs-budget-input");
    var planBtn = panel.querySelector(".tfs-bplan");
    var closeBtn = panel.querySelector(".tfs-bclose");
    var _planRunning = false;

    function runPlan() {
      var v = parseFloat(input.value);
      var capInput = panel.querySelector(".tfs-capacity");
      var cap = parseFloat(capInput ? capInput.value : "");
      gmSet("tfs_capacity", isFinite(cap) && cap > 0 ? Math.floor(cap) : 0);
      if (!isFinite(v) || v <= 0) {
        panel.querySelector(".tfs-bsummary").innerHTML =
          '<span class="tfs-sitem" style="color:#d8736a;">Enter a budget, then tap Plan.</span>';
        panel.querySelector(".tfs-btable").innerHTML = "";
        return;
      }
      if (_planRunning) return;
      gmSet("tfs_budget", v);
      _planRunning = true;
      planBtn.disabled = true;
      planBtn.textContent = "⏳…";
      renderBudgetPlan(v, function () {
        _planRunning = false;
        planBtn.disabled = false;
        planBtn.textContent = "Plan";
      });
    }

    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.keyCode === 13) runPlan();
    });
    planBtn.addEventListener("click", runPlan);
    closeBtn.addEventListener("click", function () {
      panel.style.display = "none";
      var btn = document.querySelector(".tfs-budget-btn");
      if (btn) btn.classList.remove("on");
    });

    return panel;
  }

  function ensureBudgetPanel() {
    var panel = document.getElementById("tfs-budget-panel");
    if (panel) return panel;
    return buildBudgetPanel();
  }

  function renderBudgetPlan(budget, done) {
    done = done || function () {};
    var panel = document.getElementById("tfs-budget-panel");
    if (!panel) {
      done();
      return;
    }
    var summary = panel.querySelector(".tfs-bsummary");
    var body = panel.querySelector(".tfs-btable");
    var key = getKey();
    if (!key) {
      summary.innerHTML =
        '<span class="tfs-sitem" style="color:#d8736a;">⚠️ Paste your Torn API key in Profit mode for item values.</span>';
      body.innerHTML = "";
      done();
      return;
    }
    summary.innerHTML = '<span class="tfs-sitem">⏳ Fetching stock & item values…</span>';
    body.innerHTML = "";

    Promise.all([getStock(false), getPrices(key)])
      .then(function (res) {
        var stock = res[0] || {},
          prices = res[1] || {};
        var focus = gmGet("tfs_focus_country", "");
        var plan = budgetPlan(stock, prices, budget, focus, getCapacity());
        plan.fetchedAt = Date.now();
        renderBudgetResults(panel, plan);
        done();
      })
      .catch(function () {
        summary.innerHTML =
          '<span class="tfs-sitem" style="color:#dc3545;">⚠️ Failed to fetch data.</span>';
        body.innerHTML = "";
        done();
      });
  }

  function renderBudgetResults(panel, plan) {
    var summary = panel.querySelector(".tfs-bsummary");
    var body = panel.querySelector(".tfs-btable");
    var pct = plan.totalCost > 0 ? (plan.totalProfit / plan.totalCost) * 100 : 0;
    summary.innerHTML =
      '<span class="tfs-sitem"><span class="tfs-slabel">Budget:</span> <span class="tfs-sval">' +
      fmtMoney(plan.budget) +
      "</span></span>" +
      '<span class="tfs-sitem"><span class="tfs-slabel">Cap:</span> <span class="tfs-sval">' +
      (plan.capacity ? plan.capacity : "∞") +
      "</span></span>" +
      '<span class="tfs-sitem"><span class="tfs-slabel">Spent:</span> <span class="tfs-sval">' +
      fmtMoney(plan.totalCost) +
      "</span></span>" +
      '<span class="tfs-sitem"><span class="tfs-slabel">Profit:</span> <span class="tfs-sval" style="color:' +
      (plan.totalProfit >= 0 ? "#51c97a" : "#d8736a") +
      '">' +
      fmtProfit(plan.totalProfit) +
      "</span></span>" +
      '<span class="tfs-sitem"><span class="tfs-slabel">ROI:</span> <span class="tfs-sval">' +
      pct.toFixed(1) +
      "%</span></span>" +
      '<span class="tfs-sitem"><span class="tfs-slabel">Leftover:</span> <span class="tfs-sval">' +
      fmtMoney(plan.remaining) +
      "</span></span>" +
      '<button class="tfs-btoggle" title="Show / hide item list">−</button>' +
      '<span class="tfs-sitem" style="margin-left:auto;color:#6f7681;font-size:10px;">' +
      (plan.fetchedAt
        ? "computed " + Math.max(0, Math.floor((Date.now() - plan.fetchedAt) / 1000)) + "s ago"
        : "") +
      "</span>";

    if (!plan.candidates.length) {
      body.innerHTML =
        '<div class="tfs-bempty">No profitable items in stock for this budget.</div>';
      return;
    }

    var html =
      '<div class="tfs-bhead-row">' +
      '<span class="b-name">Item</span>' +
      '<span class="b-flag" title="Country">🌍</span>' +
      '<span class="b-stock" title="Available">Stock</span>' +
      '<span class="b-restock" title="Restock">Restock</span>' +
      '<span class="b-qty" title="Buy">Buy</span>' +
      '<span class="b-cost" title="Cost each">Cost</span>' +
      '<span class="b-value" title="Sell each">Sell</span>' +
      '<span class="b-profit" title="Profit each">P/ea</span>' +
      '<span class="b-roi" title="Return on cost per item">ROI</span>' +
      '<span class="b-tprofit" title="Total profit">Total</span>' +
      "</div>";

    for (var i = 0; i < plan.candidates.length; i++) {
      var c = plan.candidates[i];
      var rowCls = c.avail <= 0 || c.buyQty <= 0 ? "tfs-brow out" : "tfs-brow";
      var buyTxt = c.buyQty > 0 ? "×" + c.buyQty : "—";
      var buyTitle =
        c.buyQty > 0
          ? c.buyQty + " × " + fmtMoney(c.cost) + " = " + fmtMoney(c.buyTotal)
          : c.reason || "";
      var roiTxt = c.roiPct != null ? c.roiPct.toFixed(1) + "%" : "—";
      html +=
        '<div class="' +
        rowCls +
        '">' +
        '<span class="b-name" title="' +
        escapeHtml(c.name) +
        '">' +
        tfsRowIcon(c.id) +
        escapeHtml(c.name) +
        "</span>" +
        '<span class="b-flag" title="' +
        escapeHtml(c.cname) +
        '">' +
        tfsFlag(c.code) +
        "</span>" +
        '<span class="b-stock">' +
        c.avail +
        "</span>" +
        '<span class="b-restock" title="' +
        escapeHtml(c.restockText) +
        '">' +
        budgetRestockShort(c) +
        "</span>" +
        '<span class="b-qty" title="' +
        escapeHtml(buyTitle) +
        '">' +
        buyTxt +
        "</span>" +
        '<span class="b-cost">' +
        fmtMoney(c.cost) +
        "</span>" +
        '<span class="b-value">' +
        fmtMoney(c.value) +
        "</span>" +
        '<span class="b-profit tfs-profit ' +
        (c.profit > 0 ? "pos" : "neg") +
        '">' +
        fmtProfit(c.profit) +
        "</span>" +
        '<span class="b-roi tfs-roi">' +
        roiTxt +
        "</span>" +
        '<span class="b-tprofit tfs-profit ' +
        (c.profitTotal >= 0 ? "pos" : "neg") +
        '">' +
        fmtProfit(c.profitTotal) +
        "</span>" +
        "</div>";
    }
    body.innerHTML = html;

    var toggle = summary.querySelector(".tfs-btoggle");
    if (toggle) {
      var hidden = false;
      toggle.addEventListener("click", function () {
        hidden = !hidden;
        body.style.display = hidden ? "none" : "";
        toggle.textContent = hidden ? "+" : "−";
        toggle.title = hidden ? "Show item list" : "Hide item list";
      });
    }
  }

  function main() {
    if (!IS_PDA && document.body) document.body.classList.add("tfs-desk");
    injectCss();
    injectSettingsBar(function (force) {
      applyAll(!!force);
    });
    applyAll(false);
    startObserver();
    document.addEventListener("click", tfsOnPageInteract, true);
    document.addEventListener("change", tfsOnPageInteract, true);
    manageAutoRefresh();
    window.addEventListener("resize", function () {
      var p = document.getElementById("tfs-travel");
      if (p) autoMatchTravelWidth(p);
      var b = document.getElementById("tfs-bar");
      if (b) autoMatchTravelWidth(b);
      var bp = document.getElementById("tfs-budget-panel");
      if (bp) autoMatchTravelWidth(bp);
    });
    try {
      if (typeof GM_registerMenuCommand === "function")
        GM_registerMenuCommand("Foreign Stock: refresh", function () {
          applyAll(true);
        });
    } catch (e) {}
  }

  if (
    typeof window !== "undefined" &&
    typeof location !== "undefined" &&
    ((/\/page\.php/.test(location.pathname) &&
      /sid=travel/.test(location.search + location.hash)) ||
      /\/travelagency\.php/.test(location.pathname))
  ) {
    main();
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      normalizeCountryName: normalizeCountryName,
      COUNTRY_MAP: COUNTRY_MAP,
      parseYataExport: parseYataExport,
      fmtMoney: fmtMoney,
      fmtProfit: fmtProfit,
      formatAge: formatAge,
      buildRows: buildRows,
      sortRows: sortRows,
      restockEta: restockEta,
      fmtDuration: fmtDuration,
      modelEstimate: modelEstimate,
      restockDisplay: restockDisplay,
      itemCategory: itemCategory,
      rowVisible: rowVisible,
      countryVisible: countryVisible,
      parseFlightMinutes: parseFlightMinutes,
      landVerdict: landVerdict,
      parseTravelState: parseTravelState,
      parseAriaTravel: parseAriaTravel,
      domTravelState: domTravelState,
      getTravelMethod: getTravelMethod,
      readFlightMinutes: readFlightMinutes,
      travelRowsHtml: travelRowsHtml,
      getFilters: getFilters,
      tfsStockFromRow: tfsStockFromRow,
      tfsCellLabel: tfsCellLabel,
      tfsStoreRowImgId: tfsStoreRowImgId,
      budgetPlan: budgetPlan,
      collectBudgetCandidates: collectBudgetCandidates,
    };
    module.exports.getStock = getStock;
    module.exports.getPrices = getPrices;
    module.exports.getModel = getModel;
    module.exports.getTravelState = getTravelState;
    module.exports.__setFetch = function (fn) {
      _fetchJson = fn;
    };
    module.exports.__setClock = function (fn) {
      _nowSec = fn;
    };
  }
})();
