const assert = require('assert');
const { makeEnv } = require('./gas-mock');
const { makeHandler } = require('./fixtures');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('✓', name); }
  catch (e) { console.log('✗', name); console.log(e); process.exitCode = 1; }
}

const state = {};
const env = makeEnv(makeHandler(state));
const token = env.ctx.setup();

t('setup 建立持倉表、代號欄為文字、產生金鑰', () => {
  assert.ok(env.sheets['持倉']);
  assert.strictEqual(env.sheets['持倉'].fmt[1], '@');
  assert.ok(token.length >= 32);
  assert.strictEqual(env.sheets['說明'].rows[0][1], token);
  assert.strictEqual(env.ctx.setup(), token, '重跑 setup 不換金鑰');
});

t('金鑰錯誤/缺少 → bad_token，回傳仍是 JSON', () => {
  assert.deepStrictEqual([env.get({ action: 'data' }).code, env.get({ action: 'data', token: 'x' }).code], ['bad_token', 'bad_token']);
  assert.strictEqual(env.post({ action: 'upsert', token: 'nope' }).ok, false);
});

t('空持倉 data', () => {
  const r = env.get({ action: 'data', token });
  assert.ok(r.ok); assert.deepStrictEqual(r.data.holdings, []);
});

t('新增持倉：0050 / 00878 保留前導零、代號正規化', () => {
  const adds = [
    { code: '2330', shares: '2,000', cost: '612.5', name: '' },
    { code: '0050', shares: 1500, cost: 150.33 },
    { code: '00878', shares: 3000, cost: 20.1 },
    { code: '6488', shares: 100, cost: 500 },
    { code: ' aapl ', shares: 10, cost: 180 },
    { code: 'nvda', shares: 25, cost: 120.5, keyword: '輝達' },
    { code: 'BRK-B', shares: 3, cost: 400 },
  ];
  adds.forEach(h => { const r = env.post({ action: 'upsert', token, holding: h }); assert.ok(r.ok, JSON.stringify(r)); });
  const codes = env.sheets['持倉'].rows.slice(1).map(r => r[0]);
  assert.deepStrictEqual(codes, ['2330', '0050', '00878', '6488', 'AAPL', 'NVDA', 'BRK.B']);
  codes.forEach(c => assert.strictEqual(typeof c, 'string'));
  const hs = env.get({ action: 'data', token }).data.holdings;
  assert.deepStrictEqual(hs.map(h => h.market), ['TW', 'TW', 'TW', 'TW', 'US', 'US', 'US']);
  assert.strictEqual(hs[0].shares, 2000);
});

t('輸入驗證：錯誤代號、股數 0、負成本', () => {
  assert.match(env.post({ action: 'upsert', token, holding: { code: '台積電', shares: 1, cost: 1 } }).error, /代號格式/);
  assert.match(env.post({ action: 'upsert', token, holding: { code: '2330', shares: 0, cost: 1 } }).error, /股數/);
  assert.match(env.post({ action: 'upsert', token, holding: { code: '2330', shares: 1, cost: -1 } }).error, /成本/);
});

t('重複新增同代號 → 更新而不是多一列；編輯改代號撞到既有 → 擋下', () => {
  env.post({ action: 'upsert', token, holding: { code: '2330', shares: 3000, cost: 600 } });
  const rows = env.sheets['持倉'].rows.slice(1).filter(r => r[0] === '2330');
  assert.strictEqual(rows.length, 1); assert.strictEqual(rows[0][3], 3000);
  const r = env.post({ action: 'upsert', token, originalCode: '6488', holding: { code: '2330', shares: 1, cost: 1 } });
  assert.match(r.error, /已經在持倉/);
});

t('報價：上市、上櫃、z 為「-」改用買賣中價、無成交用昨收、美股 Yahoo', () => {
  env.clearCache();
  const r = env.get({ action: 'data', token });
  const q = r.data.quotes;
  assert.strictEqual(q['2330'].price, 1085); assert.strictEqual(q['2330'].prevClose, 1070); assert.strictEqual(q['2330'].exchange, 'TWSE');
  assert.strictEqual(q['6488'].exchange, 'OTC'); assert.strictEqual(q['6488'].name, '環球晶');
  assert.strictEqual(q['0050'].priceType, 'mid'); assert.strictEqual(q['0050'].price, 196.48);
  assert.strictEqual(q['00878'].price, 22.05);
  assert.strictEqual(q['AAPL'].price, 268.81); assert.strictEqual(q['AAPL'].prevClose, 262.24);
  assert.strictEqual(q['NVDA'].prevClose, 180.28, 'previousClose 沒有時用 chartPreviousClose');
  assert.strictEqual(q['BRK.B'].price, 489.1, 'BRK.B 轉成 Yahoo 的 BRK-B');
  assert.strictEqual(r.data.fx.rate, 30.62);
});

t('快取：15 秒內第二次不再打外部', () => {
  env.resetFetchLog();
  env.get({ action: 'data', token });
  assert.strictEqual(env.fetchLog().length, 0);
});

t('MIS 掛掉 → 台股改用 Yahoo（.TW，上櫃再試 .TWO），查不到的回 error 不拖垮整體', () => {
  env.clearCache(); state.misDown = true;
  const q = env.get({ action: 'data', token }).data.quotes;
  assert.strictEqual(q['2330'].source, 'Yahoo'); assert.strictEqual(q['2330'].price, 1084);
  assert.strictEqual(q['6488'].price, 420);
  assert.ok(q['0050'].error, '0050 兩邊都查不到 → 個別錯誤');
  assert.ok(!q['AAPL'].error);
  state.misDown = false;
});

t('Yahoo query1 被限流 429 → 改用 query2', () => {
  env.clearCache(); state.yahoo429 = true;
  const q = env.get({ action: 'data', token }).data.quotes;
  assert.strictEqual(q['AAPL'].price, 268.81);
  state.yahoo429 = false;
});

t('匯率：Yahoo 失敗 → open.er-api；兩者都失敗 → fx 為 null', () => {
  env.clearCache(); state.fxYahooDown = true;
  assert.strictEqual(env.get({ action: 'data', token }).data.fx.rate, 30.7);
  env.clearCache(); state.erDown = true;
  assert.strictEqual(env.get({ action: 'data', token }).data.fx, null);
  state.fxYahooDown = false; state.erDown = false;
});

t('lookup：查名稱、錯誤代號', () => {
  env.clearCache();
  assert.strictEqual(env.get({ action: 'lookup', token, code: '6488' }).data.name, '環球晶');
  assert.strictEqual(env.get({ action: 'lookup', token, code: '9999' }).code, 'not_found');
  assert.match(env.get({ action: 'lookup', token, code: '%%' }).error, /代號格式/);
});

t('新聞：標題去尾巴來源、HTML 實體解碼、去重、依時間排序、美股中英合併', () => {
  env.clearCache();
  // 先把台股名稱補進試算表（實際上前端新增時會帶入查到的名稱）
  env.post({ action: 'upsert', token, holding: { code: '2330', shares: 3000, cost: 600, name: '台積電' } });
  env.post({ action: 'upsert', token, holding: { code: '6488', shares: 100, cost: 500, name: '環球晶' } });
  env.post({ action: 'upsert', token, holding: { code: '0050', shares: 1500, cost: 150.33, name: '元大台灣50' } });
  const r = env.get({ action: 'news', token, days: '1' });
  assert.ok(r.ok, JSON.stringify(r));
  const n = r.data.news;
  const tsmc = n['2330'].items;
  assert.strictEqual(tsmc[0].title, '台積電法說會釋利多 外資連三買');
  assert.strictEqual(tsmc[0].source, '經濟日報');
  assert.ok(tsmc.some(i => i.title === '台積電 2 奈米量產進度超前 & 美國廠擴產'));
  assert.ok(!tsmc.some(i => i.source === 'Yahoo奇摩股市'), '只差標點的重複新聞要去掉');
  for (let i = 1; i < tsmc.length; i++) assert.ok(tsmc[i - 1].time >= tsmc[i].time);
  const aapl = n['AAPL'].items;
  assert.ok(aapl.some(i => i.lang === 'en') && aapl.some(i => i.lang === 'zh'));
  assert.ok(n['NVDA'].items.some(i => i.title.includes('輝達')), '自訂關鍵字');
});

t('新聞：一天內不足 3 則自動放寬到 7 天並標記', () => {
  const n = env.get({ action: 'news', token, days: '1' }).data.news['6488'];
  assert.strictEqual(n.widened, true); assert.strictEqual(n.days, 7);
  assert.strictEqual(n.items.length, 3);
});

t('新聞：英文關閉 (en=0) 美股只抓中文', () => {
  env.clearCache();
  const n = env.get({ action: 'news', token, days: '1', en: '0', codes: 'AAPL' }).data.news;
  assert.deepStrictEqual(Object.keys(n), ['AAPL']);
  assert.ok(n['AAPL'].items.every(i => i.lang === 'zh'));
});

t('新聞：Google 新聞掛掉 → 每檔回 error，不快取錯誤結果', () => {
  env.clearCache(); state.newsDown = true;
  const n = env.get({ action: 'news', token, days: '1' }).data.news;
  assert.ok(Object.values(n).every(x => x.error && x.items.length === 0));
  assert.ok(!Object.keys(env.cacheStore).some(k => k.startsWith('n:')));
  state.newsDown = false;
});

t('使用者在試算表手動輸入：代號被存成數字、逗號數字、重複列、空白列', () => {
  const sh = env.sheets['持倉'];
  sh.rows.push([2412, '', '中華電', '1,000', '120', '', '']);  // 數字代號
  sh.rows.push(['', '', '', '', '', '', '']);                    // 空白列
  sh.rows.push(['2330', 'TW', '台積電(重複)', 1, 1, '', '']);    // 重複
  const hs = env.get({ action: 'data', token }).data.holdings;
  const cht = hs.find(h => h.code === '2412');
  assert.ok(cht); assert.strictEqual(cht.shares, 1000);
  assert.strictEqual(hs.filter(h => h.code === '2330').length, 1);
  assert.strictEqual(env.get({ action: 'data', token }).data.quotes['2412'].priceType, 'prevClose');
});

t('刪除：連重複列一起刪、刪不存在的代號回錯誤', () => {
  const r = env.post({ action: 'delete', token, code: '2330' });
  assert.ok(r.ok); assert.strictEqual(r.data.rows, 2);
  assert.ok(!env.sheets['持倉'].rows.some(x => x[0] === '2330'));
  assert.strictEqual(env.post({ action: 'delete', token, code: '2330' }).ok, false);
});

t('diagnose 回報各來源狀態', () => {
  const r = env.get({ action: 'diagnose', token });
  assert.ok(r.ok); assert.ok(r.data.checks.every(c => c.ok), JSON.stringify(r.data.checks));
  state.misDown = true;
  const r2 = env.get({ action: 'diagnose', token });
  assert.strictEqual(r2.data.checks.find(c => c.name === '證交所 MIS').ok, false);
  state.misDown = false;
});

t('試算表沒填名稱的台股 → 新聞用報價名稱搜尋', () => {
  env.clearCache();
  env.post({ action: 'upsert', token, holding: { code: '2330', shares: 1000, cost: 600, name: '' } });
  const n = env.get({ action: 'news', token, codes: '2330' }).data.news['2330'];
  assert.ok(n.items.length >= 3 && n.items[0].title.includes('台積電'));
});

t('POST 內容不是 JSON → 友善錯誤', () => {
  const out = JSON.parse(env.ctx.doPost({ postData: { contents: 'garbage' } }).getContent());
  assert.strictEqual(out.ok, false); assert.match(out.error, /資料格式/);
});

t('未執行 setup → not_setup', () => {
  const e2 = makeEnv(makeHandler({}));
  assert.strictEqual(e2.get({ action: 'data', token: 'x' }).code, 'not_setup');
});

console.log(`\n${passed} passed`);
