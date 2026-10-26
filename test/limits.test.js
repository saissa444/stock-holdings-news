// 兩條硬性規則：證交所請求頻率、Google 每日連線額度（多台裝置同時開著，模擬一整天）
const assert = require('assert');
const { makeEnv } = require('./gas-mock');
const fx = require('./fixtures');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('✓', name); }
  catch (e) { console.log('✗', name); console.log(e); process.exitCode = 1; }
}
let NOW = 0;
fx.setClock(() => NOW);
const TPE = (mo, d, hh, mm) => Date.UTC(2026, mo - 1, d, hh, mm) - 8 * 3600e3;

function backend(holdings, opts) {
  const env = makeEnv(fx.makeHandler({ misDyn: true, usDyn: true }), Object.assign({ onSleep: (ms) => { NOW += ms; } }, opts || {}));
  env.ctx.__now = () => NOW;
  const token = env.ctx.setup();
  holdings.forEach(([code, name]) => env.post({ action: 'upsert', token, holding: { code, shares: 100, cost: 100, name } }));
  return { env, token };
}
const misTimes = (env) => env.fetchTimes.filter(([, u]) => u.includes('mis.twse.com.tw')).map(([t]) => t);
function maxIn5s(times) {
  let m = 0;
  for (let i = 0; i < times.length; i++) { let k = i; while (k < times.length && times[k] - times[i] < 5000) k++; m = Math.max(m, k - i); }
  return m;
}

const HOLD = [['2330', '台積電'], ['2317', ''], ['0050', '元大台灣50'], ['6488', '環球晶'], ['00878', ''],
  ['AAPL', ''], ['NVDA', ''], ['MU', ''], ['MSFT', ''], ['BRK.B', '']];

/**
 * 模擬一天：devices 台裝置整天開著 App（盤中每 30 秒更新列表、每 5 分鐘迷你走勢、每 10 分鐘新聞、每 3 小時時程），
 * 其中 liveDevices 台一直開著明細（台股盤中看 2330、美股盤中看 AAPL）每 5 秒更新；排程每分鐘執行。
 * 用 1 秒為單位前進，每台裝置的時間錯開，模擬真實的同時請求。
 */
function simulateDay({ devices, liveDevices, from, to }) {
  NOW = from;
  const { env, token } = backend(HOLD);
  const get = (p) => env.get(Object.assign({ token }, p));
  const errors = {};
  const offs = Array.from({ length: devices }, (_, i) => i * 1700);   // 裝置之間錯開
  const next = offs.map(o => ({ data: from + o, spark: from + o, news: from + o, events: from + o, live: from + o }));
  let nextTick = from;
  for (NOW = from; NOW < to; NOW += 1000) {
    if (NOW >= nextTick) { env.ctx.recordTick(); nextTick += 60e3; }
    const twOpen = env.ctx.marketOpen_('TW', NOW), usOpen = env.ctx.marketOpen_('US', NOW);
    const anyOpen = twOpen || usOpen;
    for (let d = 0; d < devices; d++) {
      const n = next[d];
      const call = (p) => { const r = get(p); if (!r.ok) errors[r.code] = (errors[r.code] || 0) + 1; return r; };
      if (NOW >= n.data) { const r = call({ action: 'data' }); const lv = r.ok ? r.data.usage.level : 0; n.data = NOW + (anyOpen ? (lv === 2 ? 120e3 : lv === 1 ? 60e3 : 30e3) : 300e3); }
      if (NOW >= n.spark) { call({ action: 'spark' }); n.spark = NOW + (anyOpen ? 5 * 60e3 : 30 * 60e3); }
      if (NOW >= n.news) { call({ action: 'news', days: '1' }); n.news = NOW + (anyOpen ? 10 : 30) * 60e3; }
      if (NOW >= n.events) { call({ action: 'events' }); n.events = NOW + 3 * 3600e3; }
      if (d < liveDevices && (twOpen || usOpen) && NOW >= n.live) {
        const code = twOpen ? (d % 2 ? '6488' : '2330') : (d % 2 ? 'NVDA' : 'AAPL');
        if (!n.chartFor || n.chartFor !== code) { call({ action: 'chart', code, range: '1d' }); n.chartFor = code; }
        const r = call({ action: 'live', code });
        n.live = NOW + (r.ok ? r.data.next : 5000);
      }
    }
  }
  return { env, errors };
}

t('證交所：多台裝置同時看即時走勢一整個台股盤中，任何 5 秒內最多 2 次、例行更新間隔 ≥ 5 秒', () => {
  const { env, errors } = simulateDay({ devices: 4, liveDevices: 4, from: TPE(10, 27, 8, 55), to: TPE(10, 27, 13, 40) });
  const times = misTimes(env);
  const gaps = times.slice(1).map((x, i) => x - times[i]);
  console.log('   證交所請求', times.length, '次；任何 5 秒內最多', maxIn5s(times), '次；最短間隔', Math.min(...gaps) / 1000, '秒；錯誤', JSON.stringify(errors));
  assert.ok(maxIn5s(times) <= 2);
  const openSec = (Math.min(TPE(10, 27, 13, 35), TPE(10, 27, 13, 40)) - TPE(10, 27, 9, 0)) / 1000;
  assert.ok(times.length <= openSec / 5 + 20, '盤中最多每 5 秒一次：' + times.length + ' / ' + (openSec / 5));
  assert.ok(times.length >= 2500, '盤中確實有持續更新：' + times.length);
  assert.ok(!errors.quota);
});

t('Google 額度：3 台裝置整天開著、2 台一直看即時走勢（台股＋美股盤中），全天用量低於省額度門檻 12,000', () => {
  const { env, errors } = simulateDay({ devices: 3, liveDevices: 2, from: TPE(10, 27, 8, 0), to: TPE(10, 28, 6, 0) });
  const used = env.fetchCount();
  const by = {};
  env.fetchTimes.forEach(([, u]) => { const h = new URL(u).hostname + (u.includes('/v7/') ? ' v7' : u.includes('/v8/') ? ' v8' : ''); by[h] = (by[h] || 0) + 1; });
  console.log('   全天對外連線', used, '次', JSON.stringify(by), '錯誤', JSON.stringify(errors));
  assert.ok(used < 12000, 'used ' + used);
  assert.strictEqual(env.ctx.usage_(), used, '自己計數＝實際次數');
});

t('極端情況：6 台裝置、全部一直看即時走勢，用量仍守在 Google 上限 20,000 以內（超過 16,000 自動只用快取）', () => {
  const { env, errors } = simulateDay({ devices: 6, liveDevices: 6, from: TPE(10, 27, 8, 0), to: TPE(10, 28, 6, 0) });
  const used = env.fetchCount();
  console.log('   全天對外連線', used, '次；錯誤', JSON.stringify(errors));
  assert.ok(used < 20000, 'used ' + used);
  assert.ok(maxIn5s(misTimes(env)) <= 2);
});

t('省額度模式：超過 12,000 → 即時更新改 15 秒；超過 16,000 → 60 秒、迷你走勢暫停、報價最多每分鐘一次', () => {
  NOW = TPE(10, 27, 10, 30);
  const { env, token } = backend(HOLD);
  const setUsage = (n) => { env.props.USAGE = JSON.stringify({ [Math.floor(NOW / 3600e3)]: n }); env.cacheStore['uf:pending'] = '0'; };
  setUsage(12500);
  let r = env.get({ action: 'live', token, code: '2330' });
  assert.strictEqual(r.data.next, 15000); assert.strictEqual(r.data.usage.level, 1);
  setUsage(16500);
  r = env.get({ action: 'live', token, code: '2330' });
  assert.strictEqual(r.data.next, 60000);
  assert.strictEqual(env.get({ action: 'spark', token }).code, 'budget');
  const before = misTimes(env).length;
  for (let i = 0; i < 12; i++) { NOW += 5000; env.get({ action: 'live', token, code: '2330' }); }
  assert.ok(misTimes(env).length - before <= 1, '一分鐘內最多一次');
  const d = env.get({ action: 'diagnose', token }).data.checks.find(c => c.name === '今日 Google 連線用量');
  assert.strictEqual(d.ok, false); assert.match(d.detail, /只用快取/);
  setUsage(19000);
  NOW += 120e3;
  const r2 = env.get({ action: 'data', token });
  assert.ok(r2.ok, '有快取時仍回應');
  NOW += 700e3;
  const r3 = env.get({ action: 'chart', token, code: '2330', range: '5y' });
  assert.strictEqual(r3.code, 'quota'); assert.match(r3.error, /安全上限/);
});

t('用量以最近 24 小時計算：舊的小時自動不算；跨午夜不會歸零', () => {
  NOW = TPE(10, 27, 23, 30);
  const { env } = backend([]);
  const h = Math.floor(NOW / 3600e3);
  env.props.USAGE = JSON.stringify({ [h - 30]: 9000, [h - 23]: 5000, [h - 1]: 3000 });
  env.cacheStore['uf:pending'] = '200';
  assert.strictEqual(env.ctx.usage_(), 8200);
  NOW = TPE(10, 28, 0, 30);     // 過午夜
  assert.strictEqual(env.ctx.usage_(), 3200, '只剩 24 小時內的');
});

t('新增股票（沒有快取）可以立即查，但連續新增時 5 秒內最多 2 次，第 3 次會稍等', () => {
  NOW = TPE(10, 27, 10, 30);
  const { env, token } = backend([['2330', '台積電']]);
  env.get({ action: 'data', token });
  const t0 = NOW;
  ['6488', '0050', '00878', '2412'].forEach(code => {
    assert.ok(env.get({ action: 'lookup', token, code }).ok, code);
    NOW += 300;
  });
  const times = misTimes(env).filter(x => x >= t0);
  assert.ok(maxIn5s(times) <= 2, times.map(x => x - t0).join(','));
  assert.ok(env.sleeps.length >= 1, '有等待');
});

t('證交所掛掉或擋連線：1 分鐘內不再重試，改用 Yahoo（標示延遲）', () => {
  NOW = TPE(10, 27, 10, 30);
  const state = { misDyn: true, misDown: true };
  const env = makeEnv(fx.makeHandler(state), { onSleep: (ms) => { NOW += ms; } });
  env.ctx.__now = () => NOW;
  const token = env.ctx.setup();
  env.post({ action: 'upsert', token, holding: { code: '2330', shares: 1, cost: 1 } });
  const q = env.get({ action: 'data', token }).data.quotes['2330'];
  assert.strictEqual(q.source, 'Yahoo'); assert.strictEqual(q.delayed, true);
  const n0 = misTimes(env).length;
  for (let i = 0; i < 11; i++) { NOW += 5000; env.get({ action: 'live', token, code: '2330' }); }
  assert.strictEqual(misTimes(env).length, n0, '55 秒內不再打證交所');
  NOW += 10000; state.misDown = false;
  env.get({ action: 'live', token, code: '2330' });
  assert.strictEqual(misTimes(env).length, n0 + 1, '1 分鐘後重試');
});

t('美股報價：全部持股＋匯率合併成 1 次連線', () => {
  NOW = TPE(10, 27, 22, 30);
  const { env, token } = backend(HOLD);
  env.resetFetchLog();
  const r = env.get({ action: 'data', token });
  const ys = env.fetchLog().filter(u => /finance\.yahoo\.com\/v[78]/.test(u) && /AAPL|NVDA|MSFT|BRK|%2CMU|=MU/.test(u));
  assert.strictEqual(ys.length, 1, ys.join('\n'));
  assert.match(ys[0], /AAPL%2CNVDA%2CMU%2CMSFT%2CBRK-B%2CTWD%3DX/);
  assert.ok(['AAPL', 'NVDA', 'MU', 'MSFT', 'BRK.B'].every(c => r.data.quotes[c] && r.data.quotes[c].price > 0));
  assert.strictEqual(r.data.fx.rate, 30.62);
});

console.log(`\n${passed} passed`);
