// 重要時程（events）後端測試
const assert = require('assert');
const { makeEnv } = require('./gas-mock');
const { makeHandler, isoOf, expireCrumb } = require('./fixtures');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('✓', name); }
  catch (e) { console.log('✗', name); console.log(e); process.exitCode = 1; }
}

const state = {};
const env = makeEnv(makeHandler(state));
const token = env.ctx.setup();
[['2330', 1000, 600, '台積電'], ['0050', 2000, 150, '元大台灣50'], ['6488', 100, 500, '環球晶'], ['2882', 3000, 50, '國泰金'],
 ['AAPL', 10, 180, ''], ['NVDA', 20, 120, ''], ['MSFT', 5, 400, ''], ['BRK.B', 3, 400, '']]
  .forEach(([code, shares, cost, name]) => assert.ok(env.post({ action: 'upsert', token, holding: { code, shares, cost, name } }).ok));

const get = () => { const r = env.get({ action: 'events', token }); assert.ok(r.ok, JSON.stringify(r)); return r.data; };
let d;

t('民國日期轉換：7 碼、斜線、年月日、西元、錯誤值', () => {
  const f = env.ctx.rocToIso_;
  assert.strictEqual(f('1151030'), '2026-10-30');
  assert.strictEqual(f('115/01/08'), '2026-01-08');
  assert.strictEqual(f('115年1月8日'), '2026-01-08');
  assert.strictEqual(f('2026-10-30'), '2026-10-30');
  assert.strictEqual(f(''), null);
  assert.strictEqual(f('1151330'), null);
  assert.strictEqual(f(null), null);
});

t('取得時程：各來源狀態都正常', () => {
  d = get();
  assert.deepStrictEqual(Object.keys(d.sources).sort(), ['conf', 'exTw', 'us']);
  Object.values(d.sources).forEach(s => assert.ok(s.ok, JSON.stringify(s)));
  assert.strictEqual(d.today, isoOf(0));
  for (let i = 1; i < d.events.length; i++) assert.ok(d.events[i - 1].date <= d.events[i].date, '依日期排序');
});

t('法說會：上市（台積電）與上櫃（環球晶）都抓到；過期 40 天的不列；HTML 實體與換行處理', () => {
  const conf = d.events.filter(e => e.type === 'conf');
  assert.deepStrictEqual(conf.map(e => e.codes[0]).sort(), ['2330', '6488']);
  const tsmc = conf.find(e => e.codes[0] === '2330');
  assert.strictEqual(tsmc.date, isoOf(5)); assert.strictEqual(tsmc.time, '14:00');
  assert.strictEqual(tsmc.place, '線上法說會 （同步直播）');
  assert.strictEqual(tsmc.detail, '本公司115年第四季\n營運展望說明');
  assert.strictEqual(conf.find(e => e.codes[0] === '6488').time, '15:30');
});

t('法說會：ETF 不查、查無資料的公司（國泰金）不算錯誤', () => {
  const e4 = makeEnv(makeHandler({}));
  const tk = e4.ctx.setup();
  ['2330', '0050', '00878', '2882'].forEach(code => e4.post({ action: 'upsert', token: tk, holding: { code, shares: 1, cost: 1 } }));
  e4.resetFetchLog();
  const r = e4.get({ action: 'events', token: tk }).data;
  const mops = e4.fetchLog().filter(u => u.includes('mopsov'));
  assert.ok(!mops.some(u => /co_id=00/.test(u)), 'ETF 不應查法說會：' + mops.join(' '));
  assert.ok(mops.some(u => /co_id=2330&TYPEK=sii/.test(u)) && !mops.some(u => /co_id=2330&TYPEK=otc/.test(u)), '上市只查 sii');
  assert.ok(r.sources.conf.ok, '國泰金查無資料不算錯');
});

t('台股除權息：上市（0050、台積電）與上櫃（環球晶權息）；非持股、半年外的不列', () => {
  const ex = d.events.filter(e => e.type === 'exdiv' && e.currency === 'TWD');
  const by = Object.fromEntries(ex.map(e => [e.codes[0], e]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['0050', '2330', '6488']);
  assert.strictEqual(by['0050'].date, isoOf(10)); assert.strictEqual(by['0050'].cash, 1); assert.strictEqual(by['0050'].title, '除息');
  assert.strictEqual(by['2330'].cash, 5);
  assert.strictEqual(by['6488'].title, '除權息'); assert.strictEqual(by['6488'].cash, 4.5); assert.strictEqual(by['6488'].stockRatio, 0.05);
  assert.strictEqual(by['6488'].source, '櫃買中心');
});

t('美股財報：盤後（AAPL）、盤前（MSFT）、預估區間（NVDA）、沒有資料（BRK.B）', () => {
  const er = Object.fromEntries(d.events.filter(e => e.type === 'earnings').map(e => [e.codes[0], e]));
  assert.deepStrictEqual(Object.keys(er).sort(), ['AAPL', 'MSFT', 'NVDA']);
  assert.strictEqual(er.AAPL.date, isoOf(4)); assert.strictEqual(er.AAPL.timing, '盤後'); assert.strictEqual(er.AAPL.estimate, false);
  assert.match(er.AAPL.detail, /台灣時間隔天清晨/);
  assert.strictEqual(er.MSFT.timing, '盤前');
  assert.strictEqual(er.NVDA.date, isoOf(30)); assert.strictEqual(er.NVDA.dateEnd, isoOf(35));
  assert.strictEqual(er.NVDA.estimate, true); assert.strictEqual(er.NVDA.timing, null);
});

t('美股除息：最近 7 天內已過的也列出，含上次配息金額與發放日', () => {
  const ex = d.events.find(e => e.type === 'exdiv' && e.codes[0] === 'AAPL');
  assert.strictEqual(ex.date, isoOf(-3)); assert.strictEqual(ex.cash, 0.26); assert.strictEqual(ex.payDate, isoOf(10));
  assert.strictEqual(ex.currency, 'USD');
});

t('法定期限：遇週末順延、金控與一般公司分開、ETF 不列、月營收每月一筆', () => {
  const dl = d.events.filter(e => e.type === 'deadline');
  assert.ok(dl.length >= 5);
  dl.forEach(e => {
    const w = new Date(e.date + 'T00:00:00Z').getUTCDay();
    assert.ok(w >= 1 && w <= 5, e.date + ' ' + e.title + ' 落在週末');
    assert.ok(!e.codes.includes('0050'), 'ETF 不應出現在期限裡');
    if (/金控/.test(e.title)) assert.deepStrictEqual(e.codes, ['2882']);
    else if (/季財報/.test(e.title)) assert.ok(!e.codes.includes('2882') && e.codes.includes('2330'));
  });
  const rev = dl.filter(e => /月營收/.test(e.title));
  assert.strictEqual(rev.length, 2, '月營收只列接下來 2 次');
  assert.ok(rev.every(e => e.date >= isoOf(0)));
  // 獨立推算：今年／明年 Q3 期限 11/14，週六順延到週一
  const nextWd = (y, m, dd) => { const x = new Date(Date.UTC(y, m - 1, dd)); const w = x.getUTCDay(); return new Date(x.getTime() + (w === 6 ? 2 : w === 0 ? 1 : 0) * 864e5).toISOString().slice(0, 10); };
  const y = +isoOf(0).slice(0, 4);
  [y, y + 1].forEach(yy => {
    const due = nextWd(yy, 11, 14);
    if (due >= isoOf(-7) && due <= isoOf(180)) assert.ok(dl.some(e => e.title === '第三季財報公告期限' && e.date === due), 'Q3 ' + due);
    const fin = nextWd(yy, 11, 29);
    if (fin >= isoOf(-7) && fin <= isoOf(180)) assert.ok(dl.some(e => e.title === '第三季財報公告期限（金控）' && e.date === fin), '金控 Q3 ' + fin);
  });
});

t('快取：第二次呼叫不再打外部', () => {
  env.resetFetchLog(); get();
  assert.strictEqual(env.fetchLog().length, 0);
});

t('Yahoo 驗證碼過期 → 自動重新取得一次', () => {
  for (const k of Object.keys(env.cacheStore)) if (k.startsWith('ev:')) delete env.cacheStore[k];
  expireCrumb();
  const r = get();
  assert.ok(r.sources.us.ok, JSON.stringify(r.sources.us));
  assert.ok(r.events.some(e => e.type === 'earnings' && e.codes[0] === 'AAPL'));
});

t('觀測站擋連線 → 法說會標示失敗，其他時程照常', () => {
  env.clearCache(); state.mopsDown = true;
  const r = get();
  assert.strictEqual(r.sources.conf.ok, false); assert.match(r.sources.conf.detail, /觀測站/);
  assert.ok(!r.events.some(e => e.type === 'conf'));
  assert.ok(r.events.some(e => e.type === 'exdiv') && r.events.some(e => e.type === 'earnings') && r.events.some(e => e.type === 'deadline'));
  state.mopsDown = false;
});

t('除權息預告表掛掉、Yahoo 驗證失敗 → 各自標示，不影響其他', () => {
  env.clearCache(); state.exDown = true; state.yahooAuthDown = true;
  const r = get();
  assert.strictEqual(r.sources.exTw.ok, false); assert.strictEqual(r.sources.us.ok, false);
  assert.ok(r.sources.conf.ok);
  assert.ok(r.events.some(e => e.type === 'conf'));
  state.exDown = false; state.yahooAuthDown = false;
});

t('只有美股持倉 → 不打台股來源、不產生法定期限', () => {
  const e2 = makeEnv(makeHandler({}));
  const tk = e2.ctx.setup();
  e2.post({ action: 'upsert', token: tk, holding: { code: 'AAPL', shares: 1, cost: 1 } });
  const r = e2.get({ action: 'events', token: tk }).data;
  assert.deepStrictEqual(Object.keys(r.sources), ['us']);
  assert.ok(!r.events.some(e => e.type === 'deadline'));
  assert.ok(!e2.fetchLog().some(u => /mopsov|twse|tpex/.test(u)));
});

t('沒有持倉 → 空清單', () => {
  const e3 = makeEnv(makeHandler({}));
  const tk = e3.ctx.setup();
  const r = e3.get({ action: 'events', token: tk }).data;
  assert.deepStrictEqual(r.events, []);
});

t('診斷：新增的 4 個來源都回報', () => {
  env.clearCache();
  const c = env.get({ action: 'diagnose', token }).data.checks;
  ['法說會（觀測站）', '除權息預告（上市）', '除權息預告（上櫃）', 'Yahoo 財報日'].forEach(n => {
    const x = c.find(y => y.name === n); assert.ok(x && x.ok, n + ' ' + JSON.stringify(x));
  });
  state.mopsDown = true;
  assert.strictEqual(env.get({ action: 'diagnose', token }).data.checks.find(y => y.name === '法說會（觀測站）').ok, false);
  state.mopsDown = false;
});

console.log(`\n${passed} passed`);
