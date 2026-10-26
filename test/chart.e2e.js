// 走勢圖端對端測試：瀏覽器與模擬後端用同一個「假時鐘」，重現台股盤中、美股盤中、收盤、休市日、額度用完
const { chromium, devices } = require('/opt/npm-tools/node_modules/playwright');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { makeEnv } = require('./gas-mock');
const fx = require('./fixtures');

const WEB = path.join(__dirname, '../docs');
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const EXEC = 'https://script.google.com/macros/s/AKfycbTEST/exec';

let NOW = 0;
fx.setClock(() => NOW);
let cur = null;                 // 目前使用中的模擬後端
const counts = {};
const pending = {};
const tls = { key: fs.readFileSync(__dirname + '/key.pem'), cert: fs.readFileSync(__dirname + '/cert.pem') };
const execServer = https.createServer(tls, (req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const u = new URL(req.url, 'https://script.google.com');
    const params = Object.fromEntries(u.searchParams);
    if (params.action) counts[params.action] = (counts[params.action] || 0) + 1;
    const out = req.method === 'GET' ? cur.env.get(params) : cur.env.post(JSON.parse(body || '{}'));
    const id = Math.random().toString(36).slice(2);
    pending[id] = out;
    setTimeout(() => { res.writeHead(302, { location: 'https://script.googleusercontent.com/macros/echo?user_content_key=' + id, 'access-control-allow-origin': '*' }); res.end(); }, 60);
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
  catch (e) { failed++; console.log('✗', name); console.log(String(e.message).split('\n').slice(0, 8).join('\n')); }
}
const TPE = (mo, d, hh, mm) => Date.UTC(2026, mo - 1, d, hh, mm) - 8 * 3600e3;
const fmtP = (p) => { const s = p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return p >= 1000 ? s.replace(/\.00$/, '') : s; };

/** 建一個模擬後端（持股＋選擇性的盤中紀錄） */
function backend({ at, recordFrom, recorder = true, state = {}, quota } = {}) {
  NOW = at;
  const st = Object.assign({ misDyn: true, usDyn: true }, state);
  const env = makeEnv(fx.makeHandler(st), quota ? { quotaLeft: quota } : {});
  env.ctx.__now = () => NOW;
  const token = env.ctx.setup();
  if (!recorder) env.ctx.removeRecorder();
  [['2330', '台積電', 1000, 600], ['6488', '環球晶', 100, 500], ['0050', '元大台灣50', 1500, 150], ['AAPL', '', 10, 180], ['NVDA', '', 25, 120]]
    .forEach(([code, name, shares, cost]) => env.post({ action: 'upsert', token, holding: { code, shares, cost, name } }));
  if (recordFrom) { for (NOW = recordFrom; NOW < at; NOW += 60e3) env.ctx.recordTick(); NOW = at; }
  const code = 'SHN1:' + Buffer.from(JSON.stringify({ u: EXEC, t: token })).toString('base64url');
  cur = { env, token, state: st };
  return { env, token, code, state: st };
}

async function openApp(browser, setupCode, device, extra) {
  const ctx = await browser.newContext(Object.assign({}, device, { locale: 'zh-TW', timezoneId: 'Asia/Taipei' }, extra || {}));
  await ctx.route('https://fonts.googleapis.com/**', r => r.abort());
  await ctx.route('https://fonts.gstatic.com/**', r => r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.clock.install({ time: NOW - 30e3 });
  await page.goto('http://localhost:8765/#setup=' + encodeURIComponent(setupCode));
  await page.clock.pauseAt(NOW);
  await page.waitForSelector('.hrow');
  await page.waitForFunction(() => !document.querySelector('#btnRefresh').classList.contains('spin'));
  return { ctx, page, errors };
}
/** 兩邊時鐘一起往前走 */
async function advance(page, ms) { NOW += ms; await page.clock.runFor(ms); }
const pointCount = (page) => page.$eval('#chBox .ch-line', p => (p.getAttribute('d').match(/L/g) || []).length + 1).catch(() => 0);

(async () => {
  await new Promise(r => server.listen(8765, r));
  await new Promise(r => execServer.listen(8443, r));
  await new Promise(r => echoServer.listen(8444, r));
  const browser = await chromium.launch({ args: ['--no-proxy-server', '--ignore-certificate-errors', '--host-resolver-rules=MAP script.google.com:443 127.0.0.1:8443, MAP script.googleusercontent.com:443 127.0.0.1:8444'] });
  const iphone = Object.assign({}, devices['iPhone 13']); delete iphone.defaultBrowserType;
  const se = Object.assign({}, devices['iPhone SE']); delete se.defaultBrowserType;
  const desktop = Object.assign({}, devices['Desktop Chrome'], { viewport: { width: 1280, height: 860 } });

  // ───────── 台股盤中 10:30（排程從 09:00 開始記錄） ─────────
  let b = backend({ at: TPE(10, 27, 10, 30), recordFrom: TPE(10, 27, 9, 0) });
  let { ctx, page, errors } = await openApp(browser, b.code, iphone);

  await t('列表：每檔都有迷你走勢線（台股今天到目前、美股前一晚完整）', async () => {
    await page.waitForFunction(() => document.querySelectorAll('.hspark svg').length >= 5);
    const w = await page.$$eval('.hrow', rows => Object.fromEntries(rows.map(r => {
      const p = r.querySelector('.hspark path'); const box = p && p.getBBox();
      return [r.querySelector('.hcode').textContent, box ? Math.round(box.width) : 0];
    })));
    assert.ok(w['2330'] > 20 && w['2330'] < 45, '台股 10:30 只畫到約三分之一：' + w['2330']);
    assert.ok(w['AAPL'] >= 68, '美股前一晚完整：' + w['AAPL']);
  });

  await t('台股明細：走勢 09:00–13:30、昨收虛線、價格＝即時價、顯示「即時・每 5 秒更新」', async () => {
    await page.click('.hrow:has(.hcode:text-is("2330"))');
    await page.waitForSelector('#chBox .ch-line');
    assert.strictEqual(await page.textContent('#chPrice'), fmtP(fx.twPrice('2330', NOW)));
    const axis = await page.$$eval('#chBox .ch-axis', a => a.map(x => x.textContent));
    assert.ok(axis.includes('09:00') && axis.includes('13:30') && axis.includes('11:15'), axis.join());
    assert.ok(axis.includes('1,070'), '昨收刻度');
    assert.ok(await page.$('#chBox .ch-ref'));
    assert.match(await page.textContent('#chWhen'), /即時・每 5 秒更新・10:30:00/);
    assert.ok(await page.isHidden('#chNote'));
    const n = await pointCount(page);
    assert.ok(n >= 90, '從 09:00 起的點數 ' + n);
    await page.screenshot({ path: OUT + '/13-chart-tw-live.png' });
  });

  await t('每 5 秒更新：連續 3 次，線多一點、價格變成新的即時價，背後列表也同步', async () => {
    for (let i = 0; i < 3; i++) {
      const before = await pointCount(page);
      const before2 = counts.live || 0;
      await advance(page, 5000);
      await page.waitForFunction((c) => true, null);
      await page.waitForFunction(([n]) => (document.querySelector('#chBox .ch-line').getAttribute('d').match(/L/g) || []).length + 1 > n, [before]);
      assert.strictEqual((counts.live || 0) - before2, 1, '每次只打一次 live');
      assert.strictEqual(await page.textContent('#chPrice'), fmtP(fx.twPrice('2330', NOW)));
    }
    const rowPrice = await page.$eval('.hrow:has(.hcode:text-is("2330")) .hprice', e => e.textContent);
    assert.strictEqual(rowPrice, fmtP(fx.twPrice('2330', NOW)));
    assert.match(await page.textContent('#chWhen'), /10:30:15/);
  });

  await t('手指／滑鼠滑過：顯示該時間點價格與時間，離開後回到即時', async () => {
    const box = await page.$('#chBox svg');
    const bb = await box.boundingBox();
    await page.mouse.move(bb.x + bb.width * 0.1, bb.y + bb.height / 2);
    const when = await page.textContent('#chWhen');
    assert.match(when, /10\/27 09:\d\d　相對昨收/);
    await page.mouse.move(bb.x - 30, bb.y - 30);
    assert.match(await page.textContent('#chWhen'), /即時/);
  });

  await t('切到 1 年：不再每 5 秒更新；切回 1 日恢復；關掉明細後完全停止', async () => {
    await page.click('#chRanges button[data-r="1y"]');
    await page.waitForFunction(() => /近 1 年/.test(document.querySelector('#chWhen').textContent));
    const axis = await page.$$eval('#chBox .ch-axis', a => a.map(x => x.textContent));
    assert.ok(axis.some(x => /^\d+\/\d+$/.test(x)), '日期刻度 ' + axis.join());
    let c0 = counts.live || 0;
    await advance(page, 12000);
    assert.strictEqual((counts.live || 0) - c0, 0, '1 年不打 live');
    await page.click('#chRanges button[data-r="1d"]');
    await page.waitForFunction(() => /即時/.test(document.querySelector('#chWhen').textContent));
    c0 = counts.live || 0;
    await advance(page, 5000);
    await page.waitForFunction((n) => true, null);
    await new Promise(r => setTimeout(r, 400));
    assert.strictEqual((counts.live || 0) - c0, 1, '回到 1 日恢復');
    await page.click('#dlgDetail [data-close]');
    c0 = counts.live || 0;
    await advance(page, 15000);
    await new Promise(r => setTimeout(r, 400));
    assert.strictEqual((counts.live || 0) - c0, 0, '關掉後不打');
  });

  await t('上櫃 6488、Yahoo 沒有資料的 0050 也畫得出當日走勢', async () => {
    for (const code of ['6488', '0050']) {
      await page.click(`.hrow:has(.hcode:text-is("${code}"))`);
      await page.waitForSelector('#chBox .ch-line');
      assert.ok(await pointCount(page) >= 60, code);
      await page.click('#dlgDetail [data-close]');
    }
  });

  await t('沒有 JS 錯誤（台股盤中）', async () => { assert.deepStrictEqual(errors, []); });
  await ctx.close();

  // ───────── 台股盤中，但排程沒在跑 ─────────
  b = backend({ at: TPE(10, 27, 10, 30), recorder: false });
  ({ ctx, page, errors } = await openApp(browser, b.code, iphone));
  await t('排程沒在跑：明細顯示提醒（最近 20 分鐘會缺資料）', async () => {
    await page.click('.hrow:has(.hcode:text-is("2330"))');
    await page.waitForSelector('#chBox .ch-line');
    assert.ok(await page.isVisible('#chNote'));
    assert.match(await page.textContent('#chNote'), /盤中紀錄排程沒有在執行/);
    await page.screenshot({ path: OUT + '/14-chart-tw-gap.png' });
  });
  await ctx.close();

  // ───────── 美股盤中（台北 22:30＝美東 10:30） ─────────
  b = backend({ at: TPE(10, 27, 22, 30) });
  ({ ctx, page, errors } = await openApp(browser, b.code, iphone));
  await t('美股明細：時間軸以台灣時間 21:30–04:00、標示台灣時間、每 5 秒更新', async () => {
    await page.click('.hrow:has(.hcode:text-is("AAPL"))');
    await page.waitForSelector('#chBox .ch-line');
    const axis = await page.$$eval('#chBox .ch-axis', a => a.map(x => x.textContent));
    assert.ok(axis.includes('21:30') && axis.includes('04:00') && axis.includes('00:45'), axis.join());
    assert.match(await page.textContent('#chWhen'), /即時・每 5 秒更新・22:30:00（台灣時間）/);
    assert.match(await page.textContent('#chPrice'), /^US\$/);
    const before = await pointCount(page);
    await advance(page, 5000);
    await page.waitForFunction(([n]) => (document.querySelector('#chBox .ch-line').getAttribute('d').match(/L/g) || []).length + 1 > n, [before]);
    await page.screenshot({ path: OUT + '/15-chart-us-live.png' });
  });
  await t('台股在美股時段已收盤：明細顯示「已收盤」且不每 5 秒更新', async () => {
    await page.click('#dlgDetail [data-close]');
    await page.click('.hrow:has(.hcode:text-is("2330"))');
    await page.waitForSelector('#chBox .ch-line');
    assert.match(await page.textContent('#chWhen'), /已收盤・最後成交 10\/27 13:30/);
    const c0 = counts.live || 0;
    await advance(page, 12000);
    await new Promise(r => setTimeout(r, 300));
    assert.strictEqual((counts.live || 0) - c0, 0);
    await page.click('#dlgDetail [data-close]');
  });
  await t('沒有 JS 錯誤（美股盤中）', async () => { assert.deepStrictEqual(errors, []); });
  await ctx.close();

  // ───────── 休市日（平日盤中時間，但報價停在 2 小時前） ─────────
  b = backend({ at: TPE(10, 27, 10, 30), state: { misStale: true } });
  ({ ctx, page, errors } = await openApp(browser, b.code, iphone));
  await t('休市日：第一次更新後發現報價沒動，停止每 5 秒更新並說明', async () => {
    await page.click('.hrow:has(.hcode:text-is("2330"))');
    await page.waitForSelector('#chBox svg, #chBox .ch-msg');
    await page.waitForFunction(() => !/載入/.test(document.querySelector('#chWhen').textContent));
    await page.waitForFunction(() => /可能是休市日/.test(document.querySelector('#chWhen').textContent));
    assert.ok(!/即時/.test(await page.textContent('#chWhen')), '不可以顯示「即時」');
    const c0 = counts.live || 0;
    await advance(page, 15000);
    await new Promise(r => setTimeout(r, 300));
    assert.strictEqual((counts.live || 0) - c0, 0);
  });
  await ctx.close();

  // ───────── Google 額度用完 ─────────
  let quotaLeft = 1e9;
  b = backend({ at: TPE(10, 27, 10, 30), recordFrom: TPE(10, 27, 10, 0), quota: () => quotaLeft });
  ({ ctx, page, errors } = await openApp(browser, b.code, iphone));
  await t('額度用完：顯示說明、停止每 5 秒更新', async () => {
    await page.click('.hrow:has(.hcode:text-is("2330"))');
    await page.waitForSelector('#chBox .ch-line');
    await page.waitForFunction(() => /即時/.test(document.querySelector('#chWhen').textContent));
    quotaLeft = b.env.fetchCount();
    await advance(page, 5000);
    await page.waitForFunction(() => !document.querySelector('#chNote').classList.contains('hidden'));
    assert.match(await page.textContent('#chNote'), /額度/);
    const c0 = counts.live || 0;
    await advance(page, 15000);
    await new Promise(r => setTimeout(r, 300));
    assert.strictEqual((counts.live || 0) - c0, 0);
  });
  await ctx.close();

  // ───────── 版面：iPhone SE、桌面深色 ─────────
  b = backend({ at: TPE(10, 27, 10, 30), recordFrom: TPE(10, 27, 9, 0) });
  ({ ctx, page, errors } = await openApp(browser, b.code, se));
  await t('iPhone SE（320px）：迷你走勢線隱藏、沒有橫向捲動、走勢圖完整顯示', async () => {
    assert.ok(await page.isHidden('.hspark'));
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(over <= 0, 'overflow ' + over);
    await page.click('.hrow:has(.hcode:text-is("2330"))');
    await page.waitForSelector('#chBox .ch-line');
    const fits = await page.$eval('#chBox svg', s => { const r = s.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; });
    assert.ok(fits);
    await page.screenshot({ path: OUT + '/16-chart-iphone-se.png' });
  });
  await ctx.close();

  ({ ctx, page, errors } = await openApp(browser, b.code, desktop, { colorScheme: 'dark' }));
  await t('桌面深色模式：列表迷你線與明細走勢', async () => {
    await page.screenshot({ path: OUT + '/17-desktop-dark-spark.png' });
    await page.click('.hrow:has(.hcode:text-is("2330"))');
    await page.waitForSelector('#chBox .ch-line');
    await page.screenshot({ path: OUT + '/18-desktop-dark-chart.png' });
    assert.deepStrictEqual(errors, []);
  });
  await ctx.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  await browser.close(); server.close(); execServer.close(); echoServer.close();
  process.exit(failed ? 1 : 0);
})();
