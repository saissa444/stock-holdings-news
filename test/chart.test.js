// 走勢圖後端測試：固定時鐘模擬台股盤中、美股盤中、開盤前、週末、晚上
const assert = require('assert');
const { makeEnv } = require('./gas-mock');
const { makeHandler, twPrice } = require('./fixtures');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('✓', name); }
  catch (e) { console.log('✗', name); console.log(e); process.exitCode = 1; }
}
const realNow = Date.now;
let NOW = 0;
Date.now = () => NOW;
const at = (y, mo, d, hh, mm, tzOff) => Date.UTC(y, mo - 1, d, hh, mm) - tzOff * 3600e3;   // tzOff: 該地時區 (台北 8、美東夏令 -4)
const TPE = (mo, d, hh, mm) => at(2026, mo, d, hh, mm, 8);
const plain = (x) => JSON.parse(JSON.stringify(x));

function fresh(opts) {
  const state = { misDyn: true };
  const env = makeEnv(makeHandler(state), Object.assign({ onSleep: (ms) => { NOW += ms; } }, opts));
  const token = env.ctx.setup();
  [['2330', '台積電'], ['0050', '元大台灣50'], ['6488', '環球晶'], ['AAPL', ''], ['NVDA', '']].forEach(([code, name]) =>
    assert.ok(env.post({ action: 'upsert', token, holding: { code, shares: 1000, cost: 100, name } }).ok));
  return { env, token, state };
}

t('開收盤判斷：台股 09:00–13:35、美股夏令／冬令、週末', () => {
  NOW = TPE(10, 27, 12, 0);
  const { env } = fresh();
  const mo = (m, ms) => env.ctx.marketOpen_(m, ms);
  assert.strictEqual(mo('TW', TPE(10, 27, 10, 30)), true);
  assert.strictEqual(mo('TW', TPE(10, 27, 8, 59)), false);
  assert.strictEqual(mo('TW', TPE(10, 27, 13, 35)), true);
  assert.strictEqual(mo('TW', TPE(10, 27, 13, 36)), false);
  assert.strictEqual(mo('TW', TPE(10, 31, 10, 0)), false, '週六');
  assert.strictEqual(mo('US', TPE(10, 27, 22, 30)), true, '夏令 10:30 EDT');
  assert.strictEqual(mo('US', TPE(10, 27, 21, 29)), false, '夏令 09:29 EDT');
  assert.strictEqual(mo('US', TPE(11, 3, 22, 30)), true, '冬令 09:30 EST');
  assert.strictEqual(mo('US', TPE(11, 3, 21, 30)), false, '冬令 08:30 EST');
  assert.strictEqual(mo('US', TPE(10, 31, 23, 0)), false, '美東週六');
});

t('setup 建立每分鐘排程一次、重跑不重複；removeRecorder 移除；沒授權時 setup 仍完成並寫明', () => {
  NOW = TPE(10, 27, 8, 0);
  const { env } = fresh();
  assert.strictEqual(env.triggers.length, 1);
  assert.strictEqual(env.triggers[0].getHandlerFunction(), 'recordTick');
  assert.strictEqual(env.triggers[0].minutes, 1);
  env.ctx.setup();
  assert.strictEqual(env.triggers.length, 1);
  assert.match(env.sheets['說明'].rows[4][1], /已建立盤中紀錄排程/);
  env.ctx.removeRecorder();
  assert.strictEqual(env.triggers.length, 0);
  const e2 = makeEnv(makeHandler({}), { triggerError: true });
  assert.ok(e2.ctx.setup().length >= 32);
  assert.match(e2.sheets['說明'].rows[4][1], /建立失敗/);
});

t('recordTick：盤中每分鐘記一筆、同一筆快照不重複、收盤後不抓任何資料', () => {
  NOW = TPE(10, 27, 10, 0);
  const { env } = fresh();
  env.resetFetchLog();
  env.ctx.recordTick();
  NOW += 2000; env.ctx.recordTick();          // 同一個 5 秒快照
  NOW += 60e3; env.ctx.recordTick();
  const rec = plain(env.cacheStore['rec:2026-10-27:2330'] ? JSON.parse(env.cacheStore['rec:2026-10-27:2330']) : []);
  assert.strictEqual(rec.length, 2);
  assert.strictEqual(rec[1][1], twPrice('2330', Math.floor(NOW / 5000) * 5000));
  assert.ok(env.cacheStore['rec:2026-10-27:6488'] && env.cacheStore['rec:2026-10-27:0050']);
  assert.ok(!env.fetchLog().some(u => /yahoo/.test(u)), '紀錄只打證交所');
  NOW = TPE(10, 27, 14, 0); env.resetFetchLog();
  env.ctx.recordTick();
  assert.strictEqual(env.fetchLog().length, 0, '收盤後不抓');
  NOW = TPE(10, 31, 10, 0); env.ctx.recordTick();
  assert.strictEqual(env.fetchLog().length, 0, '週末不抓');
});

// 模擬從 09:00 起排程每分鐘執行到 10:30
function runDay(env, from, to) { for (NOW = from; NOW <= to; NOW += 60e3) env.ctx.recordTick(); NOW = to; }

t('台股當日（有紀錄）：09:00 到現在沒有斷層、最後一點是即時價、參考線是昨收、時間軸是 09:00–13:30', () => {
  const { env, token } = fresh();
  runDay(env, TPE(10, 27, 9, 0), TPE(10, 27, 10, 30));
  const r = env.get({ action: 'chart', token, code: '2330', range: '1d' });
  assert.ok(r.ok, JSON.stringify(r));
  const c = r.data;
  assert.strictEqual(c.start, TPE(10, 27, 9, 0)); assert.strictEqual(c.end, TPE(10, 27, 13, 30));
  assert.strictEqual(c.ref, 1070); assert.strictEqual(c.refLabel, '昨收');
  assert.strictEqual(c.gap, false); assert.ok(c.recorded >= 90);
  assert.ok(c.points[0][0] <= TPE(10, 27, 9, 1));
  for (let i = 1; i < c.points.length; i++) {
    assert.ok(c.points[i][0] > c.points[i - 1][0], '時間遞增');
    assert.ok(c.points[i][0] - c.points[i - 1][0] <= 2 * 60e3, '斷層 ' + new Date(c.points[i - 1][0]).toISOString());
  }
  const last = c.points[c.points.length - 1];
  assert.ok(TPE(10, 27, 10, 30) - last[0] < 10e3);
  assert.strictEqual(last[1], twPrice('2330', Math.floor(NOW / 5000) * 5000));
  assert.strictEqual(c.open, true);
});

t('台股當日（沒有紀錄排程）：標示 gap，仍以即時價收尾', () => {
  NOW = TPE(10, 27, 10, 30);
  const { env, token } = fresh();
  env.ctx.removeRecorder();
  for (const k of Object.keys(env.cacheStore)) if (k.startsWith('rec:')) delete env.cacheStore[k];
  env.clearCache();
  const c = env.get({ action: 'chart', token, code: '2330', range: '1d' }).data;
  assert.strictEqual(c.gap, true);
  const pts = c.points;
  assert.ok(pts[pts.length - 2][0] <= TPE(10, 27, 10, 10) + 60e3, 'Yahoo 只到 20 分鐘前');
  assert.ok(TPE(10, 27, 10, 30) - pts[pts.length - 1][0] < 10e3);
});

t('台股開盤前（08:30）：顯示前一個交易日完整走勢；週末顯示週五', () => {
  NOW = TPE(10, 27, 8, 30);
  let { env, token } = fresh();
  let c = env.get({ action: 'chart', token, code: '2330', range: '1d' }).data;
  assert.strictEqual(c.start, TPE(10, 26, 9, 0));
  assert.ok(c.points.length > 250);
  assert.ok(c.points[c.points.length - 1][0] <= TPE(10, 26, 13, 30));
  assert.strictEqual(c.gap, false); assert.strictEqual(c.open, false);
  NOW = TPE(11, 1, 12, 0);   // 週日
  ({ env, token } = fresh());
  c = env.get({ action: 'chart', token, code: '2330', range: '1d' }).data;
  assert.strictEqual(c.start, TPE(10, 30, 9, 0), '週日看週五');
});

t('上櫃股用 .TWO 抓走勢；Yahoo 沒有資料的 0050 仍有紀錄＋即時價', () => {
  const { env, token } = fresh();
  runDay(env, TPE(10, 27, 9, 0), TPE(10, 27, 9, 30));
  env.resetFetchLog();
  const c = env.get({ action: 'chart', token, code: '6488', range: '1d' }).data;
  assert.ok(env.fetchLog().some(u => u.includes('6488.TWO')) && !env.fetchLog().some(u => /6488\.TW\?|6488\.TW$/.test(decodeURIComponent(u))));
  assert.ok(c.points.length > 20);
  const z = env.get({ action: 'chart', token, code: '0050', range: '1d' }).data;
  assert.ok(z.points.length >= 30, '0050 points ' + z.points.length);
  assert.strictEqual(z.ref, 195.2);
});

t('美股當日（台北 22:30＝美東 10:30）：時間軸是美東 09:30–16:00，參考線是昨收，最後是即時價', () => {
  NOW = TPE(10, 27, 22, 30);
  const { env, token } = fresh();
  const c = env.get({ action: 'chart', token, code: 'AAPL', range: '1d' }).data;
  assert.strictEqual(c.start, TPE(10, 27, 21, 30)); assert.strictEqual(c.end, TPE(10, 28, 4, 0));
  assert.strictEqual(c.ref, 262.24);
  assert.ok(c.points.length >= 55 && c.points.length <= 62, 'points ' + c.points.length);
  assert.ok(NOW - c.points[c.points.length - 1][0] <= 5 * 60e3);
  assert.strictEqual(c.open, true);
});

t('其他區間：5日／1月／6月／1年／5年都有資料、點數 ≤ 600、參考線是區間起點、最後一點更新成即時價', () => {
  NOW = TPE(10, 27, 10, 30);
  const { env, token } = fresh();
  ['5d', '1mo', '6mo', '1y', '5y'].forEach(rk => {
    const c = env.get({ action: 'chart', token, code: '2330', range: rk }).data;
    assert.ok(c.points.length > 3 && c.points.length <= 600, rk + ' ' + c.points.length);
    assert.strictEqual(c.refLabel, '區間起點');
    assert.ok(c.ref > 0);
    for (let i = 1; i < c.points.length; i++) assert.ok(c.points[i][0] >= c.points[i - 1][0], rk + ' 時間遞增');
    const last = c.points[c.points.length - 1];
    if (rk !== '5d' && rk !== '1mo') assert.strictEqual(last[1], twPrice('2330', Math.floor(NOW / 5000) * 5000), rk + ' 最後一點＝即時價');
  });
  assert.strictEqual(env.get({ action: 'chart', token, code: '2330', range: '2y' }).ok, false);
});

t('走勢快取：當日 2 分鐘內不重抓 Yahoo；5 年 6 小時', () => {
  NOW = TPE(10, 27, 22, 30);
  const { env, token } = fresh();
  env.get({ action: 'chart', token, code: 'AAPL', range: '1d' });
  env.resetFetchLog(); NOW += 90e3;
  env.get({ action: 'chart', token, code: 'AAPL', range: '1d' });
  assert.ok(!env.fetchLog().some(u => /AAPL\?range=1d&interval=1m/.test(u)));
});

t('live：4 秒內同一檔不重抓；台股即時價同時寫進當日紀錄', () => {
  NOW = TPE(10, 27, 10, 30);
  const { env, token } = fresh();
  env.resetFetchLog();
  const a = env.get({ action: 'live', token, code: '2330' });
  assert.ok(a.ok && a.data.open === true && a.data.quote.price > 0);
  NOW += 3000; env.get({ action: 'live', token, code: '2330' });
  assert.strictEqual(env.fetchLog().filter(u => u.includes('mis.twse')).length, 1);
  NOW += 5000; env.get({ action: 'live', token, code: '2330' });
  assert.strictEqual(env.fetchLog().filter(u => u.includes('mis.twse')).length, 2);
  const rec = JSON.parse(env.cacheStore['rec:2026-10-27:2330']);
  assert.ok(rec.length >= 2);
});

t('收盤後報價快取 10 分鐘（省額度）；盤中 15 秒', () => {
  NOW = TPE(10, 27, 20, 0);
  const { env, token } = fresh();
  env.get({ action: 'data', token }); env.resetFetchLog();
  NOW += 5 * 60e3; env.get({ action: 'data', token });
  assert.ok(!env.fetchLog().some(u => u.includes('mis.twse')), '收盤 5 分鐘後不重抓');
  NOW = TPE(10, 27, 10, 30);
  const f2 = fresh();
  f2.env.get({ action: 'data', token: f2.token }); f2.env.resetFetchLog();
  NOW += 10e3; f2.env.get({ action: 'data', token: f2.token });
  assert.ok(!f2.env.fetchLog().some(u => u.includes('mis.twse')), '盤中 10 秒內用快取');
  NOW += 10e3; f2.env.get({ action: 'data', token: f2.token });
  const env2 = f2.env;
  assert.ok(env2.fetchLog().some(u => u.includes('mis.twse')), '盤中 20 秒後重抓');
});

t('spark：每檔最多 61 點，含時間軸與昨收', () => {
  NOW = TPE(10, 27, 10, 30);
  const { env, token } = fresh();
  runDay(env, TPE(10, 27, 9, 0), TPE(10, 27, 10, 30));
  const s = env.get({ action: 'spark', token });
  assert.ok(s.ok, JSON.stringify(s));
  assert.deepStrictEqual(Object.keys(s.data.spark).sort(), ['0050', '2330', '6488', 'AAPL', 'NVDA']);
  Object.entries(s.data.spark).forEach(([k, v]) => {
    assert.ok(v.points.length > 0 && v.points.length <= 61, k + ' ' + v.points.length);
    assert.ok(v.start && v.end && v.ref > 0, k);
  });
  // 美股盤前（台北 10:30）：顯示美東前一個交易日
  assert.strictEqual(s.data.spark.AAPL.start, TPE(10, 26, 21, 30));
});

t('Google 額度用完：data／chart／live／news 都回 quota 錯誤與說明', () => {
  NOW = TPE(10, 27, 10, 30);
  let left = 1e9;
  const { env, token } = fresh({ quotaLeft: () => left });
  env.clearCache();
  left = env.fetchCount();
  // 報價：回應仍成功（有快取就用快取），並附上說明
  for (const [action, extra] of [['data', {}], ['live', { code: 'AAPL' }]]) {
    const r = env.get(Object.assign({ action, token }, extra));
    assert.ok(r.ok, action); assert.match(r.data.notice || '', /額度/, action);
  }
  // 走勢、新聞：沒有快取 → 回 quota 錯誤
  for (const [action, extra] of [['chart', { code: '2330', range: '5y' }], ['news', {}]]) {
    const r = env.get(Object.assign({ action, token }, extra));
    assert.strictEqual(r.ok, false, action); assert.strictEqual(r.code, 'quota', action + ' ' + r.code);
    assert.match(r.error, /額度/);
  }
});

t('診斷：排程狀態', () => {
  NOW = TPE(10, 27, 10, 30);
  const { env, token } = fresh();
  env.ctx.recordTick();
  let c = env.get({ action: 'diagnose', token }).data.checks.find(x => x.name === '盤中紀錄排程');
  assert.ok(c.ok); assert.match(c.detail, /最近一次 10-27 10:30/);
  env.ctx.removeRecorder();
  c = env.get({ action: 'diagnose', token }).data.checks.find(x => x.name === '盤中紀錄排程');
  assert.strictEqual(c.ok, false); assert.match(c.detail, /setup/);
});

Date.now = realNow;
console.log(`\n${passed} passed`);
