/**
 * Mapping tests for GrimmyZaddy-Ledger — plain `node tests/ledger-mapping.test.js`.
 *
 * No dependencies, no spreadsheet: the .gs files are loaded into a vm context
 * (Apps Script's global namespace is what Node gives us for free) and the pure
 * functions are driven directly — moneyExpr_, moneyOf_, effectiveTypes_,
 * classifyRaw_ and healLegacyGuesses_.
 *
 * The payloads below are real v2 log `data` objects. They are the evidence for
 * CASINO_LOGMAP's per-game keys: the v2 log API renamed the casino fields per
 * game, so the generic v1 net key matched nothing and every game landed in
 * Exceptions. Keep them — a mapping change that breaks one of these numbers is
 * breaking the ledger's casino line.
 */
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var SCRIPT_DIR = path.join(__dirname, '..', 'script');
var ctx = vm.createContext({ console: console });
['config.gs', 'parse.gs', 'setup.gs', 'rebuild.gs'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(SCRIPT_DIR, f), 'utf8'), ctx, { filename: f });
});

var fails = 0, checks = 0;
function ok(what, got, want) {
  checks++;
  var same = JSON.stringify(got) === JSON.stringify(want);
  if (!same) { fails++; console.log('  FAIL ' + what + '\n       got  ' + JSON.stringify(got) + '\n       want ' + JSON.stringify(want)); }
}
function section(name) { console.log('\n== ' + name); }

// ---------------------------------------------------------------- samples
// type -> [title, category, [data objects...]]  (from live v2 log dumps)
var SAMPLES = {
  '8310': ['Casino high-low start', 'Casino', [{ bet_amount: 10000 }]],
  '8311': ['Casino high-low lose', 'Casino', [{ round: 1, pot: 10000, pot_increase: 0, action: 'low', result: 'high', dealer_card: 14, player_card: 25 }]],
  '8312': ['Casino high-low draw', 'Casino', [{ round: 2, pot: 15625, pot_increase: 0, action: 'low', result: 'draw', dealer_card: 24, player_card: 21 }]],
  '8313': ['Casino high-low win', 'Casino', [{ round: 1, pot: 12500, pot_increase: 2500, action: 'low', result: 'low', dealer_card: 48, player_card: 10 }]],
  '8314': ['Casino high-low cash in full', 'Casino', [{ round: 4, pot: 24413 }]],
  '8315': ['Casino high-low cash in half', 'Casino', [{ round: 3, pot: 4651 }]],
  '8330': ['Casino craps bet', 'Craps', [{ roll: '4,3', bets: [{ buy_4: 1000 }, { hard_8: 1000 }, { yo: 1000 }] },
                                        { roll: '6,4', bets: [{ field: 10000 }, { buy_6: 1000 }] }]],
  '8331': ['Casino craps win', 'Craps', [{ roll: '4,3', winnings: [{ buy_4: 1000 }, { hard_8: 1000 }] },
                                        { roll: '6,3', winnings: [{ buy_9: 24500 }] },
                                        { roll: '6,4', winnings: [{ field: 20000 }] }]],
  '8332': ['Casino craps lose', 'Craps', [{ roll: '4,3', losses: [{ yo: 1000 }] },
                                         { roll: '6,3', losses: [{ boxcars: 10000 }] }]],
  '8340': ['Casino lottery bet', 'Lottery', [{ lottery: 'Daily Dime', cost: 100 }, { lottery: 'Lucky Shot', cost: 10000 }]],
  '8350': ['Casino blackjack start', 'Blackjack', [{ player_cards: '22,17', dealer_cards: 18, bet: 10 },
                                                  { player_cards: '43,16', dealer_cards: 36, bet: 5000 },
                                                  { player_cards: '35,52', dealer_cards: 51, bet: 10000 }]],
  '8351': ['Casino blackjack hit', 'Blackjack', [{ player_cards: '43,16,18', dealer_cards: 36, card: 18 }]],
  '8354': ['Casino blackjack lose', 'Blackjack', [{ player_cards: '22,17', dealer_cards: '18,49', losses: 10, lose_state: 'lost to the dealer' }]],
  '8355': ['Casino blackjack win', 'Blackjack', [{ player_cards: '43,16,18', dealer_cards: '36,33', winnings: 10000, win_state: '' },
                                                 { player_cards: '35,52', dealer_cards: '51,24', winnings: 25000, win_state: 'with a natural' }]],
  '8370': ['Casino spin the wheel start', 'Spin the wheel', [{ wheel: 'the Wheel of Lame', cost: 1000 },
                                                            { wheel: 'the Wheel of Mediocrity', cost: 50000 }]],
  '8374': ['Casino spin the wheel win money', 'Spin the wheel', [{ wheel: 'the Wheel of Lame', money: 1 },
                                                                 { wheel: 'the Wheel of Lame', money: 2000 }]],
  '8400': ['Casino russian roulette leave', 'Russian roulette', [{ game_id: 11140315, opponent: '', refund: 100 }]],
  '6220': ['Job pay', 'Job', [{ pay: 220, job_points: 4, working_stats_received: '12,4,7', job: 'Army' }]],
  '7815': ['Missions complete', 'Missions', [{ type: 'contract', agent: 3, mission: 108, difficulty: 'easy', money: 4500, credits: 5 }]],
  '6005': ['Rehab', 'Travel', [{ cost: 500000, rehab_times: 2, addiction: 46.88, happy_increased: 0 }]],
  '9165': ['Crime critical fail money loss', 'Crimes', [{ crime_action: 'copying DVDs', outcome: 1349, nerve: 2, money_lost: 75 }]],
  '6710': ['Bounty claim', 'Bounties', [{ lister: 4066732, anonymous: 0, target: 4090670, bounty_reward: 100000 }]],
  '6711': ['Bounty claim lister', 'Bounties', [{ claimer: 0, anonymous: 1, target: 4223880, bounty_reward: 250000 }]]
};

/** RawLog rows for every sample above, shaped exactly like readRaw_'s output. */
function rawRows() {
  var rows = [], ts = 1700000000;
  Object.keys(SAMPLES).forEach(function (id) {
    var s = SAMPLES[id];
    s[2].forEach(function (d, i) {
      rows.push({ ts: ts++, logType: id, category: s[1], title: s[0], money: 0,
                  itemId: '', itemName: '', qty: 1, raw: JSON.stringify(d) });
    });
  });
  return rows;
}

/**
 * The LogTypeMap state this ledger was found in: casino types classified by the
 * category rule (income + the generic v1 net), everything else still sitting on
 * the default 'ignore' with no money_key — the state that produced the wall of
 * Exceptions.
 */
function brokenSheetTypes() {
  var types = {};
  Object.keys(SAMPLES).forEach(function (id) {
    types[id] = /^8[34]/.test(id)
      ? { title: SAMPLES[id][0], direction: 'income', bucket: 'Casino', moneyKey: ctx.CASINO_GUESS_KEY }
      : { title: SAMPLES[id][0], direction: 'ignore', bucket: 'Other', moneyKey: '' };
  });
  return types;
}

// ------------------------------------------------------- money_key grammar
section('money_key grammar');
ok("'pot/2' floors", ctx.moneyExpr_({ pot: 4651 }, 'pot/2'), 2325);
ok("'-bet' negates", ctx.moneyExpr_({ bet: 5000 }, '-bet'), -5000);
ok("'sum:bets' adds the array", ctx.moneyExpr_({ bets: [{ buy_4: 1000 }, { hard_8: 1000 }] }, 'sum:bets'), 2000);
ok("'-sum:bets' negates the sum", ctx.moneyExpr_({ bets: [{ buy_4: 1000 }, { hard_8: 1000 }] }, '-sum:bets'), -2000);
ok("'sum:' tolerates a junk entry", ctx.moneyExpr_({ bets: [{ a: 1 }, null, { b: '2' }] }, 'sum:bets'), 3);
ok("'sum:' on an empty array is null, not 0", ctx.moneyExpr_({ winnings: [] }, 'sum:winnings'), null);
ok("'sum:' on a missing field is null", ctx.moneyExpr_({}, 'sum:winnings'), null);
ok("'worth-fees' still works", ctx.moneyExpr_({ worth: 1000, fees: 50 }, 'worth-fees'), 950);
ok("'a?b' nets when both exist", ctx.moneyExpr_({ won_amount: 500, bet_amount: 100 }, 'won_amount?bet_amount'), 400);
ok("'a?b' negates the bet when only b exists", ctx.moneyExpr_({ bet_amount: 100 }, 'won_amount?bet_amount'), -100);
ok("'a?b' is null on neither", ctx.moneyExpr_({}, 'won_amount?bet_amount'), null);

section('a derived key is authoritative (no re-guessing)');
var bjRow = { ts: 1, logType: '8350', title: 'Casino blackjack start', category: 'Blackjack',
              money: 0, raw: JSON.stringify({ bet: 10 }) };
ok('a stale v1 casino key finds nothing in a v2 payload',
   ctx.moneyOf_(bjRow, { direction: 'income', moneyKey: ctx.CASINO_GUESS_KEY }), null);
ok('the v2 key prices the same row',
   ctx.moneyOf_(bjRow, { direction: 'income', moneyKey: '-bet' }), -10);
ok('a compacted row keeps its frozen money',
   ctx.moneyOf_({ ts: 1, logType: '8350', money: 42, raw: '' },
                { direction: 'income', moneyKey: '-bet' }), 42);

// --------------------------------------------------- per-type amounts, live
section('every casino log type prices from the effective map');
var EXPECT = {
  '8310': [-10000], '8311': [0], '8312': [0], '8313': [0],
  '8314': [24413], '8315': [2325],
  '8330': [-3000, -11000], '8331': [2000, 24500, 20000], '8332': [0],
  '8340': [-100, -10000],
  '8350': [-10, -5000, -10000], '8351': [0], '8354': [0], '8355': [10000, 25000],
  '8370': [-1000, -50000], '8374': [1, 2000], '8400': [100]
};
var eff = ctx.effectiveTypes_(brokenSheetTypes());
Object.keys(EXPECT).forEach(function (id) {
  var s = SAMPLES[id];
  var got = s[2].map(function (d) {
    return ctx.moneyOf_({ ts: 1, logType: id, money: 0, raw: JSON.stringify(d) }, eff[id]);
  });
  // 'ignore' types move no money, so moneyOf_ is not even consulted for them;
  // assert the direction instead and that they hold no key.
  if (eff[id].direction === 'ignore') {
    ok(id + ' ' + s[0] + ' -> ignore', [eff[id].direction, eff[id].moneyKey], ['ignore', '']);
  } else {
    ok(id + ' ' + s[0] + ' -> ' + EXPECT[id].join(','), got, EXPECT[id]);
  }
});

section('reference types price from the effective map');
var rowFor = function (id) { return rawRows().filter(function (r) { return r.logType === id; })[0]; };
ok('6220 Job pay -> income 220', [eff['6220'].direction, ctx.moneyOf_(rowFor('6220'), eff['6220'])], ['income', 220]);
ok('7815 mission -> income 4500', ctx.moneyOf_(rowFor('7815'), eff['7815']), 4500);
ok('6005 rehab -> expense 500000', [eff['6005'].direction, ctx.moneyOf_(rowFor('6005'), eff['6005'])], ['expense', 500000]);
ok('9165 crime fail -> expense 75', [eff['9165'].direction, ctx.moneyOf_(rowFor('9165'), eff['9165'])], ['expense', 75]);
ok('6710 bounty claim -> income 100000', [eff['6710'].direction, ctx.moneyOf_(rowFor('6710'), eff['6710'])], ['income', 100000]);
ok('6711 bounty claim lister -> ignore', [eff['6711'].direction, eff['6711'].moneyKey], ['ignore', '']);
ok('buckets', [eff['6220'].bucket, eff['7815'].bucket, eff['9165'].bucket, eff['6710'].bucket],
   ['Job', 'Mission', 'Crime', 'Bounties']);

// ------------------------------------------------------------ the semantics
section('the accounting the keys encode');
var hand = function (bet, win) {
  return ctx.moneyOf_({ ts: 1, logType: '8350', money: 0, raw: JSON.stringify({ bet: bet }) }, eff['8350']) +
         ctx.moneyOf_({ ts: 2, logType: '8355', money: 0, raw: JSON.stringify({ winnings: win }) }, eff['8355']);
};
ok('blackjack even money: bet 5000, winnings 10000 -> +5000', hand(5000, 10000), 5000);
ok('blackjack natural 3:2: bet 10000, winnings 25000 -> +15000', hand(10000, 25000), 15000);
ok('blackjack loss books the stake once (start -10000, lose 0, not -20000)',
   hand(10000, 0) === 10000 ? 'double-counted' : -10000, -10000);
ok('the lose log moves no money at all (rebuild never prices it)', (function () {
  var r = ctx.classifyRaw_([{ ts: 1, logType: '8354', category: 'Blackjack', title: 'Casino blackjack lose',
                              money: 0, raw: JSON.stringify(SAMPLES['8354'][2][0]) }], eff);
  return [r.income.length + r.expenses.length, r.exceptions.length];
})(), [0, 0]);
ok('high-low: ante 10000 out, cash in 24413 -> +14413',
   ctx.moneyOf_({ ts: 1, logType: '8310', money: 0, raw: JSON.stringify({ bet_amount: 10000 }) }, eff['8310']) +
   ctx.moneyOf_({ ts: 9, logType: '8314', money: 0, raw: JSON.stringify({ pot: 24413 }) }, eff['8314']), 14413);
ok('craps come-out 7: 3000 staked, 2000 returned, yo lost -> -1000',
   ctx.moneyOf_({ ts: 1, logType: '8330', money: 0, raw: JSON.stringify(SAMPLES['8330'][2][0]) }, eff['8330']) +
   ctx.moneyOf_({ ts: 2, logType: '8331', money: 0, raw: JSON.stringify(SAMPLES['8331'][2][0]) }, eff['8331']), -1000);
ok('craps field bet: 11000 staked (field 10000 + buy_6 1000), 20000 returned -> +9000',
   ctx.moneyOf_({ ts: 1, logType: '8330', money: 0, raw: JSON.stringify(SAMPLES['8330'][2][1]) }, eff['8330']) +
   ctx.moneyOf_({ ts: 2, logType: '8331', money: 0, raw: JSON.stringify(SAMPLES['8331'][2][2]) }, eff['8331']), 9000);
ok('craps buy_9 10000 returned 24500 -> +14500 (3:2 less the 5% buy fee)',
   ctx.moneyOf_({ ts: 1, logType: '8330', money: 0, raw: JSON.stringify({ roll: '2,6', bets: [{ buy_9: 10000 }] }) }, eff['8330']) +
   ctx.moneyOf_({ ts: 2, logType: '8331', money: 0, raw: JSON.stringify(SAMPLES['8331'][2][1]) }, eff['8331']), 14500);

// ------------------------------------------------- the sheet stays the boss
section('LogTypeMap wins when it was actually configured');
var sheet = {
  '8355': { title: 'Casino blackjack win', direction: 'income', bucket: 'Casino', moneyKey: 'winnings' },
  '8306': { title: 'Casino roulette lose', direction: 'income', bucket: 'Casino', moneyKey: 'winnings' },
  '6220': { title: 'Job pay', direction: 'ignore', bucket: 'Job', moneyKey: 'off' },
  '6005': { title: 'Rehab', direction: 'ignore', bucket: 'MyLabel', moneyKey: '' },
  '7815': { title: 'Missions complete', direction: 'expense', bucket: 'Mission', moneyKey: 'money' },
  '6710': { title: 'Bounty claim', direction: 'income', bucket: 'Bounties', moneyKey: '' }
};
var e2 = ctx.effectiveTypes_(sheet);
ok('a hand-set casino key survives', e2['8355'].moneyKey, 'winnings');
ok('a key someone typed for an unmapped game survives', e2['8306'].moneyKey, 'winnings');
ok('ignore + a key is a deliberate exclusion', [e2['6220'].direction, e2['6220'].moneyKey], ['ignore', 'off']);
ok('a hand-picked direction survives', e2['7815'].direction, 'expense');
ok('a relabelled bucket survives the direction heal', [e2['6005'].direction, e2['6005'].bucket], ['expense', 'MyLabel']);
ok('a row already right is left alone', [e2['6710'].direction, e2['6710'].bucket], ['income', 'Bounties']);

// ------------------------------------------------------------- classifyRaw_
section('classifyRaw_: the Exceptions tab empties out');
var res = ctx.classifyRaw_(rawRows(), eff);
ok('nothing is flagged', res.exceptions.length, 0);
// 33 sample rows: 27 casino (7 of them result logs that move no money) and 6
// reference rows (6711 deliberately ignored) -> 20 + 3 income rows, 2 expenses.
ok('income rows', res.income.length, 23);
ok('expense rows', res.expenses.length, 2);
ok('Rehab books 500000 out', res.expenses.filter(function (r) { return r[1] === 'Rehab' && r[3] === 500000; }).length, 1);
ok('the crime fail books 75 out', res.expenses.filter(function (r) { return r[1] === 'Crime critical fail money loss' && r[3] === 75; }).length, 1);
ok('the casino session nets what the game logs say',
   Math.round(res.income.filter(function (r) { return r[2] === 'Casino'; })
     .reduce(function (a, r) { return a + r[3]; }, 0)), 10229);

section('classifyRaw_: a genuinely unknown type still fails loudly');
var unknown = { ts: 1700009999, logType: '9999', category: 'Bounties', title: 'Mystery money log',
                money: 0, raw: JSON.stringify({ bounty_reward: 500 }) };
var res2 = ctx.classifyRaw_([unknown], eff);
ok('one exception', res2.exceptions.length, 1);
ok('it names the fix',
   /Unmapped money log/.test(res2.exceptions[0][3]), true);
var mysteryCasino = { ts: 1700010000, logType: '8306', category: 'Roulette',
                      title: 'Casino roulette lose', money: 0, raw: '{"losses":250000}' };
// The sheet classifies roulette as casino income with the generic v1 net (that
// is exactly the state the Exceptions tab was full of); CASINO_LOGMAP has no
// verified v2 shape for it yet, so it must keep failing loudly rather than
// booking a made-up number.
var effUnknown = ctx.effectiveTypes_({
  '8306': { title: 'Casino roulette lose', direction: 'income', bucket: 'Casino', moneyKey: ctx.CASINO_GUESS_KEY }
});
var res3 = ctx.classifyRaw_([mysteryCasino], effUnknown);
ok('an unmapped casino game flags rather than booking a made-up number',
   [res3.exceptions.length, /Money-in log but no money field/.test(res3.exceptions[0][3])], [1, true]);
// The June roulette/slots rows in RawLog have no raw JSON left and nothing
// frozen in the money column either. Those cannot be interpreted at all, so
// they are reported with their own message instead of silently booking $0.
var res4 = ctx.classifyRaw_([{ ts: 1700010001, logType: '8306', category: 'Roulette',
                               title: 'Casino roulette lose', money: 0, raw: '' }], effUnknown);
ok('a raw-less row with nothing frozen is reported, not booked as $0',
   [res4.income.length + res4.expenses.length, res4.exceptions.length,
    /no raw data and no amount frozen/.test(res4.exceptions[0][3])], [0, 1, true]);
ok('a raw-less row WITH a frozen amount books it (the compaction contract)',
   (function () {
     var r = ctx.classifyRaw_([{ ts: 1700010002, logType: '8306', category: 'Roulette',
                                 title: 'Casino roulette lose', money: -1234, raw: '' }], effUnknown);
     return [r.income.length, r.exceptions.length, r.income[0][3]];
   })(), [1, 0, -1234]);

// -------------------------------------------------------------- heal pass
section('healLegacyGuesses_ writes the same answers into the sheet');
var members = { 14: {}, 17: {} };
var catNames = { 99: 'Blackjack' };
var casinoIds = { 99: true };
var casinoTypeIds = { '8350': true, '8355': true, '8306': true, '8314': true };
var healed = ctx.healLegacyGuesses_([
  [6220, 'City job pay', 'ignore', 'Other', ''],
  [7815, 'Missions complete', 'ignore', 'Other', ''],
  [9165, 'Crime critical fail money loss', 'ignore', 'Crime', ''],
  [6710, 'Bounty claim', 'ignore', 'Other', ''],
  [6711, 'Bounty claim lister', 'ignore', 'Other', ''],
  [8350, 'Casino blackjack start', 'income', 'Casino', ctx.CASINO_GUESS_KEY],
  [8355, 'Casino blackjack win', 'income', 'Casino', 'winnings'],
  [8314, 'Casino high-low cash in full', 'income', 'Casino', ctx.CASINO_GUESS_KEY],
  [8306, 'Casino roulette lose', 'income', 'Casino', ctx.CASINO_GUESS_KEY],
  [6005, 'Rehab', 'ignore', 'Other', '']
], casinoTypeIds, members, catNames, casinoIds);
var rowOf = function (id) { return healed.filter(function (r) { return String(r[0]) === id; })[0]; };
ok('6220 healed to income/Job', [rowOf('6220')[2], rowOf('6220')[3]], ['income', 'Job']);
ok('7815 healed to income/Mission', [rowOf('7815')[2], rowOf('7815')[3]], ['income', 'Mission']);
ok('9165 healed to expense/Crime', [rowOf('9165')[2], rowOf('9165')[3]], ['expense', 'Crime']);
ok('6710 healed to income/Bounties', [rowOf('6710')[2], rowOf('6710')[3]], ['income', 'Bounties']);
ok('6711 healed to ignore/Bounties', [rowOf('6711')[2], rowOf('6711')[3]], ['ignore', 'Bounties']);
ok('6005 healed to expense/Other', [rowOf('6005')[2], rowOf('6005')[3]], ['expense', 'Other']);
ok('8350 gets the v2 key', [rowOf('8350')[2], rowOf('8350')[4]], ['income', '-bet']);
ok('8355 keeps a hand-set key', rowOf('8355')[4], 'winnings');
ok('8314 gets pot (moved out of DERIVED_MONEY_KEYS)', rowOf('8314')[4], 'pot');
ok('8306 keeps the generic guess until its shape is known', rowOf('8306')[4], ctx.CASINO_GUESS_KEY);
ok('a second heal run changes nothing (idempotent)',
   JSON.stringify(ctx.healLegacyGuesses_(healed, casinoTypeIds, members, catNames, casinoIds)), JSON.stringify(healed));

console.log('\n' + (fails ? fails + ' FAILED' : 'all passed') + ' — ' + (checks - fails) + '/' + checks + ' checks');
process.exit(fails ? 1 : 0);
