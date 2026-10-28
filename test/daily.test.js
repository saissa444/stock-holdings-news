// 每日 13:30 市值紀錄：固定時鐘模擬各種情況，數字用獨立計算核對
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
const HOLD = [['2330', '台積電', 1000, 600], ['0050', '元大台灣50', 1500, 150.33], ['6488', '環球晶', 100, 500], ['AAPL', '', 10, 180], ['NVDA', '', 25, 120.5]];

function backend(state, opts) {
  const st = Object.assign({ misDyn: true, usDyn: true }, state || {});
  const env = makeEnv(fx.makeHandler(st), Object.assign({ onSleep: (ms) => { NOW += ms; } }, opts || {}));
  env.ctx.__now = () => NOW;
  const token = env.ctx.setup();
  HOLD.forEach(([code, name, shares, cost]) => env.post({ action: 'upsert', token, holding: { code, shares, cost, name } }));
  return { env, token, state: st };
}
const daily = (env) => env.sheets['每日市值'].rows.slice(1);
const det = (env) => env.sheets['市值明細'].rows.slice(1);
const tick = (env, at) => { NOW = at; env.ctx.recordTick(); };
// 和 App 一樣的算法（獨立寫一份核對）
function expected(env, prices, fxRate, opts) {
  const o = Object.assign({ fees: true, discount: 10 }, opts || {});
  let total = 0, tw = 0, usT = 0, usUsd = 0, cost = 0, pnl = 0;
  HOLD.forEach(([code, , shares, c]) => {
    const p = prices[code]; if (p == null) return;
    const us = /^[A-Z]/.test(code), rate = us ? fxRate : 1;
    const mv = p * shares, mvT = mv * rate;
    let fee = 0;
    if (!us && o.fees) {
      const f = Math.max(Math.floor(mv * 0.001425 * o.discount / 10), shares % 1000 === 0 ? 20 : 1);
      fee = f + Math.floor(mv * (/^00/.test(code) ? 0.001 : 0.003));
    }
    total += mvT; if (us) { usT += mvT; usUsd += mv; } else tw += mvT;
    cost += c * shares * rate; pnl += (mv - fee - c * shares) * rate;
  });
  return { total: Math.round(total), tw: Math.round(tw), usT: Math.round(usT), usUsd: Math.round(usUsd * 100) / 100, cost: Math.round(cost), pnl: Math.round(pnl) };
}
const usClose = (sym, prev, nowMs) => { const [, e] = (() => { for (let k = 0; k < 7; k++) { const [a, b] = fx.usSes(nowMs - k * 864e5); const wd = new Date((a + b) / 2 - 4 * 3600e3).getUTCDay(); if (wd && wd < 6 && a <= nowMs) return [a, b]; } })(); return Math.round(prev * (1 + 0.015 * Math.sin(Math.min(nowMs, e) / 5.4e6) + 0.005 * Math.sin(Math.min(nowMs, e) / 6.3e5)) * 100) / 100; };

t('setup 建立「每日市值」「市值明細」工作表與欄位', () => {
  NOW = TPE(10, 27, 8, 0);
  const { env } = backend();
  assert.deepStrictEqual(env.sheets['每日市值'].rows[0].slice(0, 4), ['日期', '紀錄時間', '總市值', '台股市值']);
  assert.strictEqual(env.sheets['每日市值'].rows[0][10], '市值變化');
  assert.strictEqual(env.sheets['市值明細'].fmt[2], '@', '代號欄文字（0050 不掉 0）');
  assert.match(env.sheets['每日市值'].fmt[11], /\[Red\]"▲"#,##0;\[Green\]"▼"#,##0/);
});

let A;
t('13:30 以前不記；13:31 記下 13:30 收盤價計算的總市值（與獨立計算一致）', () => {
  NOW = TPE(10, 27, 8, 0);
  A = backend();
  tick(A.env, TPE(10, 27, 13, 20)); tick(A.env, TPE(10, 27, 13, 30));
  assert.strictEqual(daily(A.env).length, 0);
  tick(A.env, TPE(10, 27, 13, 31));
  const r = daily(A.env);
  assert.strictEqual(r.length, 1);
  const close = TPE(10, 27, 13, 30);
  const prices = { 2330: fx.twPrice('2330', close), '0050': fx.twPrice('0050', close), 6488: fx.twPrice('6488', close), AAPL: usClose('AAPL', 262.24, NOW), NVDA: usClose('NVDA', 180.28, NOW) };
  const e = expected(A.env, prices, 30.62);
  const [date, time, total, tw, usT, usUsd, fxr, cost, pnl, ret, dMv, dPct, dPnl, n, note] = r[0];
  assert.deepStrictEqual([date, time, total, tw, usT, usUsd, fxr, cost, pnl, n], ['2026-10-27', '13:31', e.total, e.tw, e.usT, e.usUsd, 30.62, e.cost, e.pnl, 5]);
  assert.strictEqual(dMv, ''); assert.strictEqual(note, '');
  assert.strictEqual(Math.round(ret * 1e4), Math.round(e.pnl / e.cost * 1e4));
  const d = det(A.env);
  assert.strictEqual(d.length, 5);
  assert.strictEqual(d.find(x => x[1] === '0050')[1], '0050');
  assert.strictEqual(d.find(x => x[1] === '2330')[11], '2026-10-27 13:30', '台股報價時間＝13:30 收盤');
  console.log('   10/27 總市值', total, '台股', tw, '美股', usT, '損益', pnl);
});

t('同一天不重複記（13:32、14:00、晚上都略過）', () => {
  [TPE(10, 27, 13, 32), TPE(10, 27, 14, 0), TPE(10, 27, 22, 0)].forEach(x => tick(A.env, x));
  assert.strictEqual(daily(A.env).length, 1);
  delete A.env.cacheStore['snap:2026-10-27'];        // 快取被清掉也不會重複（以試算表為準）
  tick(A.env, TPE(10, 27, 22, 1));
  assert.strictEqual(daily(A.env).length, 1);
});

t('隔天：記錄與前一日的變化（市值、百分比、損益）', () => {
  tick(A.env, TPE(10, 28, 13, 31));
  const r = daily(A.env);
  assert.strictEqual(r.length, 2);
  const [p, c] = r;
  assert.strictEqual(c[10], c[2] - p[2]);
  assert.strictEqual(Math.round(c[11] * 1e6), Math.round((c[2] - p[2]) / p[2] * 1e6));
  assert.strictEqual(c[12], c[8] - p[8]);
  assert.notStrictEqual(c[10], 0);
  console.log('   10/28 市值變化', c[10], '（', (c[11] * 100).toFixed(2), '%）');
});

t('收盤價還沒公布（證交所時間還在 13:29）：先不記，13:45 前一分鐘一次重試；到 13:45 用拿得到的價格記', () => {
  NOW = TPE(10, 29, 8, 0);
  const B = backend({ misPreClose: true });
  tick(B.env, TPE(10, 29, 13, 31)); tick(B.env, TPE(10, 29, 13, 40));
  assert.strictEqual(daily(B.env).length, 0);
  tick(B.env, TPE(10, 29, 13, 45));
  assert.strictEqual(daily(B.env).length, 1);
  B.state.misPreClose = false;
  NOW = TPE(10, 30, 8, 0);
  const C = backend({ misPreClose: true });
  tick(C.env, TPE(10, 30, 13, 31));
  C.state.misPreClose = false; C.env.clearCache();
  tick(C.env, TPE(10, 30, 13, 32));
  assert.strictEqual(daily(C.env).length, 1);
  assert.strictEqual(daily(C.env)[0][1], '13:32');
});

t('週末：照常記錄（美股週五晚上的漲跌會反映），備註「台股休市」', () => {
  tick(A.env, TPE(10, 29, 13, 31)); tick(A.env, TPE(10, 30, 13, 31)); tick(A.env, TPE(10, 31, 13, 31));
  const sat = daily(A.env).find(r => r[0] === '2026-10-31');
  assert.ok(sat); assert.match(sat[14], /台股休市/);
  const fri = daily(A.env).find(r => r[0] === '2026-10-30');
  assert.ok(!/台股休市/.test(fri[14]));
});

t('漏記一天：下一筆和最後一筆比較，並註明比較日期', () => {
  tick(A.env, TPE(11, 2, 13, 31));      // 11/1（週日）沒記到
  const r = daily(A.env);
  const last = r[r.length - 1];
  assert.strictEqual(last[0], '2026-11-02');
  assert.match(last[14], /與 2026-10-31 比較/);
  assert.strictEqual(last[10], last[2] - r[r.length - 2][2]);
});

t('持股變動：備註「持股有變動」，損益變化不受買進影響', () => {
  A.env.post({ action: 'upsert', token: A.token, holding: { code: '2330', shares: 2000, cost: 600, name: '台積電' } });
  tick(A.env, TPE(11, 3, 13, 31));
  const r = daily(A.env); const last = r[r.length - 1];
  assert.match(last[14], /持股有變動/);
  A.env.post({ action: 'upsert', token: A.token, holding: { code: '2330', shares: 1000, cost: 600, name: '台積電' } });
});

t('某檔沒報價：沿用前一日價格並註明；前一日也沒有就不計入並註明', () => {
  A.state.misMissing = ['0050'];
  A.env.clearCache();
  tick(A.env, TPE(11, 4, 13, 31));
  const r = daily(A.env); const last = r[r.length - 1];
  assert.match(last[14], /1 檔缺報價，沿用前一日價格/);
  const d0050 = det(A.env).filter(x => x[1] === '0050');
  assert.strictEqual(d0050[d0050.length - 1][5], d0050[d0050.length - 2][5]);
  assert.strictEqual(d0050[d0050.length - 1][12], '缺報價，沿用前一日價格');
  A.state.misMissing = null;
});

t('App 的損益設定同步到後端（不扣手續費／折扣 2.8 折）', () => {
  NOW = TPE(11, 5, 8, 0);
  const D = backend();
  let r = D.env.post({ action: 'settings', token: D.token, settings: { fees: false, discount: 10 } });
  assert.deepStrictEqual(r.data, { fees: false, discount: 10 });
  tick(D.env, TPE(11, 5, 13, 31));
  const close = TPE(11, 5, 13, 30);
  const prices = { 2330: fx.twPrice('2330', close), '0050': fx.twPrice('0050', close), 6488: fx.twPrice('6488', close), AAPL: usClose('AAPL', 262.24, NOW), NVDA: usClose('NVDA', 180.28, NOW) };
  assert.strictEqual(daily(D.env)[0][8], expected(D.env, prices, 30.62, { fees: false }).pnl);
  const E = backend();
  E.env.post({ action: 'settings', token: E.token, settings: { fees: true, discount: 2.8 } });
  tick(E.env, TPE(11, 5, 13, 31));
  assert.strictEqual(daily(E.env)[0][8], expected(E.env, prices, 30.62, { discount: 2.8 }).pnl);
  assert.strictEqual(E.env.post({ action: 'settings', token: E.token, settings: { fees: true, discount: 99 } }).data.discount, 10, '不合理的折扣改回 10');
});

t('排程沒在跑：13:30 以後有人打開 App 就補記今天；13:30 以前不會', () => {
  NOW = TPE(11, 6, 8, 0);
  const F = backend();
  F.env.ctx.removeRecorder();
  NOW = TPE(11, 6, 12, 0); F.env.get({ action: 'data', token: F.token });
  assert.strictEqual(daily(F.env).length, 0);
  NOW = TPE(11, 6, 19, 5); F.env.get({ action: 'data', token: F.token });
  assert.strictEqual(daily(F.env).length, 1);
  assert.strictEqual(daily(F.env)[0][1], '19:05', '記下實際補記時間');
  F.env.get({ action: 'data', token: F.token });
  assert.strictEqual(daily(F.env).length, 1);
});

t('history：回傳每日資料；detail=1 附明細（代號保持文字）', () => {
  const h = A.env.get({ action: 'history', token: A.token });
  assert.ok(h.ok);
  assert.strictEqual(h.data.rows.length, daily(A.env).length);
  const r1 = h.data.rows[1];
  assert.strictEqual(typeof r1.total, 'number'); assert.strictEqual(r1.dMv, r1.total - h.data.rows[0].total);
  assert.strictEqual(h.data.rows[0].dMv, null);
  assert.strictEqual(h.data.details, undefined);
  const hd = A.env.get({ action: 'history', token: A.token, detail: '1' });
  assert.ok(hd.data.details.length >= 5 * h.data.rows.length - 1);
  assert.ok(hd.data.details.some(x => x[1] === '0050'));
});

t('沒有持股：不記錄空白資料', () => {
  NOW = TPE(11, 6, 8, 0);
  const env = makeEnv(fx.makeHandler({ misDyn: true }), { onSleep: (ms) => { NOW += ms; } });
  env.ctx.__now = () => NOW; env.ctx.setup();
  tick(env, TPE(11, 6, 13, 31));
  assert.strictEqual(daily(env).length, 0);
});

console.log(`\n${passed} passed`);
