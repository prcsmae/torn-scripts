/**
 * Poor-man's undefined-symbol check for the Apps Script project.
 *
 * Apps Script only reports a missing function when the code path actually runs,
 * so a reference to a function nobody defines sits there silently until a menu
 * item is clicked or an hourly sync reaches it — which is exactly how this
 * project once shipped a menu entry calling `compactLogs_`, a function that
 * existed only in another lineage. Run this with `node tests/ledger-symbol-check.js`
 * whenever a file is pasted into the project and before believing the project
 * is coherent.
 *
 * It reports every function call site in script/*.gs whose name is neither
 * declared anywhere in the project nor a known Apps Script / JavaScript global.
 * String literals and comments are stripped first, and nested declarations
 * count, so the output is intended to be empty.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const DIR = path.join(__dirname, '..', 'script');
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.gs'));

/** Comments, string and regex literals out — they contain prose and sheet formulas. */
function strip(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    // regex literals: a slash in a position where a value must start, closed on
    // the same line. Without this, /items (outgoing|incoming)/ reads as a call.
    .replace(/([=(,|?:[\s])\/(?:[^\/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])*\/[gimsuy]*/g, '$1/RE/');
}

const src = {};
for (const f of files) src[f] = fs.readFileSync(path.join(DIR, f), 'utf8');

// every function the project declares (top-level or nested)
const defined = new Set();
for (const f of files) {
  const re = /function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m;
  while ((m = re.exec(strip(src[f])))) defined.add(m[1]);
}
// plus the Apps Script / JS globals the code may call
const ctx = vm.createContext({});
['JSON', 'Object', 'Array', 'Math', 'Number', 'String', 'Boolean', 'Date', 'RegExp', 'Error',
 'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent',
 'SpreadsheetApp', 'PropertiesService', 'Utilities', 'UrlFetchApp', 'ScriptApp', 'console',
 'Map', 'Set', 'Promise'].forEach(g => { try { vm.runInContext('typeof ' + g, ctx); defined.add(g); } catch (e) {} });

const shown = {};
for (const f of files) {
  const re = /(^|[^.\w$])([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m;
  const code = strip(src[f]);
  while ((m = re.exec(code))) {
    const name = m[2];
    if (defined.has(name) || ['function', 'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof'].includes(name)) continue;
    // property/method-ish calls (foo.bar() already skipped) and JS built-ins
    if (/^(toString|valueOf|hasOwnProperty)$/.test(name)) continue;
    (shown[f] = shown[f] || new Set()).add(name);
  }
}
const found = Object.keys(shown);
if (!found.length) {
  console.log('OK — no undefined function calls across ' + files.length + ' files (' + defined.size + ' declared functions)');
} else {
  found.forEach(f => console.log(f + ' calls: ' + [...shown[f]].join(', ')));
  process.exit(1);
}

// Menu handler names are STRINGS ('12. X', 'doThing'), so a plain call-site scan
// cannot see them — and a handler nobody declares is exactly the failure this
// project already hit once. Check every addItem/newTrigger handler explicitly.
const handlers = [];
for (const f of files) {
  const re = /addItem\(\s*['"][^'"]*['"]\s*,\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g;
  const re2 = /newTrigger\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g;
  let m;
  while ((m = re.exec(src[f]))) handlers.push([f, m[1]]);
  while ((m = re2.exec(src[f]))) handlers.push([f, m[1]]);
}
const badHandlers = handlers.filter(([, h]) => !defined.has(h));
if (badHandlers.length) {
  console.log('MISSING HANDLERS (menu items / triggers pointing at nothing):');
  badHandlers.forEach(([f, h]) => console.log('  ' + f + ' -> ' + h));
  process.exitCode = 1;
} else {
  console.log('OK — all ' + handlers.length + ' menu/trigger handlers are declared');
}

// A function another lineage defined and this one never had is the other failure
// mode — keep those names visible.
const OTHER_LINEAGE = ['buildFlipProfit_', 'buildToday_', 'buildCashFlow_', 'buildItemNames_',
  'compactLogs_', 'compactLogs', 'compactRow_', 'refreshItemNames', 'diagnoseFlips',
  'diagnoseTradeLogs', 'fmtMoney_', 'tradeBaskets_', 'itemNameOf_', 'readItemNames_',
  'todayActivity_', 'bucketFlows_', 'liftLogRows_', 'derivedFactionVault_'];
const hits = [];
for (const f of files) {
  for (const n of OTHER_LINEAGE) {
    // ignore the config.gs comment that names the README instead
    const re = new RegExp('\\b' + n + '\\b');
    if (re.test(src[f])) hits.push(f + ' -> ' + n);
  }
}
if (hits.length) {
  console.log('WARNING: references to another lineage\'s symbols:\n  ' + hits.join('\n  '));
  process.exitCode = 1;
} else {
  console.log('no references to the other lineage\'s symbols');
}
if (process.exitCode) console.log('FAILED');
