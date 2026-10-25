// 端對端測試：真的 index.html ＋ 模擬環境裡跑真的 Code.gs
// 模擬 Apps Script 的實際行為：/exec 回 302 轉址到 script.googleusercontent.com，該處回 JSON 並帶 Access-Control-Allow-Origin: *
const { chromium, devices } = require('/opt/npm-tools/node_modules/playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { makeEnv } = require('./gas-mock');
const { makeHandler } = require('./fixtures');

const WEB = path.join(__dirname, '../docs');
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const EXEC = 'https://script.google.com/macros/s/AKfycbTEST/exec';

const state = {};
const env = makeEnv(makeHandler(state));
const token = env.ctx.setup();
let backendDown = false;
let options = 0;
const pending = {};

const https = require('https');
const tls = { key: fs.readFileSync(__dirname + '/key.pem'), cert: fs.readFileSync(__dirname + '/cert.pem') };
// script.google.com：執行 doGet/doPost 後 302 轉到 googleusercontent（與真實 Apps Script 相同流程）
const execServer = https.createServer(tls, (req, res) => {
  if (req.method === 'OPTIONS') { options++; res.writeHead(405); return res.end(); }
  if (backendDown) { req.socket.destroy(); return; }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const u = new URL(req.url, 'https://script.google.com');
    const out = req.method === 'GET' ? env.get(Object.fromEntries(u.searchParams)) : env.post(JSON.parse(body || '{}'));
    const id = Math.random().toString(36).slice(2);
    pending[id] = out;
    // 與真實 Apps Script 相同：/exec 回 302（帶 CORS 標頭），瀏覽器跟著轉址到 googleusercontent 取結果
    setTimeout(() => { res.writeHead(302, { location: 'https://script.googleusercontent.com/macros/echo?user_content_key=' + id, 'access-control-allow-origin': '*' }); res.end(); }, 120);
  });
});
const echoServer = https.createServer(tls, (req, res) => {
  const id = new URL(req.url, 'https://x').searchParams.get('user_content_key');
  const body = JSON.stringify(pending[id] || { ok: false, error: 'expired' }); delete pending[id];
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }); res.end(body);
});
const server = http.createServer((req, res) => {
  const p = path.join(WEB, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!p.startsWith(WEB) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  const type = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }[path.extname(p)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type }); fs.createReadStream(p).pipe(res);
});

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('✓', name); }
  catch (e) { failed++; console.log('✗', name); console.log(e.message.split('\n').slice(0, 6).join('\n')); }
}

async function setupRoutes(ctx) {
  await ctx.route('https://fonts.googleapis.com/**', r => r.abort());     // 測試字型載不到時的備用字型
  await ctx.route('https://fonts.gstatic.com/**', r => r.abort());
  await ctx.route('https://news.google.com/**', r => r.fulfill({ status: 200, body: 'news page' }));
}

(async () => {
  await new Promise(r => server.listen(8765, r));
  await new Promise(r => execServer.listen(8443, r));
  await new Promise(r => echoServer.listen(8444, r));
  const BASE = 'http://localhost:8765/';
  const browser = await chromium.launch({ args: ['--no-proxy-server', '--ignore-certificate-errors', '--host-resolver-rules=MAP script.google.com:443 127.0.0.1:8443, MAP script.googleusercontent.com:443 127.0.0.1:8444'] });
  const iphone = Object.assign({}, devices['iPhone 13'], { locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  // devices['iPhone 13'] 預設 webkit；這裡用 chromium 跑手機尺寸與觸控
  delete iphone.defaultBrowserType;
  const ctx = await browser.newContext(iphone);
  await setupRoutes(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|ERR_FAILED|net::/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', d => d.accept());

  await t('首次開啟：顯示連線引導，沒有「新增持股」按鈕', async () => {
    await page.goto(BASE);
    await page.waitForSelector('.welcome');
    assert.ok(await page.isHidden('#fab'));
    await page.screenshot({ path: OUT + '/01-welcome-iphone.png' });
  });

  await t('設定：錯誤網址與空金鑰會擋下', async () => {
    await page.click('#btnSettings');
    await page.fill('#sUrl', 'https://example.com/x');
    await page.click('#btnTest');
    assert.match(await page.textContent('#eSet'), /script\.google\.com/);
    await page.fill('#sUrl', EXEC);
    await page.fill('#sToken', '');
    await page.click('#btnTest');
    assert.match(await page.textContent('#eSet'), /金鑰/);
  });

  await t('設定：金鑰錯誤 → 明確錯誤訊息', async () => {
    await page.fill('#sToken', 'wrong');
    await page.click('#btnTest');
    await page.waitForFunction(() => !document.querySelector('#eSet').classList.contains('hidden'));
    assert.match(await page.textContent('#eSet'), /存取金鑰不正確/);
  });

  await t('設定：測試連線顯示各資料來源 ✓，儲存後顯示空持倉', async () => {
    await page.fill('#sToken', token);
    await page.click('#btnTest');
    await page.waitForSelector('#diag li:nth-child(7)');
    const txt = await page.textContent('#diag');
    assert.ok(!txt.includes('✗'), txt);
    await page.screenshot({ path: OUT + '/02-settings-diag.png' });
    await page.click('#btnSaveSet');
    await page.waitForSelector('text=還沒有持股');
    assert.ok(await page.isVisible('#fab'));
  });

  const adds = [
    { code: '2330', shares: '2,000', cost: '612.5' },
    { code: '0050', shares: '1500', cost: '150.33' },
    { code: '6488', shares: '100', cost: '500' },
    { code: 'aapl', shares: '10', cost: '180' },
    { code: 'NVDA', shares: '25', cost: '120.5', keyword: '輝達' },
  ];
  await t('新增持股：查詢帶入名稱（上市/上櫃/美股），0050 前導零保留', async () => {
    for (const a of adds) {
      await page.click('#fab');
      await page.fill('#fCode', a.code);
      await page.click('#btnLookup');
      await page.waitForSelector('#found:not(.hidden)');
      await page.fill('#fShares', a.shares);
      await page.fill('#fCost', a.cost);
      if (a.keyword) await page.fill('#fKeyword', a.keyword);
      if (a.code === '6488') await page.screenshot({ path: OUT + '/03-add-form.png' });
      await page.click('#btnSave');
      await page.waitForFunction(() => !document.querySelector('#dlgEdit').open);
      await page.waitForFunction(c => [...document.querySelectorAll('.hcode')].some(e => e.textContent === c), a.code.toUpperCase());
    }
    const codes = env.sheets['持倉'].rows.slice(1).map(r => r[0]);
    assert.deepStrictEqual(codes, ['2330', '0050', '6488', 'AAPL', 'NVDA']);
    const names = env.sheets['持倉'].rows.slice(1).map(r => r[2]);
    assert.deepStrictEqual(names.slice(0, 3), ['台積電', '元大台灣50', '環球晶']);
  });

  await t('新增：錯誤代號與空白欄位的即時提示', async () => {
    await page.click('#fab');
    await page.fill('#fCode', '台積電');
    await page.click('#btnSave');
    assert.match(await page.textContent('#eCode'), /代號格式/);
    assert.match(await page.textContent('#eShares'), /股數/);
    await page.fill('#fCode', '9999');
    await page.click('#btnLookup');
    await page.waitForFunction(() => /查不到/.test(document.querySelector('#eCode').textContent));
    await page.click('#dlgEdit [data-close]');
  });

  await t('總市值／今日損益／未實現損益與獨立計算一致（含預估賣出費用、匯率）', async () => {
    await page.waitForFunction(() => !document.querySelector('#btnRefresh').classList.contains('spin'));
    const fx = 30.62;
    const fee = (code, sh, mv) => {
      const f = Math.max(Math.floor(mv * 0.001425), sh % 1000 === 0 ? 20 : 1);
      const rate = code.startsWith('00') ? 0.001 : 0.003;
      return f + Math.floor(mv * rate);
    };
    const tw = [['2330', 2000, 612.5, 1085, 1070], ['0050', 1500, 150.33, 196.48, 195.2], ['6488', 100, 500, 420.5, 415]];
    const us = [['AAPL', 10, 180, 268.81, 262.24], ['NVDA', 25, 120.5, 186.26, 180.28]];
    let mv = 0, pnl = 0, day = 0, cost = 0;
    tw.forEach(([c, s, co, p, y]) => { const m = p * s; mv += m; pnl += m - fee(c, s, m) - co * s; cost += co * s; day += (p - y) * s; });
    us.forEach(([c, s, co, p, y]) => { mv += p * s * fx; pnl += (p - co) * s * fx; cost += co * s * fx; day += (p - y) * s * fx; });
    const n = (s) => Number(s.replace(/[^\d.\-−]/g, '').replace('−', '-'));
    const total = n(await page.textContent('#total'));
    const kPnl = n(await page.textContent('#kPnl'));
    const kDay = n(await page.$eval('#kDay', e => e.firstChild.textContent));
    assert.strictEqual(await page.textContent('#kDay i'), '+' + (day / (mv - day) * 100).toFixed(2) + '%');
    assert.strictEqual(total, Math.round(mv), 'total ' + total + ' vs ' + mv);
    assert.strictEqual(kPnl, Math.round(pnl), 'pnl ' + kPnl + ' vs ' + pnl);
    assert.strictEqual(kDay, Math.round(day), 'day ' + kDay + ' vs ' + day);
    const pctShown = await page.textContent('#kPct');
    assert.strictEqual(pctShown, '+' + (pnl / cost * 100).toFixed(2) + '%');
    console.log('   總市值', Math.round(mv), '未實現', Math.round(pnl), '今日', Math.round(day), pctShown);
    await page.screenshot({ path: OUT + '/04-holdings-iphone.png', fullPage: true });
  });

  await t('比重條：5 段、依市值排序、可點開個股', async () => {
    const n = await page.$$eval('#strip span', s => s.length);
    const names = await page.$$eval('.hname .nm', e => e.map(x => x.textContent));
    assert.ok(names.includes('NVIDIA') && names.includes('Apple'), names.join());
    assert.ok(await page.isVisible('.hrow:has(.hcode:text-is("NVDA")) .tag'), '長名稱時「美股」標籤仍可見');
    const kpiTops = await page.$$eval('.kpi', k => k.map(x => x.getBoundingClientRect().top));
    assert.ok(kpiTops.every(t => t === kpiTops[0]), '三個數字在同一列');
    assert.strictEqual(n, 5);
    await page.click('#strip span:first-child');
    await page.waitForSelector('#dlgDetail[open]');
    assert.match(await page.textContent('#detTitle'), /台積電/);
    await page.screenshot({ path: OUT + '/05-detail-iphone.png' });
    await page.click('#dlgDetail [data-close]');
  });

  await t('台股 0050 無成交時標示「用買賣中價」', async () => {
    await page.click('.hrow:has(.hcode:text-is("0050"))');
    await page.waitForSelector('#dlgDetail[open]');
    assert.match(await page.textContent('#detQuote'), /買賣中價/);
    assert.match(await page.textContent('#detStats'), /已扣預估賣出費用/);
    await page.click('#dlgDetail [data-close]');
  });

  await t('新聞頁：依日期分組、篩選、冷門股放寬提示、美股含英文', async () => {
    await page.click('#tabNews');
    await page.waitForSelector('.nitem');
    const groups = await page.$$eval('.day', d => d.map(x => x.textContent));
    assert.ok(groups[0] === '今天', groups.join());
    const all = await page.$$eval('#newsList .nitem', a => a.length);
    await page.screenshot({ path: OUT + '/06-news-iphone.png', fullPage: true });
    await page.click('#chips .chip:has-text("環球晶")');
    assert.match(await page.textContent('#newsList'), /放寬到 7 天/);
    await page.click('#chips .chip:has-text("Apple")');
    assert.ok(await page.$$eval('#newsList .tag', t => t.some(x => x.textContent === '英文')));
    const aaplLinks = await page.$$eval('#newsList a', a => a.map(x => [x.target, x.rel]));
    assert.ok(aaplLinks.every(([t, r]) => t === '_blank' && r.includes('noopener')));
    await page.click('#chips .chip:has-text("全部")');
    assert.strictEqual(await page.$$eval('#newsList .nitem', a => a.length), all);
    await page.click('#tabHold');
  });

  await t('持股列：7 天內的時程顯示徽章（台積電 5 天後法說、Apple 4 天後財報），10 天後的不顯示', async () => {
    await page.waitForFunction(() => document.querySelector('#eventsUpdated') && /更新於/.test(document.querySelector('#eventsUpdated').textContent));
    const badge = async (code) => page.$eval(`.hrow:has(.hcode:text-is("${code}"))`, r => { const b = r.querySelector('.ev-badge'); return b ? b.textContent : null; }).catch(() => null);
    assert.strictEqual(await badge('2330'), '5天後法說');
    assert.strictEqual(await badge('AAPL'), '4天後財報');
    assert.strictEqual(await badge('0050'), null);
  });

  await t('時程頁：分組、法說會時間地點、除息預計領取金額、上櫃權息、美股盤後與預估區間、已過標示', async () => {
    await page.click('#tabEvents');
    await page.waitForSelector('#eventsList .ev');
    const txt = await page.textContent('#eventsList');
    assert.match(txt, /台積電 法說會.*14:00.*線上法說會/);
    assert.match(txt, /元大台灣50 除息現金股利 1\.00 元／股，預計領 NT\$1,500/);
    assert.match(txt, /環球晶 除權息現金股利 4\.50 元／股，預計領 NT\$450.*每千股配 50 股/);
    assert.match(txt, /Apple 財報公布盤後公布（台灣時間隔天清晨）/);
    assert.match(txt, /NVIDIA 財報公布預估 \d+\/\d+～\d+\/\d+ 之間/);
    assert.match(txt, /Apple 除息已過上次配息 US\$0\.26／股，預計約 US\$2\.60（約 NT\$80）/);
    assert.match(txt, /第三季財報公告期限|月營收公布期限/);
    const dl = await page.$$eval('#eventsList .ev', evs => evs.filter(e => e.querySelector('.t-deadline')).map(e => e.querySelector('.evmeta').textContent));
    assert.ok(dl.length && dl.every(m => !m.includes('元大台灣50')), 'ETF 不該出現在公告期限');
    const days = await page.$$eval('.evday span:first-child', d => d.map(x => x.textContent));
    assert.ok(days.length >= 5);
    await page.screenshot({ path: OUT + '/11-events-iphone.png', fullPage: true });
    await page.click('#evChips .chip:has-text("財報")');
    const types = await page.$$eval('#eventsList .evtag', t => [...new Set(t.map(x => x.textContent))]);
    assert.deepStrictEqual(types, ['財報']);
    await page.click('#evChips .chip:has-text("全部")');
  });

  await t('個股明細顯示近期時程', async () => {
    await page.click('#tabHold');
    await page.click('.hrow:has(.hcode:text-is("2330"))');
    await page.waitForSelector('#dlgDetail[open]');
    assert.ok(await page.isVisible('#detEventsWrap'));
    assert.match(await page.textContent('#detEvents'), /法說會/);
    await page.click('#dlgDetail [data-close]');
  });

  await t('編輯：改股數後損益更新；試算表同步', async () => {
    await page.click('.hrow:has(.hcode:text-is("6488"))');
    await page.click('#btnEdit');
    assert.strictEqual(await page.inputValue('#fShares'), '100');
    await page.fill('#fShares', '1000');
    await page.click('#btnSave');
    await page.waitForFunction(() => /1,000 股/.test([...document.querySelectorAll('.hrow')].find(r => r.textContent.includes('6488')).textContent));
    assert.strictEqual(env.sheets['持倉'].rows.find(r => r[0] === '6488')[3], 1000);
  });

  await t('刪除：確認後從畫面與試算表移除', async () => {
    await page.click('.hrow:has(.hcode:text-is("6488"))');
    await page.click('#btnDelete');
    await page.waitForFunction(() => ![...document.querySelectorAll('.hcode')].some(e => e.textContent === '6488'));
    assert.ok(!env.sheets['持倉'].rows.some(r => r[0] === '6488'));
    await page.click('#tabEvents');
    await page.waitForFunction(() => !/環球晶/.test(document.querySelector('#eventsList').textContent));
    await page.click('#tabHold');
  });

  await t('排序：依今日漲跌', async () => {
    await page.selectOption('#sortSel', 'day');
    const codes = await page.$$eval('.hcode', e => e.map(x => x.textContent));
    assert.deepStrictEqual(codes, ['NVDA', 'AAPL', '2330', '0050']);
  });

  await t('設定：漲跌顏色切換為國際習慣', async () => {
    await page.click('#btnSettings');
    await page.selectOption('#sColor', 'intl');
    await page.click('#btnSaveSet');
    const col = await page.$eval('.hprice.up', e => getComputedStyle(e).color);
    assert.strictEqual(col, 'rgb(23, 138, 76)');
    await page.click('#btnSettings'); await page.selectOption('#sColor', 'tw'); await page.click('#btnSaveSet');
  });

  let shareCode;
  await t('分享設定碼 → 另一台裝置貼上即可用（同一份持倉）', async () => {
    await page.click('#btnSettings');
    await page.evaluate(() => { navigator.share = undefined; });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    await page.click('#btnShare');
    await page.waitForTimeout(300);
    shareCode = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(shareCode, /^SHN1:/);
    await page.click('#dlgSettings [data-close]');
    const ctx2 = await browser.newContext(Object.assign({}, devices['Desktop Chrome'], { locale: 'zh-TW', viewport: { width: 1280, height: 860 } }));
    await setupRoutes(ctx2);
    const p2 = await ctx2.newPage();
    await p2.goto(BASE);
    await p2.click('.welcome .btn');
    await p2.fill('#sCode', shareCode);
    assert.strictEqual(await p2.inputValue('#sUrl'), EXEC);
    await p2.click('#btnSaveSet');
    await p2.waitForSelector('.hrow');
    await p2.waitForSelector('#newsList .nitem');
    assert.strictEqual(await p2.$$eval('.hrow', r => r.length), 4);
    await p2.screenshot({ path: OUT + '/07-desktop.png' });
    await ctx2.close();
  });

  await t('#setup= 連結自動套用，套用後網址列清掉設定碼', async () => {
    const ctx3 = await browser.newContext(Object.assign({}, devices['Desktop Chrome'], { colorScheme: 'dark', viewport: { width: 1280, height: 860 } }));
    await setupRoutes(ctx3);
    const p3 = await ctx3.newPage();
    await p3.goto(BASE + '#setup=' + encodeURIComponent(shareCode));
    await p3.waitForSelector('.hrow');
    assert.ok(!p3.url().includes('setup'));
    await p3.waitForSelector('#newsList .nitem');
    await p3.screenshot({ path: OUT + '/08-desktop-dark.png' });
    await ctx3.close();
  });

  await t('後端斷線：保留上次資料並提示，可重試', async () => {
    backendDown = true;
    await page.click('#btnRefresh');
    await page.waitForSelector('.notice.err');
    assert.match(await page.textContent('.notice.err'), /連不到後端.*上次的資料/);
    assert.strictEqual(await page.textContent('.notice.err button'), '重試', '網路問題要給「重試」，不是「設定」');
    assert.strictEqual(await page.$$eval('.hrow', r => r.length), 4);
    await page.screenshot({ path: OUT + '/09-offline.png' });
    backendDown = false;
    await page.click('.notice.err button');
    await page.waitForFunction(() => !document.querySelector('.notice.err'));
  });

  await t('報價來源全掛 → 個股顯示無報價、合計排除並提示', async () => {
    env.clearCache(); state.misDown = true; state.yahooDown = true;
    await page.click('#btnRefresh');
    await page.waitForSelector('text=沒有報價，未計入合計');
    state.misDown = false; state.yahooDown = false; env.clearCache();
    await page.click('#btnRefresh');
    await page.waitForFunction(() => !/沒有報價/.test(document.querySelector('#notices').textContent));
  });

  await t('匯率取不到 → 用上次匯率並標示', async () => {
    env.clearCache(); state.fxYahooDown = true; state.erDown = true;
    await page.click('#btnRefresh');
    await page.waitForSelector('text=先用上次的匯率');
    state.fxYahooDown = false; state.erDown = false; env.clearCache();
  });

  await t('重新開啟 App：先顯示快取資料（不需等網路）', async () => {
    backendDown = true;
    await page.reload();
    await page.waitForSelector('.hrow');
    assert.strictEqual(await page.$$eval('.hrow', r => r.length), 4);
    backendDown = false;
  });

  await t('沒有任何 CORS 預檢（OPTIONS）請求、沒有 JS 錯誤', async () => {
    assert.strictEqual(options, 0);
    assert.deepStrictEqual(errors, []);
  });

  await t('iPhone SE 窄螢幕（320px）沒有橫向捲動', async () => {
    const ctx4 = await browser.newContext(Object.assign({}, devices['iPhone SE'], { locale: 'zh-TW' }));
    delete ctx4.defaultBrowserType;
    await setupRoutes(ctx4);
    const p4 = await ctx4.newPage();
    await p4.goto(BASE + '#setup=' + encodeURIComponent(shareCode));
    await p4.waitForSelector('.hrow');
    const over = await p4.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(over <= 0, 'overflow ' + over);
    await p4.screenshot({ path: OUT + '/10-iphone-se.png' });
    await ctx4.close();
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  await browser.close(); server.close(); execServer.close(); echoServer.close();
  process.exit(failed ? 1 : 0);
})();
