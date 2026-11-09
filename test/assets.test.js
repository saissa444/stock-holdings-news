// 其他資產（未上市、保險、存款、貸款）與淨資產每日紀錄
const assert = require('assert');
const { makeEnv } = require('./gas-mock');
const fx = require('./fixtures');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('✓', name); }
  catch (e) { console.log('✗', name); console.log(e); process.exitCode = 1; }
}
let NOW = Date.UTC(2026, 10, 9, 3, 0);   // 台北 11/9 11:00
fx.setClock(() => NOW);
const TPE = (mo, d, hh, mm) => Date.UTC(2026, mo - 1, d, hh, mm) - 8 * 3600e3;

function backend(opts) {
  const st = { misDyn: true, usDyn: true };
  const env = makeEnv(fx.makeHandler(Object.assign(st, opts && opts.state)), { onSleep: (ms) => { NOW += ms; } });
  env.ctx.__now = () => NOW;
  const token = env.ctx.setup();
  return { env, token, state: st, post: (b) => env.post(Object.assign({ token }, b)), get: (p) => env.get(Object.assign({ token }, p)) };
}
const plain = (x) => JSON.parse(JSON.stringify(x));

let B;
t('setup 建立「其他資產」工作表', () => {
  B = backend();
  assert.deepStrictEqual(B.env.sheets['其他資產'].rows[0].slice(0, 6), ['ID', '類別', '名稱', '機構', '幣別', '金額']);
  assert.strictEqual(B.env.sheets['其他資產'].fmt[1], '@');
});

t('新增四類資產；未上市以股數×每股價格計算', () => {
  const add = (a) => { const r = B.post({ action: 'assetUpsert', asset: a }); assert.ok(r.ok, JSON.stringify(r)); return r.data.id; };
  add({ type: '未上市', name: '某未上市科技', inst: '', cur: 'TWD', shares: '2,000', price: '45.5', cost: 60000 });
  add({ type: '保險', name: '美元利變壽險', inst: '某人壽', cur: 'USD', amount: 12000, cost: 10000 });
  add({ type: '保險', name: '日圓年金', inst: '某人壽', cur: 'JPY', amount: 3000000, cost: 2800000 });
  add({ type: '存款', name: '活存', inst: '某銀行', cur: 'TWD', amount: 350000, rate: 1.2 });
  add({ type: '存款', name: '澳幣定存', inst: '某銀行', cur: 'AUD', amount: 10000, rate: 4.1 });
  add({ type: '貸款', name: '房貸', inst: '某銀行', cur: 'TWD', amount: 3200000, rate: 2.185, monthly: 18000 });
  const r = B.get({ action: 'assets' });
  assert.ok(r.ok, JSON.stringify(r));
  const a = r.data.assets;
  assert.strictEqual(a.length, 6);
  const unl = a.find(x => x.type === '未上市');
  assert.strictEqual(unl.shares, 2000); assert.strictEqual(unl.price, 45.5); assert.strictEqual(unl.amount, null);
  assert.strictEqual(a.find(x => x.type === '貸款').monthly, 18000);
  assert.ok(a.every(x => /^\d{4}-\d{2}-\d{2}$/.test(x.updated)), '更新日期預設今天');
  assert.strictEqual(a[0].updated, '2026-11-09');
  assert.deepStrictEqual(plain(r.data.fx), { TWD: 1, USD: 30.62, JPY: 0.2012, AUD: 20.15 });
});

t('輸入驗證', () => {
  const bad = (a, re) => { const r = B.post({ action: 'assetUpsert', asset: a }); assert.strictEqual(r.ok, false); assert.match(r.error, re); };
  bad({ type: '股票', name: 'x', amount: 1 }, /類別/);
  bad({ type: '存款', name: '', amount: 1 }, /名稱/);
  bad({ type: '存款', name: 'x', amount: -1 }, /金額/);
  bad({ type: '貸款', name: 'x', amount: 'abc' }, /剩餘本金/);
  bad({ type: '未上市', name: 'x', shares: 0, price: 1 }, /股數/);
  bad({ type: '存款', name: 'x', amount: 1, cur: 'BTC' }, /幣別/);
  bad({ type: '存款', name: 'x', amount: 1, rate: 150 }, /利率/);
  bad({ type: '存款', name: 'x', amount: 1, id: 'nope' }, /找不到/);
});

t('修改與刪除；不同類別的欄位不混用（存款的股數、非貸款的每月還款會清掉）', () => {
  const a = B.get({ action: 'assets' }).data.assets;
  const dep = a.find(x => x.name === '活存');
  assert.ok(B.post({ action: 'assetUpsert', asset: Object.assign({}, dep, { amount: 400000, shares: 99, monthly: 5, updated: '2026-11-01' }) }).ok);
  const d2 = B.get({ action: 'assets' }).data.assets.find(x => x.id === dep.id);
  assert.strictEqual(d2.amount, 400000); assert.strictEqual(d2.shares, null); assert.strictEqual(d2.monthly, null); assert.strictEqual(d2.updated, '2026-11-01');
  const tmp = B.post({ action: 'assetUpsert', asset: { type: '存款', name: '暫時', amount: 1 } }).data.id;
  assert.ok(B.post({ action: 'assetDelete', id: tmp }).ok);
  assert.ok(!B.get({ action: 'assets' }).data.assets.some(x => x.id === tmp));
  assert.strictEqual(B.post({ action: 'assetDelete', id: tmp }).ok, false);
});

t('在試算表手動輸入的列：沒有 ID 自動補上、別名類別與幣別、日期格子', () => {
  const sh = B.env.sheets['其他資產'];
  sh.rows.push(['', '保單', '手動保單', '', '美金', '1,000', '', '', '', '', '', new Date(Date.UTC(2026, 9, 1, 0, 0)), '']);
  sh.rows.push(['', '亂寫', '不會讀到', '', '', 5, '', '', '', '', '', '', '']);
  const a = B.get({ action: 'assets' }).data.assets;
  const m = a.find(x => x.name === '手動保單');
  assert.ok(m && m.id.length === 12); assert.strictEqual(m.type, '保險'); assert.strictEqual(m.cur, 'USD'); assert.strictEqual(m.amount, 1000);
  assert.strictEqual(m.updated, '2026-10-01');
  assert.ok(!a.some(x => x.name === '不會讀到'));
  assert.strictEqual(sh.rows.find(r => r[2] === '手動保單')[0], m.id, 'ID 寫回試算表');
  B.post({ action: 'assetDelete', id: m.id });
});

t('每日 13:30 紀錄：加上未上市／保險／存款／貸款與淨資產（獨立計算核對）', () => {
  B.post({ action: 'upsert', holding: { code: '2330', shares: 1000, cost: 600, name: '台積電' } });
  NOW = TPE(11, 9, 13, 31); B.env.ctx.recordTick();
  const rows = B.env.sheets['每日市值'].rows;
  assert.strictEqual(rows[0].length, 22); assert.strictEqual(rows[0][19], '淨資產');
  const r = rows[1];
  const unl = Math.round(2000 * 45.5), ins = Math.round(12000 * 30.62 + 3000000 * 0.2012), dep = Math.round(400000 + 10000 * 20.15), loan = 3200000;
  assert.deepStrictEqual(r.slice(15, 19), [unl, ins, dep, loan]);
  assert.strictEqual(r[19], r[2] + unl + ins + dep - loan);
  assert.strictEqual(r[20], '', '第一筆沒有前日');
  const det = B.env.sheets['市值明細'].rows.slice(1);
  const loanRow = det.find(x => x[3] === '貸款');
  assert.strictEqual(loanRow[8], -3200000, '貸款在明細是負數');
  const unlRow = det.find(x => x[3] === '未上市');
  assert.strictEqual(unlRow[10], Math.round(2000 * 45.5 - 60000), '未上市損益');
  console.log('   淨資產', r[19], '＝股票', r[2], '+未上市', unl, '+保險', ins, '+存款', dep, '−貸款', loan);
});

t('隔天：淨資產變化；手動更新存款也反映；資產列不會被誤判成「持股有變動」', () => {
  const dep = B.get({ action: 'assets' }).data.assets.find(x => x.name === '活存');
  B.post({ action: 'assetUpsert', asset: Object.assign({}, dep, { amount: 450000 }) });
  NOW = TPE(11, 10, 13, 31); B.env.ctx.recordTick();
  const rows = B.env.sheets['每日市值'].rows.slice(1);
  const [p, c] = rows;
  assert.strictEqual(c[20], c[19] - p[19]);
  assert.strictEqual(c[17] - p[17], 50000 + Math.round(10000 * 20.15) - Math.round(10000 * 20.15));
  assert.ok(!/持股有變動/.test(c[14]), c[14]);
});

t('history：回傳淨資產欄位；detail=1 附上目前的資產清單', () => {
  const h = B.get({ action: 'history', detail: '1' }).data;
  assert.ok(h.rows.every(r => typeof r.net === 'number'));
  assert.strictEqual(h.rows[1].dNet, h.rows[1].net - h.rows[0].net);
  assert.strictEqual(h.assets.length, 6);
});

t('舊版的「每日市值」表（15 欄）會自動補上新欄位，舊資料不受影響；舊列的淨資產是空的', () => {
  NOW = TPE(11, 9, 8, 0);
  const C = backend();
  const sh = C.env.sheets['每日市值'];
  sh.rows = [sh.rows[0].slice(0, 15), ['2026-11-06', '13:31', 1000000, 1000000, 0, 0, '', 600000, 400000, 0.66, '', '', '', 1, '']];
  C.post({ action: 'upsert', holding: { code: '2330', shares: 1000, cost: 600, name: '台積電' } });
  C.post({ action: 'assetUpsert', asset: { type: '存款', name: '活存', amount: 100000 } });
  NOW = TPE(11, 9, 13, 31); C.env.ctx.recordTick();
  assert.strictEqual(sh.rows[0][20], '淨資產變化');
  assert.strictEqual(sh.rows[1][2], 1000000);
  const h = C.get({ action: 'history' }).data.rows;
  assert.strictEqual(h[0].net, null);
  assert.strictEqual(h[1].dNet, null, '前一筆沒有淨資產時不算變化');
  assert.strictEqual(h[1].net, h[1].total + 100000);
});

t('只有其他資產、沒有持股：照樣記錄淨資產', () => {
  NOW = TPE(11, 9, 8, 0);
  const D = backend();
  D.post({ action: 'assetUpsert', asset: { type: '存款', name: '活存', amount: 500000 } });
  D.post({ action: 'assetUpsert', asset: { type: '貸款', name: '信貸', amount: 200000 } });
  NOW = TPE(11, 9, 13, 31); D.env.ctx.recordTick();
  const r = D.env.sheets['每日市值'].rows[1];
  assert.ok(r, '有記錄'); assert.strictEqual(r[2], 0); assert.strictEqual(r[19], 300000);
});

t('匯率取不到的幣別：不計入淨資產並在備註寫明', () => {
  NOW = TPE(11, 9, 8, 0);
  const E = backend();
  E.post({ action: 'assetUpsert', asset: { type: '存款', name: '活存', amount: 100000 } });
  E.post({ action: 'assetUpsert', asset: { type: '存款', name: '英鎊', cur: 'GBP', amount: 1000 } });
  E.state.erDown = true;     // Yahoo 沒有 GBPTWD、備援也掛掉
  NOW = TPE(11, 9, 13, 31); E.env.ctx.recordTick();
  const r = E.env.sheets['每日市值'].rows[1];
  assert.strictEqual(r[17], 100000);
  assert.match(r[14], /GBP 匯率取不到，未計入淨資產/);
  E.state.erDown = false; E.env.clearCache();
  const f = E.get({ action: 'assets' }).data.fx;
  assert.ok(Math.abs(f.GBP - 30.7 / 0.79) < 1e-9, '備援來源換算交叉匯率');
});

// ---------------- 加密貨幣 ----------------
t('加密貨幣：新增 BTC／ETH，Yahoo 美元價 × 美元匯率換算台幣；名稱自動帶入', () => {
  NOW = TPE(11, 9, 8, 0);
  const C = backend();
  C.post({ action: 'assetUpsert', asset: { type: '存款', name: '活存', amount: 100000 } });
  let r = C.post({ action: 'assetUpsert', asset: { type: '加密貨幣', symbol: 'btc', shares: '0.5', cost: 1200000, inst: '幣安' } });
  assert.ok(r.ok, JSON.stringify(r));
  r = C.post({ action: 'assetUpsert', asset: { type: '加密貨幣', symbol: 'ETH-USD', name: '我的以太', shares: 2.25 } });
  assert.ok(r.ok, JSON.stringify(r));
  const d = C.get({ action: 'assets' }).data;
  const btc = d.assets.find(x => x.symbol === 'BTC'), eth = d.assets.find(x => x.symbol === 'ETH');
  assert.strictEqual(btc.name, '比特幣'); assert.strictEqual(btc.cur, 'TWD'); assert.strictEqual(btc.inst, '幣安');
  assert.strictEqual(eth.name, '我的以太');
  assert.strictEqual(btc.priceUsd, 102345.6); assert.strictEqual(btc.prevUsd, 100120.4);
  assert.ok(Math.abs(btc.price - 102345.6 * 30.62) < 1e-6, btc.price);
  assert.ok(Math.abs(eth.price - 3456.78 * 30.62) < 1e-6);
  assert.strictEqual(d.fx.USD, 30.62);
  assert.ok(d.types.includes('加密貨幣'));
  const row = C.env.sheets['其他資產'].rows.find(x => x[1] === '加密貨幣');
  assert.strictEqual(row[13], 'BTC'); assert.strictEqual(row[6], 0.5); assert.strictEqual(row[5], ''); assert.strictEqual(row[7], '');
  // 每日紀錄
  NOW = TPE(11, 9, 13, 31); C.env.ctx.recordTick();
  const day = C.env.sheets['每日市值'].rows;
  assert.strictEqual(day[0][21], '加密貨幣');
  const cry = Math.round(0.5 * 102345.6 * 30.62 + 2.25 * 3456.78 * 30.62);
  assert.strictEqual(day[1][21], cry);
  assert.strictEqual(day[1][19], 100000 + cry, '淨資產含加密貨幣');
  const det = C.env.sheets['市值明細'].rows.filter(x => x[3] === '加密貨幣');
  assert.strictEqual(det.length, 2);
  const b = det.find(x => x[1] === 'BTC');
  assert.deepStrictEqual(b.slice(4, 11), [0.5, 102345.6, 'USD', 51172.8, Math.round(0.5 * 102345.6 * 30.62), 1200000, Math.round(0.5 * 102345.6 * 30.62) - 1200000]);
  const h = C.get({ action: 'history', detail: '1' }).data;
  assert.strictEqual(h.rows[0].cry, cry);
  assert.ok(h.assets.find(x => x.symbol === 'BTC').price > 0, 'history detail 也有即時價');
  assert.ok(!/持股有變動/.test(day[1][14]));
  console.log('   加密貨幣', cry, '（BTC 0.5 + ETH 2.25）');
  globalThis.__C = C;
});

t('加密貨幣：輸入驗證（代號、數量、查不到的代號）；改數量不必再查報價', () => {
  const C = globalThis.__C;
  const bad = (a, re) => { const r = C.post({ action: 'assetUpsert', asset: a }); assert.strictEqual(r.ok, false, JSON.stringify(r)); assert.match(r.error, re); return r; };
  bad({ type: '加密貨幣', symbol: '', shares: 1 }, /代號/);
  bad({ type: '加密貨幣', symbol: 'B T C', shares: 1 }, /代號/);
  bad({ type: '加密貨幣', symbol: 'BTC', shares: 0 }, /數量/);
  const nf = bad({ type: '加密貨幣', symbol: 'NOPECOIN', shares: 1 }, /查不到 NOPECOIN/);
  assert.strictEqual(nf.code, 'not_found');
  const btc = C.get({ action: 'assets' }).data.assets.find(x => x.symbol === 'BTC');
  C.state.cryptoDown = true; C.env.clearCache();
  const r = C.post({ action: 'assetUpsert', asset: Object.assign({}, btc, { shares: 0.6 }) });
  assert.ok(r.ok, '只改數量：Yahoo 掛掉也能存 ' + JSON.stringify(r));
  bad({ type: '加密貨幣', symbol: 'SOL', shares: 1 }, /查不到 SOL/);
  C.state.cryptoDown = false;
});

t('加密貨幣：Yahoo 暫時抓不到時沿用最後價格；完全沒有價格就不計入並註明', () => {
  NOW = TPE(11, 9, 8, 0);
  const C = backend();
  C.post({ action: 'assetUpsert', asset: { type: '加密貨幣', symbol: 'BTC', shares: 1 } });
  C.get({ action: 'assets' });                    // 快取一次價格
  C.state.cryptoDown = true;
  NOW += 5 * 60e3;
  const a = C.get({ action: 'assets' }).data.assets[0];
  assert.strictEqual(a.priceUsd, 102345.6, '沿用最後價格');
  // 6 小時後快取也過期 → 不計入
  NOW = TPE(11, 9, 13, 31); C.env.clearCache();
  C.env.ctx.recordTick();
  const r = C.env.sheets['每日市值'].rows[1];
  assert.ok(r, '仍有記錄');
  assert.strictEqual(r[21], 0);
  assert.match(r[14], /BTC 報價取不到，未計入淨資產/);
  const a2 = C.get({ action: 'assets' }).data.assets[0];
  assert.strictEqual(a2.price, null);
});

t('加密貨幣：60 秒內多台裝置共用一次查價', () => {
  NOW = TPE(11, 9, 8, 0);
  const C = backend();
  C.post({ action: 'assetUpsert', asset: { type: '加密貨幣', symbol: 'BTC', shares: 1 } });
  C.post({ action: 'assetUpsert', asset: { type: '加密貨幣', symbol: 'ETH', shares: 1 } });
  NOW += 61e3; C.get({ action: 'assets' });
  C.env.resetFetchLog();
  for (let i = 0; i < 10; i++) { NOW += 10e3; C.get({ action: 'assets' }); }   // 100 秒、10 次讀取
  const q = C.env.fetchLog().filter(u => /BTC-USD|ETH-USD/.test(u));
  assert.strictEqual(q.length, 1, '100 秒內只在滿 60 秒時重查一次：' + q.join('\n'));
  assert.match(q[0], /BTC-USD%2CETH-USD|BTC-USD,ETH-USD/, '一次查兩個');
});

t('加密貨幣：試算表手動輸入（類別寫「虛擬貨幣」、代號留空但名稱寫 BTC）也讀得到；舊版 13 欄表自動補「代號」', () => {
  NOW = TPE(11, 9, 8, 0);
  const C = backend();
  const sh = C.env.sheets['其他資產'];
  sh.rows[0] = sh.rows[0].slice(0, 13);
  sh.rows.push(['', '虛擬貨幣', 'BTC', '冷錢包', '', '', 0.1, '', '', '', '', '', '']);
  const a = C.get({ action: 'assets' }).data.assets;
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].type, '加密貨幣'); assert.strictEqual(a[0].symbol, 'BTC'); assert.ok(a[0].price > 0);
  assert.strictEqual(sh.rows[0][13], '代號');
});

t('舊版 21 欄「每日市值」表會補上「加密貨幣」欄', () => {
  NOW = TPE(11, 9, 8, 0);
  const C = backend();
  const sh = C.env.sheets['每日市值'];
  sh.rows = [sh.rows[0].slice(0, 21)];
  C.post({ action: 'assetUpsert', asset: { type: '加密貨幣', symbol: 'ETH', shares: 1 } });
  NOW = TPE(11, 9, 13, 31); C.env.ctx.recordTick();
  assert.strictEqual(sh.rows[0][21], '加密貨幣');
  assert.strictEqual(sh.rows[1][21], Math.round(3456.78 * 30.62));
});

console.log(`\n${passed} passed`);
