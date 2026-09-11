// ==UserScript==
// @name         Spud Travel — Foreign Stock & Restock Advisor
// @namespace    spud.travel
// @version      0.6.20
// @description  Foreign stock table, profit/$hr per country, restock prediction + landing alarms. Free — YATA stock feed + Torn item prices. No subscription.
// @author       Potato-MM
// @match        https://www.torn.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @connect      yata.yt
// @connect      weav3r.dev
// @connect      api.torn.com
// @connect      mediabros.cc
// @run-at       document-idle
// @noframes
// @license      MIT
// @downloadURL https://update.greasyfork.org/scripts/588037/Spud%20Travel%20%E2%80%94%20Foreign%20Stock%20%20Restock%20Advisor.user.js
// @updateURL https://update.greasyfork.org/scripts/588037/Spud%20Travel%20%E2%80%94%20Foreign%20Stock%20%20Restock%20Advisor.meta.js
// ==/UserScript==

(function () {
    'use strict';

    // ── Config ────────────────────────────────────────────────
    const VERSION = '0.6.20';
    // Fixed faction backend for 24/7 restock history. Not user-configurable: a stale
    // value saved in GM storage would silently override the code default and break
    // predictions with no visible error.
    const BACKEND_URL = 'https://travel.mediabros.cc';
    const YATA_URL = 'https://yata.yt/api/v1/travel/export/';
    const WEAV3R_URL = 'https://www.weav3r.dev/travel-stock';

    // One-way STANDARD flight time in minutes (verified Torn values).
    const COUNTRIES = {
        mex: { name: 'Mexico',          short: 'MEX', min: 26,  dest: 'mexico' },
        cay: { name: 'Cayman Islands',  short: 'CAY', min: 35,  dest: 'cayman' },
        can: { name: 'Canada',          short: 'CAN', min: 41,  dest: 'canada' },
        haw: { name: 'Hawaii',          short: 'HAW', min: 134, dest: 'hawaii' },
        uni: { name: 'United Kingdom',  short: 'UK',  min: 159, dest: 'united' },
        arg: { name: 'Argentina',       short: 'ARG', min: 167, dest: 'argentina' },
        swi: { name: 'Switzerland',     short: 'SWI', min: 175, dest: 'switzerland' },
        jap: { name: 'Japan',           short: 'JAP', min: 225, dest: 'japan' },
        chi: { name: 'China',           short: 'CHI', min: 242, dest: 'china' },
        uae: { name: 'UAE',             short: 'UAE', min: 271, dest: 'uae' },
        sou: { name: 'South Africa',    short: 'SA',  min: 297, dest: 'south' },
    };

    // Travel-method time multipliers applied to the one-way STANDARD minutes.
    // Seeded from Torn mechanics + torntravel-observed airstrip ratio (~0.66-0.70).
    // Editable in Settings; verify against your own account.
    const METHODS = {
        standard: { label: 'Standard',       mult: 1.00 },
        airstrip: { label: 'Airstrip',       mult: 0.70 },
        private:  { label: 'Private Island', mult: 0.60 },
            business: { label: 'Business Class', mult: 0.30 },
    };
    const WLT_BOOK_MULT = 0.75; // "Mailing yourself abroad" book: -25%, stacks.

    const MARKET_TAX = 0.05;    // 5% item-market sell tax.
    const DEFAULT_CAPACITY = 5; // base carry; +perks/suitcase in Settings.

    // Item types we care about for travel trading (from Torn item categories).
    const TRADE_TYPES = ['Plushie', 'Flower', 'Drug', 'Temporary', 'Special', 'Clothing', 'Jewelry', 'Other'];

    const SETTINGS_KEY = 'spudTravelSettings';
    const HISTORY_KEY = 'spudTravelHistory';   // restock time-series
    const PRICE_CACHE_KEY = 'spudTravelPrices'; // Torn item prices cache
    const ALARM_KEY = 'spudTravelAlarms';

    const DEFAULTS = {
        method: 'standard',
        wltBook: false,
        capacity: DEFAULT_CAPACITY,
        companySpecial: 'none',     // none | flowers | plushies (+5 of that type)
applyTax: true,
minStock: 0,
hiddenCountries: [],        // country codes to exclude
hiddenTypes: [],            // item types to exclude
watchItems: [],             // item ids always shown (bypass type filter), e.g. Xanax
 watchedOnly: false,         // show only watched items
 respectCooldown: false,     // only trips whose round-trip fits within drug cooldown
 search: '',
 predSearch: '',             // Predictions tab: search item/location
 sortKey: 'perhr',           // perhr | profit | stock | name
 sortDir: 'desc',
 methodMults: {},            // user overrides for METHODS mults
 // Backend is fixed (see BACKEND_URL) — not user-configurable.
 useYata: true,              // stock source: YATA export
 useWeav3r: true,            // stock source: TornW3B (carries market price + type)
    };

    // ── Storage helpers (GM — sandboxed) ──────────────────────
    function saveKey(k) { GM_setValue('apiKey', k); }
    function loadKey() { return GM_getValue('apiKey', ''); }
    function clearKey() { GM_deleteValue('apiKey'); }
    function maskKey(k) { return k && k.length > 4 ? '••••••' + k.slice(-4) : '(none)'; }

    function getSettings() {
        try { return { ...DEFAULTS, ...JSON.parse(GM_getValue(SETTINGS_KEY, '{}')) }; }
        catch { return { ...DEFAULTS }; }
    }
    function saveSettings(s) { GM_setValue(SETTINGS_KEY, JSON.stringify(s)); }

    // One-time cleanup: drop the old user-set backendUrl so it can't shadow BACKEND_URL.
    (function dropLegacyBackendUrl() {
        try {
            const cur = JSON.parse(GM_getValue(SETTINGS_KEY, '{}'));
            if ('backendUrl' in cur) { delete cur.backendUrl; GM_setValue(SETTINGS_KEY, JSON.stringify(cur)); }
        } catch { /* ignore */ }
    })();

    function getHistory() {
        try { return JSON.parse(GM_getValue(HISTORY_KEY, '{}')); } catch { return {}; }
    }
    function saveHistory(h) { GM_setValue(HISTORY_KEY, JSON.stringify(h)); }

    // ── Fetch helpers ─────────────────────────────────────────
    function httpGet(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url, timeout: 15000,
                onload: (res) => {
                    try { resolve(JSON.parse(res.responseText)); }
                    catch (e) { reject(new Error('bad JSON from ' + url)); }
                },
                onerror: () => reject(new Error('network error: ' + url)),
                              ontimeout: () => reject(new Error('timeout: ' + url)),
            });
        });
    }

    function httpGetText(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url, timeout: 20000,
                onload: (res) => resolve(res.responseText || ''),
                              onerror: () => reject(new Error('network error: ' + url)),
                              ontimeout: () => reject(new Error('timeout: ' + url)),
            });
        });
    }

    // Normalized feed shape: { code: { update, source, stocks:[{id,name,quantity,cost,marketPrice?,type?}] } }
    async function fetchYata() {
        const j = await httpGet(YATA_URL);
        if (!j || !j.stocks) throw new Error('YATA returned no stocks');
        const out = {};
        for (const [code, c] of Object.entries(j.stocks)) {
            out[code] = { update: c.update, source: 'yata', stocks: c.stocks };
        }
        return out;
    }

    // TornW3B embeds its stock table as JSON in the page's server-rendered HTML.
    async function fetchWeav3r() {
        const html = await httpGetText(WEAV3R_URL);
        const countries = extractWeav3rCountries(html);
        if (!countries) throw new Error('weav3r: could not parse stock');
        const out = {};
        for (const c of countries) {
            if (!COUNTRIES[c.countryCode]) continue;
            out[c.countryCode] = {
                update: c.yataUpdatedAt || 0,
 source: 'weav3r' + (c.source ? ':' + c.source : ''),
 stocks: (c.rows || []).map(r => ({
     id: r.itemId, name: r.name, quantity: r.quantity, cost: r.cost,
     marketPrice: r.marketPrice, type: r.type,
 })),
            };
        }
        return out;
    }

    // Extract initialData.countries[] from the RSC-embedded payload (balanced-bracket scan).
    function extractWeav3rCountries(html) {
        const u = html.replace(/\\"/g, '"').replace(/\\n/g, ' ').replace(/\\\\/g, '\\');
        const key = '"countries":[';
        const start = u.indexOf(key);
        if (start < 0) return null;
        let i = start + key.length - 1, depth = 0, inStr = false, esc = false;
        for (; i < u.length; i++) {
            const ch = u[i];
            if (esc) { esc = false; continue; }
            if (ch === '\\') { esc = true; continue; }
            if (ch === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (ch === '[') depth++;
            else if (ch === ']') { depth--; if (depth === 0) { i++; break; } }
        }
        try { return JSON.parse(u.slice(start + key.length - 1, i)); }
        catch { return null; }
    }

    // Merge feeds per country, taking whichever source reported most recently.
    function mergeFeeds(feeds) {
        const out = {};
        for (const code of Object.keys(COUNTRIES)) {
            let best = null;
            for (const f of feeds) {
                if (f && f[code] && (!best || (f[code].update || 0) > (best.update || 0))) best = f[code];
            }
            if (best) out[code] = best;
        }
        return out;
    }

    // Torn item prices + types in ONE call: torn/?selections=items → market_value + type.
    async function fetchPrices(key) {
        if (!key) return null;
        const cached = readPriceCache();
        if (cached) return cached;
        const j = await httpGet('https://api.torn.com/torn/?selections=items&key=' + encodeURIComponent(key));
        if (j && j.error) throw new Error('Torn API: ' + j.error.error);
        if (!j || !j.items) throw new Error('Torn API returned no items');
        const map = {};
        for (const [id, it] of Object.entries(j.items)) {
            map[id] = { price: it.market_value || 0, type: it.type || 'Other', name: it.name };
        }
        GM_setValue(PRICE_CACHE_KEY, JSON.stringify({ ts: Date.now(), map }));
        return map;
    }
    function readPriceCache() {
        try {
            const c = JSON.parse(GM_getValue(PRICE_CACHE_KEY, '{}'));
            if (c.ts && Date.now() - c.ts < 30 * 60 * 1000) return c.map; // 30 min TTL
        } catch {}
        return null;
    }

    // Your drug/medical/booster cooldowns (seconds remaining at fetch time).
    async function fetchCooldowns(key) {
        if (!key) return null;
        const j = await httpGet('https://api.torn.com/user/?selections=cooldowns&key=' + encodeURIComponent(key));
        if (j && j.error) throw new Error(j.error.error);
        if (!j || !j.cooldowns) return null;
        return { drug: j.cooldowns.drug || 0, medical: j.cooldowns.medical || 0, booster: j.cooldowns.booster || 0, at: Math.floor(Date.now() / 1000) };
    }
    // Live remaining seconds for a cooldown kind, or null if unknown.
    function cdRemaining(kind) {
        if (!state.cooldowns) return null;
        const elapsed = Math.floor(Date.now() / 1000) - state.cooldowns.at;
        return Math.max(0, (state.cooldowns[kind] || 0) - elapsed);
    }

    // Optional travel-logger worker: 24/7 restock predictions.
    async function fetchBackend(url) {
        if (!url) return null;
        const j = await httpGet(url.replace(/\/$/, '') + '/predictions');
        return j && j.items ? j.items : null; // { "code:id": {cycles,intervalMin,next,...} }
    }

    // ── Time / money format ───────────────────────────────────
    function fmtMoney(n) {
        const a = Math.abs(n), s = n < 0 ? '-$' : '$';
        if (a >= 1e9) return s + (a / 1e9).toFixed(1) + 'B';
        if (a >= 1e6) return s + (a / 1e6).toFixed(1) + 'M';
        if (a >= 1e3) return s + (a / 1e3).toFixed(1) + 'K';
        return s + Math.round(a);
    }
    function fmtHrs(min) {
        const h = Math.floor(min / 60), m = Math.round(min % 60);
        return h > 0 ? `${h}h ${m}m` : `${m}m`;
    }
    function fmtClock(sec) {
        if (sec == null) return '—';
        if (sec <= 0) return 'now';
        const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
        if (h > 0) return `${h}h ${m}m`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    }

    // ── Travel-time engine ────────────────────────────────────
    function oneWayMinutes(code, s) {
        const base = COUNTRIES[code].min;
        const mult = (s.methodMults && s.methodMults[s.method] != null)
        ? s.methodMults[s.method] : METHODS[s.method].mult;
        let m = base * mult;
        if (s.wltBook) m *= WLT_BOOK_MULT;
        return Math.round(m);
    }
    function roundTripMinutes(code, s) { return oneWayMinutes(code, s) * 2; }

    // ── Deal computation ──────────────────────────────────────
    // Returns [{code, country, id, name, type, stock, cost, sell, profitItem, profitTrip, perHr, oneWay, updatedAgo}]
    function computeDeals(stocks, prices, s) {
        const deals = [];
        const now = Math.floor(Date.now() / 1000);
        for (const [code, c] of Object.entries(stocks)) {
            const rt = roundTripMinutes(code, s) / 60; // hours
            const ow = oneWayMinutes(code, s);
            const updatedAgo = now - (c.update || now);
            for (const it of c.stocks) {
                const p = prices ? prices[it.id] : null;
                // Prefer weav3r's embedded market price + type; fall back to Torn API.
                const type = it.type || (p ? p.type : 'Other');
                const sell = (it.marketPrice != null && it.marketPrice > 0) ? it.marketPrice : (p ? p.price : 0);
                const taxed = s.applyTax ? sell * (1 - MARKET_TAX) : sell;
                const profitItem = taxed - it.cost;
                // capacity + company special bonus (+5 for matching type)
                let cap = s.capacity;
                if (s.companySpecial === 'flowers' && type === 'Flower') cap += 5;
                if (s.companySpecial === 'plushies' && type === 'Plushie') cap += 5;
                // Depletion-aware allocation: you can only carry what will still
                // be on the shelf when you LAND. Capacity, current stock and the
                // learned depletion estimate each bound the real buy; without a
                // depletion rate the stock itself is the only honest bound.
                const ls = landingStock(code, it.id, it.quantity, s);
                const buy = Math.max(0, Math.min(
                    cap, it.quantity,
                    ls.qtyAtLanding != null ? ls.qtyAtLanding : it.quantity));
                const profitTrip = profitItem * buy;
                const perHr = rt > 0 ? profitTrip / rt : 0;
                deals.push({
                    code, country: COUNTRIES[code].name, id: it.id, name: it.name, type,
                    stock: it.quantity, cost: it.cost, sell, profitItem, profitTrip, perHr,
                    oneWay: ow, updatedAgo,
                    buy,                              // units actually allocated this trip
                    rate: ls.rate,                    // learned depletion (units/min) or null
                    cap,                              // carry limit (settings + company bonus)
                    tripCost: it.cost * buy,          // cash needed up front
                    roi: it.cost > 0 ? profitItem / it.cost : 0,
                });
            }
        }
        return deals;
    }

    function filterSort(deals, s) {
        const watch = s.watchItems || [];
        const q = (s.search || '').toLowerCase();
        let out = deals.filter(d => {
            const watched = watch.includes(d.id);
            if (s.watchedOnly && !watched) return false;
            if (s.hiddenCountries.includes(d.code)) return false;
            // Watched items bypass the type filter (e.g. keep Xanax even when Drugs are hidden).
            if (!watched && s.hiddenTypes.includes(d.type)) return false;
            if (s.minStock > 0 && d.stock < s.minStock) return false;
            if (s.respectCooldown) {
                const dr = cdRemaining('drug');
                if (dr != null && dr > 0 && d.oneWay * 120 > dr) return false; // round-trip (sec) must fit in drug CD
            }
            if (q && !(d.name.toLowerCase().includes(q) || d.country.toLowerCase().includes(q))) return false;
            return true;
        });
        const key = s.sortKey, dir = s.sortDir === 'asc' ? 1 : -1;
        const val = (d) => key === 'name' ? d.name : (key === 'stock' ? d.stock : (key === 'profit' ? d.profitTrip : d.perHr));
        out = [...out].sort((a, b) => {
            const av = val(a), bv = val(b);
            if (typeof av === 'string') return av.localeCompare(bv) * dir;
            return (av - bv) * dir;
        });
        return out;
    }

    // exported to window for the Node test harness (stripped in-browser is fine)
    const ENGINE = { computeDeals, filterSort, oneWayMinutes, roundTripMinutes, leaveByTs, leaveInfo, landingStock, depletionRate, planDay, ltct, COUNTRIES, METHODS };
    if (typeof module !== 'undefined' && module.exports) { module.exports = ENGINE; }

    // ── Restock history + prediction ──────────────────────────
    // History shape: { "code:id": { name, samples:[[t,q],...], restocks:[t,...] } }
    const MAX_SAMPLES = 240;   // ~4h at 60s cadence
    const MAX_RESTOCKS = 40;

    function recordSnapshot(stocks) {
        const h = getHistory();
        const now = Math.floor(Date.now() / 1000);
        for (const [code, c] of Object.entries(stocks)) {
            for (const it of c.stocks) {
                const k = code + ':' + it.id;
                let e = h[k];
                if (!e) e = h[k] = { name: it.name, samples: [], restocks: [] };
                const prev = e.samples.length ? e.samples[e.samples.length - 1] : null;
                // Only push when quantity changes or every few minutes, to keep it compact.
                if (!prev || prev[1] !== it.quantity || now - prev[0] > 300) {
                    e.samples.push([now, it.quantity]);
                    // Restock event: previous was 0 (or missing) and now > 0.
                    if (prev && prev[1] === 0 && it.quantity > 0) {
                        e.restocks.push(now);
                        if (e.restocks.length > MAX_RESTOCKS) e.restocks.shift();
                    }
                    if (e.samples.length > MAX_SAMPLES) e.samples.shift();
                }
            }
        }
        saveHistory(h);
    }

    // Predict next restock. Prefers the backend logger when it has seen at least
    // as many cycles as the local browser history; otherwise uses local history.
    function predictRestock(code, id) {
        const local = predictLocal(code, id);
        const r = state.remote && state.remote[code + ':' + id];
        if (r && r.next && (r.cycles || 0) >= local.samples) {
            return { next: r.next, intervalMin: r.intervalMin, samples: r.cycles || 0, remote: true };
        }
        return local;
    }

    // Local prediction from browser-accumulated history.
    function predictLocal(code, id) {
        const h = getHistory();
        const e = h[code + ':' + id];
        if (!e || e.restocks.length < 2) return { next: null, intervalMin: null, samples: e ? e.restocks.length : 0 };
        const rs = e.restocks;
        const gaps = [];
        for (let i = 1; i < rs.length; i++) gaps.push(rs[i] - rs[i - 1]);
        // recent-weighted median: weight later gaps more (14-day-ish half life idea, simplified)
        gaps.sort((a, b) => a - b);
        const med = gaps[Math.floor(gaps.length / 2)];
        const last = rs[rs.length - 1];
        let next = last + med;
        const now = Math.floor(Date.now() / 1000);
        while (next < now) next += med; // roll forward to the upcoming cycle
        return { next, intervalMin: Math.round(med / 60), samples: rs.length };
    }

    // When to DEPART so you LAND exactly as the item restocks (same math as the
    // alarm notifications in checkAlarms). Null when there is no prediction.
    function leaveByTs(code, id, s) {
        const pred = predictRestock(code, id);
        if (!pred || !pred.next) return null;
        return { leaveBy: pred.next - oneWayMinutes(code, s) * 60, next: pred.next, remote: pred.remote };
    }

    // Learned depletion rate (units/min): median of observed stock declines,
    // buffered 15% so we err toward "sells out sooner".
    function depletionRate(code, id) {
        const e = getHistory()[code + ':' + id];
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
        return rates[Math.floor(rates.length / 2)] * 1.15;
    }

    // Will `qty` units still be on the shelf when you land (one-way flight)?
    function landingStock(code, id, qty, s) {
        const rate = depletionRate(code, id);
        if (!(qty > 0)) return { stocked: false, rate, minsLeft: 0 };
        if (!rate) return { stocked: true, rate: null, minsLeft: null };
        const left = qty - rate * oneWayMinutes(code, s);
        return { stocked: left > 0, rate, minsLeft: qty / rate, qtyAtLanding: Math.max(0, Math.floor(left)) };
    }

    // Unified "when to leave" for a deal: restock predictions for OOS items AND
    // depletion for in-stock ones (leave now only helps if it survives the flight).
    function leaveInfo(d, s) {
        const now = Date.now() / 1000;
        const owSec = oneWayMinutes(d.code, s) * 60;
        if (d.stock > 0) {
            const ls = landingStock(d.code, d.id, d.stock, s);
            if (ls.stocked) return { kind: 'now', minsLeft: ls.minsLeft, rate: ls.rate };
            // Gone before landing: latest departure that still lands before sell-out.
            const leaveBy = now + (d.stock / ls.rate) * 60 - owSec; // mins -> sec
            if (leaveBy > now - 300) return { kind: 'deadline', leaveBy, minsLeft: ls.minsLeft };
            return { kind: 'gone', minsLeft: ls.minsLeft };
        }
        const lb = leaveByTs(d.code, d.id, s);
        if (!lb || lb.leaveBy < now - 300) return null;
        return { kind: 'restock', leaveBy: lb.leaveBy, next: lb.next, remote: lb.remote };
    }

    // ── Day planner (greedy) ──────────────────────────────────
    // Given ranked deals + a time budget (minutes), build a sequential trip list
    // maximizing total profit. Simple greedy: repeatedly take the best $/hr deal
    // that still fits the remaining time. Respects per-trip capacity already in deal.
    // Greedy by $/hr, but now schedules real legs: each trip gets a departure and
    // landing time, plus `transferMin` on the ground between trips. Trips whose
    // up-front cash exceeds maxCash are skipped.
    function planDay(deals, s, budgetMin, opts = {}) {
        const transferMin = Math.max(0, opts.transferMin || 0);
        const maxCash = opts.maxCash > 0 ? opts.maxCash : Infinity;
        const startTs = opts.startTs || Math.floor(Date.now() / 1000);

        const sorted = [...deals]
        .filter(d => d.profitItem > 0 && d.buy > 0 && d.tripCost <= maxCash)
        .sort((a, b) => b.perHr - a.perHr);

        const plan = [];
        let used = 0, total = 0, cashNeeded = 0, cursor = startTs;
        for (const d of sorted) {
            const rt = d.oneWay * 2;
            const cost = used === 0 ? rt : rt + transferMin;   // no buffer before the first leg
            if (used + cost > budgetMin) continue;

            const depart = cursor + (used === 0 ? 0 : transferMin * 60);
            const land = depart + rt * 60;
            // Depletion-aware allocation per trip: the shelf keeps draining at the
            // learned rate from NOW (d.stock is a snapshot of the current shelf)
            // until THIS trip lands abroad — that is where you buy, not the return
            // landing. Later trips in the plan therefore see a more drained shelf.
            // Without a learned rate the current stock is the bound — never the
            // full capacity.
            const arrive = depart + d.oneWay * 60;
            const nowSec = Math.floor(Date.now() / 1000);
            const avail = d.rate != null
                ? d.stock - d.rate * Math.max(0, (arrive - nowSec) / 60)
                : d.stock;
            const q = Math.max(0, Math.min(d.cap, Math.floor(avail)));
            const profitTrip = d.profitItem * q;
            const tripCost = d.cost * q;
            if (profitTrip <= 0 || tripCost > maxCash) continue;
            plan.push({ ...d, buy: q, profitTrip, tripCost, depart, land,
                        arriveAbroad: depart + d.oneWay * 60 });

            used += cost;
            total += profitTrip;
            cashNeeded = Math.max(cashNeeded, tripCost);        // trips are sequential: peak, not sum
            cursor = land;
            if (plan.length >= 20) break;
        }
        const hrs = used / 60;
        return {
            plan, usedMin: used, totalProfit: total, cashNeeded,
            perHr: hrs > 0 ? total / hrs : 0,
            endTs: cursor,
        };
    }

    // User's local wall-clock time (DST-safe).
    function ltct(ts) {
        const d = new Date(ts * 1000);
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }

    // Torn City Time is UTC.
    function tct(ts) {
        const d = new Date(ts * 1000);
        return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
    }

    // ── Alarms ────────────────────────────────────────────────
    function getAlarms() { try { return JSON.parse(GM_getValue(ALARM_KEY, '[]')); } catch { return []; } }
    function saveAlarms(a) { GM_setValue(ALARM_KEY, JSON.stringify(a)); }

    // Check alarms each tick; fire departure (~10m before) + landing notifications.
    function checkAlarms(s) {
        const alarms = getAlarms();
        if (!alarms.length) return;
        const now = Math.floor(Date.now() / 1000);
        let changed = false;
        for (const al of alarms) {
            const lb = leaveByTs(al.code, al.id, s);
            if (!lb) continue;
            const pred = { next: lb.next };
            const departAt = lb.leaveBy;                     // depart so you LAND at restock
            const preAt = departAt - 10 * 60;                // 10 min heads-up
            // Persist the fired flag BEFORE notifying. notify() can block (PDA's
            // confirm shim) or the page can reload mid-alert, and an unsaved flag
            // means the same alarm fires again on every tick and every page load.
            if (!al.firedPre && now >= preAt && now < departAt) {
                al.firedPre = true; saveAlarms(alarms);
                notify('Fly soon: ' + al.name, `Depart ${COUNTRIES[al.code].name} run in ~10 min to land at restock.`);
            }
            if (!al.firedDepart && now >= departAt && now < pred.next) {
                al.firedDepart = true; saveAlarms(alarms);
                notify('Take off NOW: ' + al.name, `Leave for ${COUNTRIES[al.code].name} now to land as ${al.name} restocks.`);
            }
            // reset for next cycle once restock has passed
            if (now > pred.next + 60 && (al.firedPre || al.firedDepart)) {
                al.firedPre = false; al.firedDepart = false; changed = true;
            }
        }
        if (changed) saveAlarms(alarms);
    }

    // Torn PDA exposes PDA_httpGet/PDA_httpPost. Its GM_notification shim is a
    // blocking confirm() dialog, which is unusable for repeating alarms — show a
    // self-dismissing banner there instead.
    const IS_PDA = typeof window.PDA_httpGet === 'function' || typeof window.PDA_httpPost === 'function';

    function banner(title, body) {
        let el = document.getElementById('spudTravelToast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'spudTravelToast';
            el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:8px;z-index:2147483600;' +
            'max-width:92vw;background:#1f6feb;color:#fff;padding:10px 14px;border-radius:8px;' +
            'font:13px/1.35 -apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.5);cursor:pointer';
            el.onclick = () => el.remove();
            document.body.appendChild(el);
        }
        el.innerHTML = `<b>${title}</b><br>${body}<div style="font-size:10px;opacity:.8;margin-top:4px">tap to dismiss</div>`;
        clearTimeout(el._t);
        el._t = setTimeout(() => el.remove(), 20000);
    }

    function notify(title, body) {
        if (IS_PDA) return banner(title, body);
        try {
            GM_notification({ title, text: body, timeout: 15000 });
        } catch {
            if (window.Notification && Notification.permission === 'granted') new Notification(title, { body });
        }
    }

    // ── UI state ──────────────────────────────────────────────
    let state = { stocks: null, prices: null, deals: [], lastFetch: 0, err: '', loading: false, remote: null, cooldowns: null };
    let activeTab = 'deals';
    let panelEl = null;

    // ── Styles ────────────────────────────────────────────────
    const CSS = `
    #spudTravelBtn{position:fixed;right:16px;bottom:110px;z-index:2147483000;width:46px;height:46px;border-radius:50%;
    background:#1f6feb;color:#fff;border:none;font-size:20px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.4)}
    #spudTravelPanel{position:fixed;right:16px;bottom:165px;z-index:2147483000;width:640px;max-width:95vw;max-height:82vh;
    background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:10px;display:none;flex-direction:column;
    font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.6);overflow:hidden}
    #spudTravelPanel.open{display:flex}
    .st-hd{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#161b22;border-bottom:1px solid #30363d}
    .st-hd b{font-size:14px}
    .st-hd{cursor:pointer;user-select:none}
    #st-caret{font-size:11px;color:#8b949e;transition:transform .15s}
    /* Collapsed: header only. Handy while flying back — nothing to act on. */
    #spudTravelPanel.collapsed .st-tabs,#spudTravelPanel.collapsed .st-body{display:none}
    #spudTravelPanel.collapsed #st-caret{display:inline-block;transform:rotate(-90deg)}
    #spudTravelPanel.collapsed{max-height:none}
    .st-hd .st-meta{margin-left:auto;font-size:11px;color:#8b949e}
    .st-tabs{display:flex;border-bottom:1px solid #30363d;background:#161b22}
    .st-tabs button{flex:1;background:none;border:none;color:#8b949e;padding:8px;cursor:pointer;font-size:12px}
    .st-tabs button.on{color:#fff;border-bottom:2px solid #1f6feb}
    .st-body{padding:10px 12px;overflow:auto}
    .st-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
    .st-row label{font-size:11px;color:#8b949e}
    .st-row input,.st-row select{background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:5px;padding:4px 6px}
    .st-chip{display:inline-flex;align-items:center;gap:4px;background:#21262d;border:1px solid #30363d;border-radius:12px;
        padding:2px 8px;font-size:11px;cursor:pointer;user-select:none;color:#e6edf3}
        .st-chip.off{opacity:.4;text-decoration:line-through}
        .st-chip.sel{background:#1f6feb;border-color:#1f6feb;color:#fff}
        .st-flabel{font-size:10px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin-right:2px;align-self:center}
        table.st-tbl{width:100%;border-collapse:collapse;font-size:12px}
        table.st-tbl th{text-align:right;padding:5px 6px;border-bottom:1px solid #30363d;color:#c9d1d9 !important;cursor:pointer;position:sticky;top:0;background:#0d1117}
        table.st-tbl th:nth-child(1),table.st-tbl th:nth-child(2){text-align:left}
        table.st-tbl td{text-align:right;padding:5px 6px;border-bottom:1px solid #21262d;color:#e6edf3 !important}
        table.st-tbl td:nth-child(1),table.st-tbl td:nth-child(2){text-align:left}
        #spudTravelPanel a{color:#58a6ff !important;text-decoration:none}
        #spudTravelPanel .st-mut{color:#9aa4af !important}
        .st-pos{color:#3fb950 !important}.st-neg{color:#f85149 !important}
        .st-bell,.st-star{cursor:pointer;opacity:.35}.st-bell.on,.st-star.on{opacity:1}
        .st-star.on{color:#e3b341}
        .st-btn{background:#238636;color:#fff;border:none;border-radius:5px;padding:5px 10px;cursor:pointer}
        .st-btn.sec{background:#21262d;border:1px solid #30363d}
        .st-stale{color:#d29922}
        .st-bwrap{margin:0 0 6px;border:1px solid #30363d;border-radius:6px;padding:4px 8px}
        .st-brow{display:flex;gap:8px;align-items:baseline;font-size:12px;padding:2px 0;min-width:0}
        .st-brow.pin .st-bitem,.st-brow.pin .st-btime{color:#e3b341 !important}
        .st-btime{font-weight:600;min-width:40px}
        .st-bland{color:#9aa4af !important;font-size:10px;min-width:96px}
        .st-bitem{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .st-sm{display:none}
        /* Baked into the travel page (desktop) — inline, full width, no floating overlay */
        #spudTravelPanel.embedded{position:static;right:auto;bottom:auto;width:auto;max-width:100%;max-height:none;margin:0 0 12px 0}
        /* Compact layout for TornPDA / narrow screens */
        @media (max-width:520px){
            #spudTravelPanel{width:96vw;font:12px/1.35 -apple-system,Segoe UI,Roboto,sans-serif;bottom:78px;right:2vw;max-height:45vh}
            /* Embedded mode drops the height cap on desktop; on a phone that means the
             *       panel grows to full content height, so cap it here and scroll inside. */
            #spudTravelPanel.embedded{width:auto;max-height:45vh;overflow:hidden}
            .st-body{flex:1 1 auto;min-height:0;overflow:auto;-webkit-overflow-scrolling:touch}
            .st-hd{padding:8px 10px}.st-hd b{font-size:13px}
            .st-body{padding:8px 10px}
            .st-tabs button{padding:7px 4px;font-size:11px}
            .st-chip{padding:2px 6px;font-size:10px}
            .st-row input,.st-row select{padding:3px 5px;font-size:12px}
            table.st-tbl{font-size:11px;min-width:0;width:100%}
            table.st-tbl th,table.st-tbl td{padding:4px 3px}
            /* Loc (1), Buy (4) and Restock (7) move into the Item cell — no sideways drag */
            table.st-tbl th:nth-child(1),table.st-tbl td:nth-child(1),
 table.st-tbl th:nth-child(4),table.st-tbl td:nth-child(4),
 table.st-tbl th:nth-child(7),table.st-tbl td:nth-child(7){display:none}
 .st-sm{display:block;font-size:10px;color:#8b949e;white-space:nowrap}
 /* Filter chips scroll sideways instead of wrapping into 3-4 rows */
 .st-row:has(.st-chip){flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;gap:3px;margin:2px 0}
 .st-row:has(.st-chip)::-webkit-scrollbar{display:none}
 .st-row{margin:2px 0;gap:4px}
 .st-status{margin:0 0 2px 0;font-size:10px;line-height:1.25}
 .st-flabel{flex:0 0 auto}
 #spudTravelBtn{width:40px;height:40px;font-size:17px;bottom:78px;right:12px}
        }
        `;

        // ── Rendering ─────────────────────────────────────────────
        function fmtAgo(sec) {
            if (sec < 60) return sec + 's';
            if (sec < 3600) return Math.floor(sec / 60) + 'm';
            return Math.floor(sec / 3600) + 'h';
        }

        function cdLine() {
            if (!state.cooldowns) return '';
            const cf = (s) => s > 0 ? fmtClock(s) : 'ready';
            return `<div class="st-mut" style="margin-bottom:6px">⏱ drug ${cf(cdRemaining('drug'))} · medical ${cf(cdRemaining('medical'))} · booster ${cf(cdRemaining('booster'))}</div>`;
        }

        // Same cooldown info folded into the status line — saves a row on narrow screens.
        function cdInline() {
            if (!state.cooldowns) return '';
            const cf = (s) => s > 0 ? fmtClock(s) : 'rdy';
            return ` · ⏱ ${cf(cdRemaining('drug'))}/${cf(cdRemaining('medical'))}/${cf(cdRemaining('booster'))}`;
        }

        function render() {
            if (!panelEl) return;
            const S = getSettings();
            const body = panelEl.querySelector('.st-body');
            const meta = panelEl.querySelector('.st-meta');
            meta.textContent = state.loading ? 'loading…'
            : state.err ? ('⚠ ' + state.err)
            : state.lastFetch ? ('updated ' + fmtAgo(Math.floor((Date.now() - state.lastFetch) / 1000)) + ' ago') : '';
            panelEl.querySelectorAll('.st-tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === activeTab));
            if (activeTab === 'deals') body.innerHTML = renderDeals(S);
            else if (activeTab === 'planner') body.innerHTML = renderPlanner(S);
            else if (activeTab === 'predict') body.innerHTML = renderPredict(S);
            else body.innerHTML = renderSettings(S);
            wire(body, S);
        }

        function renderDeals(S) {
            if (!state.stocks) return `<p class="st-mut">No data yet. ${loadKey() ? '' : 'Add your API key in Settings for sell prices. '}Click ↻ to load.</p>`;
            const allDeals = computeDeals(state.stocks, state.prices, S);
            const deals = filterSort(allDeals, S);
            const types = [...new Set(allDeals.map(d => d.type))].sort();
            const watch = S.watchItems || [];
            const arrow = (k) => S.sortKey === k ? (S.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
            const alarms = getAlarms();
            const rows = deals.slice(0, 300).map(d => {
                const pred = predictRestock(d.code, d.id);
                const lb = d.stock > 0 ? null : leaveByTs(d.code, d.id, S);
                const eta = pred.next ? fmtClock(pred.next - Date.now() / 1000) : (d.stock > 0 ? 'in stock' : '—');
                const li = leaveInfo(d, S);
                let leaveTxt = '—', leaveCls = 'st-mut', leaveTitle = 'No departure info (no stock, no restock prediction)';
                if (li && li.kind === 'now') {
                    leaveTxt = 'now' + (li.minsLeft != null ? ' · ~' + Math.max(1, Math.round(li.minsLeft)) + 'm left' : '');
                    leaveCls = 'st-pos';
                    leaveTitle = li.rate != null
                        ? 'In stock; learned depletion ~' + li.rate.toFixed(2) + '/min — still stocked when you land'
                        : 'In stock — leave now (no depletion data yet)';
                } else if (li && li.kind === 'deadline') {
                    leaveTxt = tct(li.leaveBy) + ' · ' + ltct(li.leaveBy);
                    leaveCls = '';
                    leaveTitle = 'Sells out in ~' + Math.max(1, Math.round(li.minsLeft)) + 'm — leave by this time (TCT · local) to land before it is gone';
                } else if (li && li.kind === 'restock') {
                    leaveTxt = tct(li.leaveBy) + ' · ' + ltct(li.leaveBy);
                    leaveCls = '';
                    leaveTitle = 'Depart ' + tct(li.leaveBy) + ' TCT (' + ltct(li.leaveBy) + ' your local time) to land as it restocks';
                } else if (li && li.kind === 'gone') {
                    leaveTxt = 'gone';
                    leaveCls = 'st-neg';
                    leaveTitle = 'Sells out in ~' + Math.max(1, Math.round(li.minsLeft)) + 'm — before you could land';
                }
                const on = alarms.some(a => a.code === d.code && a.id === d.id);
                const starred = watch.includes(d.id);
                return `<tr>
                <td title="${d.country}">${COUNTRIES[d.code].short}</td>
                <td><a href="/item.php?XID=${d.id}" target="_blank">${d.name}</a>
                <span class="st-mut" style="font-size:10px">${d.type}</span>
                <span class="st-sm">${COUNTRIES[d.code].short} · ${fmtMoney(d.cost)} · ⏱ ${eta}${leaveTxt !== '—' ? ' · ✈ ' + leaveTxt : ''}</span></td>
                <td class="${d.stock > 0 ? '' : 'st-mut'}">${d.stock}</td>
                <td>${d.buy} × ${fmtMoney(d.cost)}${d.rate != null && d.buy < Math.min(d.cap, d.stock) ? ' <span class="st-mut" title="Capped by learned depletion — the shelf will be this drained when you land">⇣</span>' : ''}</td>
                <td class="${d.profitItem >= 0 ? 'st-pos' : 'st-neg'}">${fmtMoney(d.profitTrip)}</td>
                <td class="${d.perHr >= 0 ? 'st-pos' : 'st-neg'}">${fmtMoney(d.perHr)}</td>
                <td class="${leaveCls}" title="${leaveTitle}">${leaveTxt}</td>
                <td><span class="st-star ${starred ? 'on' : ''}" data-watch="${d.id}" title="Watch this item (always shown)">★</span></td>
                <td><span class="st-bell ${on ? 'on' : ''}" data-alarm="${d.code}:${d.id}" title="Alarm on restock">🔔</span></td>
                </tr>`;
            }).join('');
            const srcCount = {};
            for (const [c, o] of Object.entries(state.stocks)) { if (S.hiddenCountries.includes(c)) continue; const src = (o.source || '?').split(':')[0]; srcCount[src] = (srcCount[src] || 0) + 1; }
            const srcNote = Object.entries(srcCount).map(([k, v]) => `${k} ×${v}`).join(' · ');
            const staleNote = anyStale(S) ? `<span class="st-stale">⚠ some feeds &gt;10m old</span>` : '';
            return `
            <div class="st-row">
            <input id="st-search" placeholder="Search item/country" value="${S.search || ''}" style="flex:1">
            <label>method</label>
            <select id="st-method">${Object.entries(METHODS).map(([k, v]) => `<option value="${k}" ${S.method === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
            <label>cap</label><input id="st-cap" type="number" min="1" style="width:52px" value="${S.capacity}">
            </div>
            <div class="st-row"><span class="st-flabel">country</span>
            <span class="st-chip ${S.hiddenCountries.length ? '' : 'sel'}" data-country-all="1" title="Check / uncheck all countries">all</span>
            ${Object.entries(COUNTRIES).map(([c, o]) => `<span class="st-chip ${S.hiddenCountries.includes(c) ? 'off' : ''}" data-country="${c}">${o.short}</span>`).join('')}</div>
            <div class="st-row"><span class="st-flabel">type</span>
            <span class="st-chip ${S.hiddenTypes.length ? '' : 'sel'}" data-type-all="1" title="Check / uncheck all types">all</span>
            ${types.map(t => `<span class="st-chip ${S.hiddenTypes.includes(t) ? 'off' : ''}" data-type="${t}">${t}</span>`).join('')}
            <span class="st-chip ${S.watchedOnly ? 'sel' : ''}" data-watchonly="1" title="Show only starred items">★ only</span>
            <span class="st-chip ${S.respectCooldown ? 'sel' : ''}" data-cooldown="1" title="Only trips whose round-trip fits within your drug cooldown">⏱ fit CD</span></div>
            <div class="st-mut st-status">${deals.length}/${allDeals.length} · ${METHODS[S.method].label}${S.wltBook ? ' +WLT' : ''} · cap ${S.capacity} · src: ${srcNote || '—'}${cdInline()} ${staleNote}</div>
            <table class="st-tbl"><thead><tr>
            <th data-sort="name">Loc</th><th data-sort="name">Item${arrow('name')}</th>
            <th data-sort="stock">Stock${arrow('stock')}</th><th>Buy</th>
            <th data-sort="profit">Profit/trip${arrow('profit')}</th><th data-sort="perhr">$/hr${arrow('perhr')}</th>
            <th>Leave by</th><th>★</th><th>🔔</th></tr></thead><tbody>${rows}</tbody></table>`;
        }

        function anyStale(S) {
            if (!state.stocks) return false;
            const now = Math.floor(Date.now() / 1000);
            return Object.entries(state.stocks).some(([c, o]) => !S.hiddenCountries.includes(c) && now - o.update > 600);
        }

        function renderPlanner(S) {
            if (!state.stocks) return `<p class="st-mut">Load data first (Deals tab ↻).</p>`;
            const deals = filterSort(computeDeals(state.stocks, state.prices, S), S);
            let budget = S._budget || 240;
            let cdCap = '';
            if (S.respectCooldown) {
                const dr = cdRemaining('drug');
                if (dr != null && dr > 0 && Math.floor(dr / 60) < budget) { budget = Math.floor(dr / 60); cdCap = ` (capped to drug CD ${fmtClock(dr)})`; }
            }
            const transferMin = S._transfer != null ? S._transfer : 0;
            const maxCash = S._maxCash || 0;
            const { plan, usedMin, totalProfit, cashNeeded, perHr, endTs } =
            planDay(deals, S, budget, { transferMin, maxCash });

            const rows = plan.map((d, i) => `<tr>
            <td>${i + 1}</td><td>${COUNTRIES[d.code].short}</td>
            <td>${d.name}<span class="st-sm">${tct(d.depart)} → ${tct(d.land)} TCT · ${fmtHrs(d.oneWay * 2)} · ${fmtMoney(d.tripCost)} in</span></td>
            <td>${fmtHrs(d.oneWay * 2)}</td>
            <td>${fmtMoney(d.tripCost)}</td>
            <td class="${d.roi >= 0 ? 'st-pos' : 'st-neg'}">${(d.roi * 100).toFixed(0)}%</td>
            <td class="st-pos">${fmtMoney(d.profitTrip)}</td><td class="st-pos">${fmtMoney(d.perHr)}</td></tr>`).join('');

            const watch = S.watchItems || [];
            const nowSec = Math.floor(Date.now() / 1000);
            const board = deals
            .filter(d => d.stock <= 0)
            .map(d => ({ ...d, lb: leaveByTs(d.code, d.id, S) }))
            .filter(d => d.lb && d.lb.leaveBy > nowSec - 300)
            .sort((a, b) => a.lb.leaveBy - b.lb.leaveBy);
            const pinned = board.filter(d => watch.includes(d.id)).slice(0, 3);
            const rest = board.filter(d => !watch.includes(d.id)).slice(0, Math.max(0, 5 - pinned.length));
            const boardRows = [...pinned, ...rest].map(d => `<div class="st-brow${watch.includes(d.id) ? ' pin' : ''}">
            <span class="st-btime">✈ ${tct(d.lb.leaveBy)}</span><span class="st-bland">lands ${tct(d.lb.next)} TCT</span>
            <span>${COUNTRIES[d.code].short}</span><span class="st-bitem">${d.name}${watch.includes(d.id) ? ' ★' : ''}</span></div>`).join('');
            const boardHtml = boardRows ? `<div class="st-bwrap">${boardRows}</div>
            <p class="st-mut" style="margin:2px 0 6px">Depart at ✈ (TCT) to land as that item restocks. ★ = watched item.</p>` : '';
            return `
            <div class="st-row">
            <input id="st-search" placeholder="Search item/country" value="${S.search || ''}" style="flex:1" title="Filters the departure board and the trip list below">
            </div>
            ${boardHtml}
            <div class="st-row" style="gap:10px;flex-wrap:wrap">
            <span><span class="st-flabel">profit</span> <b class="st-pos">${fmtMoney(totalProfit)}</b></span>
            <span><span class="st-flabel">profit/hr</span> <b class="st-pos">${fmtMoney(perHr)}</b></span>
            <span><span class="st-flabel">cash req</span> <b>${fmtMoney(cashNeeded)}</b></span>
            <span><span class="st-flabel">flights</span> <b>${plan.length}</b></span>
            <span class="st-mut">${fmtHrs(usedMin)} used${plan.length ? ' · ends ' + tct(endTs) + ' TCT' : ''}${cdCap}</span>
            </div>
            <div class="st-row">
            <label>time (min)</label><input id="st-budget" type="number" min="30" step="30" value="${budget}" style="width:64px" title="How many minutes you have for travelling. Flights + transfers are packed into this window, so 240 = plan the next 4 hours.">
            <label>transfer</label><input id="st-transfer" type="number" min="0" step="5" value="${transferMin}" style="width:52px" title="Minutes on the ground in Torn between trips">
            <label>max cash</label><input id="st-maxcash" type="number" min="0" step="100000" value="${maxCash}" style="width:96px" title="Skip trips needing more up-front cash than this (0 = no limit)">
            </div>
            <table class="st-tbl"><thead><tr><th>#</th><th>Loc</th><th>Item</th><th>Round trip</th><th>Cash</th><th>ROI</th><th>Profit/trip</th><th>$/hr</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="8" class="st-mut">No profitable trips fit the time window / cash limit.</td></tr>'}</tbody></table>
            <p class="st-mut" style="margin-top:8px">Greedy by $/hr, scheduled from now with ${transferMin}m transfers. Cash required is the
            biggest single trip, since trips are sequential. Real times shift with manual travel.</p>`;
        }

        function renderPredict(S) {
            const h = getHistory();
            const keys = new Set([...Object.keys(h), ...(state.remote ? Object.keys(state.remote) : [])]);
            const items = [...keys]
            .map(k => {
                const [code, id] = k.split(':');
                const e = h[k]; const r = state.remote ? state.remote[k] : null;
                return { code, id: +id, name: (e && e.name) || (r && r.name) || ('item ' + id), restocks: (e ? e.restocks.length : 0) };
            })
            .filter(x => COUNTRIES[x.code])
            .map(x => ({ ...x, pred: predictRestock(x.code, x.id), ow: oneWayMinutes(x.code, S) }))
            .sort((a, b) => (a.pred.next || 9e9) - (b.pred.next || 9e9));
            const alarms = getAlarms();
            if (!items.length) return `<p class="st-mut">No restock history yet. Keep a Torn tab open — the script logs the stock feed every minute and predictions appear after it sees a couple of restock cycles.</p>`;
            const q = (S.predSearch || '').toLowerCase();
            const shown = q
                ? items.filter(x =>
                    x.name.toLowerCase().includes(q) ||
                    COUNTRIES[x.code].name.toLowerCase().includes(q) ||
                    COUNTRIES[x.code].short.toLowerCase().includes(q))
                : items;
            const rows = shown.slice(0, 80).map(x => {
                const on = alarms.some(a => a.code === x.code && a.id === x.id);
                const eta = x.pred.next ? fmtClock(x.pred.next - Date.now() / 1000) : '—';
                const dep = x.pred.next ? x.pred.next - x.ow * 60 : null;
                const depUpcoming = dep != null && dep > Date.now() / 1000;
                const depCell = depUpcoming
                    ? `<span title="${tct(dep)} TCT — leave so you land as it restocks">${ltct(dep)}</span>`
                    : '<span class="st-mut" title="Next restock already passed — waiting for a fresh prediction">—</span>';
                return `<tr><td>${COUNTRIES[x.code].short}</td><td>${x.name}</td>
                <td class="${x.pred.next ? '' : 'st-mut'}" title="${x.pred.remote ? 'from backend' : 'local'}">${x.pred.remote ? '☁ ' : ''}${eta}</td>
                <td class="${depUpcoming ? '' : 'st-mut'}">${depCell}</td>
                <td class="st-mut">${x.pred.intervalMin ? x.pred.intervalMin + 'm' : '—'}</td>
                <td class="st-mut">${x.pred.samples}</td>
                <td><span class="st-bell ${on ? 'on' : ''}" data-alarm="${x.code}:${x.id}">🔔</span></td></tr>`;
            }).join('');
            return `<div class="st-row">
            <input id="st-pred-search" placeholder="Search item/location" value="${S.predSearch || ''}" style="flex:1">
            </div>
            <p class="st-mut" style="margin-bottom:6px">${shown.length}/${items.length} predicted · Predicted from observed restock cycles (median interval). More cycles → better accuracy.</p>
            <table class="st-tbl"><thead><tr><th>Loc</th><th>Item</th><th>Next restock</th><th>Depart (local)</th><th>Cycle</th><th>Seen</th><th>🔔</th></tr></thead>
            <tbody>${rows}</tbody></table>`;
        }

        function renderSettings(S) {
            const k = loadKey();
            return `
            <div class="st-row"><label>Torn API key (Public/Min access is enough)</label></div>
            <div class="st-row"><input id="st-key" placeholder="${maskKey(k)}" style="flex:1">
            <button class="st-btn" id="st-savekey">Save</button>
            <button class="st-btn sec" id="st-clearkey">Clear</button></div>
            <div class="st-row"><label>Travel method</label>
            <select id="st-method2">${Object.entries(METHODS).map(([kk, v]) => `<option value="${kk}" ${S.method === kk ? 'selected' : ''}>${v.label} (×${((S.methodMults && S.methodMults[kk]) ?? v.mult)})</option>`).join('')}</select>
            <label><input type="checkbox" id="st-wlt" ${S.wltBook ? 'checked' : ''}> WLT book (−25%)</label></div>
            <div class="st-row"><label>Capacity</label><input id="st-cap2" type="number" min="1" style="width:60px" value="${S.capacity}">
            <label>Company special</label>
            <select id="st-special"><option value="none" ${S.companySpecial === 'none' ? 'selected' : ''}>None</option>
            <option value="flowers" ${S.companySpecial === 'flowers' ? 'selected' : ''}>+5 flowers</option>
            <option value="plushies" ${S.companySpecial === 'plushies' ? 'selected' : ''}>+5 plushies</option></select></div>
            <div class="st-row"><label><input type="checkbox" id="st-tax" ${S.applyTax ? 'checked' : ''}> Apply 5% market tax</label>
            <label>Min stock</label><input id="st-minstock" type="number" min="0" style="width:70px" value="${S.minStock}"></div>
            <div class="st-row"><label>Stock sources (merged by freshness)</label>
            <label><input type="checkbox" id="st-src-yata" ${S.useYata ? 'checked' : ''}> YATA</label>
            <label><input type="checkbox" id="st-src-weav3r" ${S.useWeav3r ? 'checked' : ''}> TornW3B</label>
            <span class="st-mut">TornW3B carries market price + type; YATA is the fallback feed.</span></div>
            <div class="st-row"><label>Airstrip multiplier override</label>
            <input id="st-mult-air" type="number" step="0.01" min="0.1" max="1" style="width:70px" value="${(S.methodMults && S.methodMults.airstrip) ?? METHODS.airstrip.mult}">
            <span class="st-mut">torntravel observed ≈0.66; Torn wiki says 0.70</span></div>
            <div class="st-row"><span class="st-flabel">restock backend</span>
            <span class="st-mut">${state.remote ? Object.keys(state.remote).length + ' items from the shared restock server' : 'not connected — using locally learned history only'}</span></div>
            <p class="st-mut">v${VERSION} · stock: YATA + TornW3B · prices: Torn API · restock: shared server plus locally learned history.</p>`;
        }

        // ── Event wiring ──────────────────────────────────────────
        function wire(body, S) {
            const upd = (patch) => { saveSettings({ ...getSettings(), ...patch }); render(); };
            body.querySelectorAll('[data-sort]').forEach(th => th.onclick = () => {
                const k = th.dataset.sort; const cur = getSettings();
                upd({ sortKey: k, sortDir: cur.sortKey === k && cur.sortDir === 'desc' ? 'asc' : 'desc' });
            });
            body.querySelectorAll('[data-country]').forEach(ch => ch.onclick = () => {
                const c = ch.dataset.country; const cur = getSettings();
                const hc = cur.hiddenCountries.includes(c) ? cur.hiddenCountries.filter(x => x !== c) : [...cur.hiddenCountries, c];
                upd({ hiddenCountries: hc });
            });
            // "all" = check/uncheck-all toggle: if anything is hidden, show all; else hide all.
            body.querySelectorAll('[data-country-all]').forEach(ch => ch.onclick = () =>
            upd({ hiddenCountries: getSettings().hiddenCountries.length ? [] : Object.keys(COUNTRIES) }));
            body.querySelectorAll('[data-type-all]').forEach(ch => ch.onclick = () => {
                const cur = getSettings();
                const allTypes = [...new Set(computeDeals(state.stocks, state.prices, cur).map(d => d.type))];
                upd({ hiddenTypes: cur.hiddenTypes.length ? [] : allTypes });
            });
            body.querySelectorAll('[data-type]').forEach(ch => ch.onclick = () => {
                const t = ch.dataset.type; const cur = getSettings();
                const ht = cur.hiddenTypes.includes(t) ? cur.hiddenTypes.filter(x => x !== t) : [...cur.hiddenTypes, t];
                upd({ hiddenTypes: ht });
            });
            body.querySelectorAll('[data-watchonly]').forEach(ch => ch.onclick = () => upd({ watchedOnly: !getSettings().watchedOnly }));
            body.querySelectorAll('[data-cooldown]').forEach(ch => ch.onclick = () => upd({ respectCooldown: !getSettings().respectCooldown }));
            body.querySelectorAll('[data-watch]').forEach(b => b.onclick = () => {
                const id = +b.dataset.watch; const cur = getSettings();
                const w = cur.watchItems.includes(id) ? cur.watchItems.filter(x => x !== id) : [...cur.watchItems, id];
                upd({ watchItems: w });
            });
            body.querySelectorAll('[data-alarm]').forEach(b => b.onclick = () => toggleAlarm(b.dataset.alarm));
            const q = body.querySelector('#st-search'); if (q) q.oninput = () => { const cur = getSettings(); cur.search = q.value; saveSettings(cur); clearTimeout(wire._t); wire._t = setTimeout(render, 250); };
            const pq = body.querySelector('#st-pred-search'); if (pq) pq.oninput = () => { const cur = getSettings(); cur.predSearch = pq.value; saveSettings(cur); clearTimeout(wire._pt); wire._pt = setTimeout(render, 250); };
            const m = body.querySelector('#st-method'); if (m) m.onchange = () => upd({ method: m.value });
            const cap = body.querySelector('#st-cap'); if (cap) cap.onchange = () => upd({ capacity: Math.max(1, +cap.value || 5) });
            const bud = body.querySelector('#st-budget'); if (bud) bud.onchange = () => { const cur = getSettings(); cur._budget = Math.max(30, +bud.value || 240); saveSettings(cur); render(); };
            const tr = body.querySelector('#st-transfer'); if (tr) tr.onchange = () => { const cur = getSettings(); cur._transfer = Math.max(0, +tr.value || 0); saveSettings(cur); render(); };
            const mc = body.querySelector('#st-maxcash'); if (mc) mc.onchange = () => { const cur = getSettings(); cur._maxCash = Math.max(0, +mc.value || 0); saveSettings(cur); render(); };
            // settings tab
            const sk = body.querySelector('#st-savekey'); if (sk) sk.onclick = () => { const v = body.querySelector('#st-key').value.trim(); if (v) { saveKey(v); GM_deleteValue(PRICE_CACHE_KEY); refresh(); } };
            const ck = body.querySelector('#st-clearkey'); if (ck) ck.onclick = () => { clearKey(); render(); };
            const m2 = body.querySelector('#st-method2'); if (m2) m2.onchange = () => upd({ method: m2.value });
            const wlt = body.querySelector('#st-wlt'); if (wlt) wlt.onchange = () => upd({ wltBook: wlt.checked });
            const cap2 = body.querySelector('#st-cap2'); if (cap2) cap2.onchange = () => upd({ capacity: Math.max(1, +cap2.value || 5) });
            const sp = body.querySelector('#st-special'); if (sp) sp.onchange = () => upd({ companySpecial: sp.value });
            const tax = body.querySelector('#st-tax'); if (tax) tax.onchange = () => upd({ applyTax: tax.checked });
            const ms = body.querySelector('#st-minstock'); if (ms) ms.onchange = () => upd({ minStock: Math.max(0, +ms.value || 0) });
            const sy = body.querySelector('#st-src-yata'); if (sy) sy.onchange = () => { const c = getSettings(); if (!sy.checked && !c.useWeav3r) { sy.checked = true; return; } c.useYata = sy.checked; saveSettings(c); refresh(); };
            const sw = body.querySelector('#st-src-weav3r'); if (sw) sw.onchange = () => { const c = getSettings(); if (!sw.checked && !c.useYata) { sw.checked = true; return; } c.useWeav3r = sw.checked; saveSettings(c); refresh(); };
            const air = body.querySelector('#st-mult-air'); if (air) air.onchange = () => { const cur = getSettings(); cur.methodMults = { ...cur.methodMults, airstrip: +air.value }; saveSettings(cur); render(); };

        }

        function toggleAlarm(key) {
            const [code, id] = key.split(':');
            let alarms = getAlarms();
            const idx = alarms.findIndex(a => a.code === code && a.id === +id);
            if (idx >= 0) alarms.splice(idx, 1);
            else {
                const h = getHistory(); const e = h[key];
                alarms.push({ code, id: +id, name: e ? e.name : ('item ' + id), firedPre: false, firedDepart: false });
                if (window.Notification && Notification.permission === 'default') Notification.requestPermission();
            }
            saveAlarms(alarms); render();
        }

        // ── Data refresh ──────────────────────────────────────────
        async function refresh() {
            if (state.loading) return;
            state.loading = true; state.err = ''; render();
            const S = getSettings();
            try {
                const errs = [];
                const [yata, weav3r, prices, remote, cds] = await Promise.all([
                    S.useYata ? fetchYata().catch(e => { errs.push('YATA'); return null; }) : null,
                                                                              S.useWeav3r ? fetchWeav3r().catch(e => { errs.push('weav3r'); return null; }) : null,
                                                                              fetchPrices(loadKey()).catch(e => { state.err = e.message; return readPriceCache(); }),
                                                                              fetchBackend(BACKEND_URL).catch(() => null),
                                                                              fetchCooldowns(loadKey()).catch(() => null),
                ]);
                if (cds) state.cooldowns = cds;
                const merged = mergeFeeds([yata, weav3r]);
                if (!Object.keys(merged).length) throw new Error('no stock data (' + (errs.join(' + ') || 'no sources enabled') + ')');
                state.stocks = merged;
                state.feedErr = errs;
                if (prices) state.prices = prices;
                if (remote) state.remote = remote;
                state.lastFetch = Date.now();
                recordSnapshot(merged);
                checkAlarms(getSettings());
            } catch (e) {
                state.err = e.message;
            } finally {
                state.loading = false; render();
            }
        }

        // ── Build panel ───────────────────────────────────────────
        function build() {
            // PDA injects the script several times on first load (load-start, load-stop,
            // SPA URL change) and Torn's flying page can carry sub-frames. A per-window
            // flag alone is not enough: each frame gets its own window. Three guards:
            //   1. top frame only          — sub-frame injections bail out
            //   2. marker on <html>        — shared by every injection into the same document
            //   3. self-heal               — drop stray panels/buttons a previous run left
            // Diagnostic: PDA has no devtools, so build attempts are logged to the console,
            // which shows up in `adb logcat -s chromium:*` as INFO:CONSOLE.
            const isTop = window.top === window.self;
            const existing = document.querySelectorAll('#spudTravelPanel').length;
            console.log(`[spud-travel] build v${VERSION} top=${isTop} existing=${existing} url=${location.pathname}${location.search} flag=${!!window.__spudTravelBuilt} mark=${document.documentElement.dataset.spudTravel || '-'}`);

            if (!isTop) { console.log('[spud-travel] skip: not top frame'); return; }
            const root = document.documentElement;
            if (window.__spudTravelBuilt || root.dataset.spudTravel === '1') { console.log('[spud-travel] skip: already built'); return; }
            window.__spudTravelBuilt = true;
            root.dataset.spudTravel = '1';

            const stray = document.querySelectorAll('#spudTravelPanel, #spudTravelBtn');
            if (stray.length) console.log(`[spud-travel] removing ${stray.length} stray node(s)`);
            stray.forEach(n => n.remove());

            const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);

            // On the travel page, bake the panel inline into the page content.
            const onTravel = new URLSearchParams(location.search).get('sid') === 'travel';
            const container = onTravel ? (document.querySelector('.content-wrapper') || document.querySelector('#mainContainer')) : null;
            const embedded = !!container;

            panelEl = document.createElement('div'); panelEl.id = 'spudTravelPanel';
            panelEl.innerHTML = `
            <div class="st-hd" id="st-hd"><b>✈ Spud Travel <span id="st-caret">▾</span></b><span class="st-meta"></span>
            <button class="st-btn sec" id="st-refresh" title="Refresh">↻</button>
            ${embedded ? '' : '<button class="st-btn sec" id="st-close">✕</button>'}</div>
            <div class="st-tabs">
            <button data-tab="deals" class="on">Deals</button>
            <button data-tab="planner">Planner</button>
            <button data-tab="predict">Predictions</button>
            <button data-tab="settings">Settings</button></div>
            <div class="st-body"></div>`;

            if (embedded) {
                panelEl.classList.add('embedded', 'open');
                container.insertBefore(panelEl, container.firstChild);
                refresh(); // auto-load since it's always visible
            } else {
                const btn = document.createElement('button'); btn.id = 'spudTravelBtn'; btn.textContent = '✈'; btn.title = 'Spud Travel';
                document.body.appendChild(btn);
                document.body.appendChild(panelEl);
                btn.onclick = () => { panelEl.classList.toggle('open'); if (panelEl.classList.contains('open') && !state.stocks) refresh(); else render(); };
                const cl = panelEl.querySelector('#st-close'); if (cl) cl.onclick = () => panelEl.classList.remove('open');
            }
            // Collapse to just the header by tapping it. Buttons inside must not toggle.
            if (getSettings()._collapsed) panelEl.classList.add('collapsed');
            panelEl.querySelector('#st-hd').addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                const on = panelEl.classList.toggle('collapsed');
                const cur = getSettings(); cur._collapsed = on; saveSettings(cur);
            });

            panelEl.querySelector('#st-refresh').onclick = () => refresh();
            panelEl.querySelectorAll('.st-tabs button').forEach(b => b.onclick = () => { activeTab = b.dataset.tab; render(); });
            render();
            // background loop: refresh feed + check alarms every 60s
            setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 60 * 1000);
            setInterval(() => checkAlarms(getSettings()), 30 * 1000);
        }

        if (document.body) build();
        else window.addEventListener('DOMContentLoaded', build);
})();
