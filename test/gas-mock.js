// 在 Node 模擬 Google Apps Script 執行環境，用來測試 Code.gs
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const convert = require('/opt/npm-tools/node_modules/xml-js');

function makeEnv(fetchHandler, opts) {
  opts = opts || {};
  const triggers = [];
  const sleeps = [];
  const cacheExp = {};
  const fetchTimes = [];
  let fetchCount = 0;
  const quotaCheck = (n) => {
    if (opts.quotaLeft != null) {
      if (fetchCount + n > opts.quotaLeft()) throw new Error('Exception: Service invoked too many times for one day: urlfetch.');
    }
    fetchCount += n;
  };
  // ---------- 試算表（模擬「數字格式」：非文字格式欄位會把數字字串轉成數字） ----------
  class Range {
    constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr, nc }); }
    setNumberFormat(f) { for (let c = this.c; c < this.c + this.nc; c++) this.sh.fmt[c] = f; return this; }
    setFontWeight() { return this; }
    setValues(vals) {
      for (let i = 0; i < this.nr; i++) {
        this.sh.rows[this.r - 1 + i] = this.sh.rows[this.r - 1 + i] || [];
        for (let j = 0; j < this.nc; j++) {
          let v = vals[i][j];
          const col = this.c + j;
          if (this.sh.fmt[col] !== '@' && typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) v = Number(v);
          if (this.sh.fmt[col] === '@' && typeof v === 'number') v = String(v);
          this.sh.rows[this.r - 1 + i][col - 1] = v;
        }
      }
      return this;
    }
    getValues() {
      const out = [];
      for (let i = 0; i < this.nr; i++) {
        const row = this.sh.rows[this.r - 1 + i] || [];
        const o = [];
        for (let j = 0; j < this.nc; j++) { const v = row[this.c - 1 + j]; o.push(v === undefined ? '' : v); }
        out.push(o);
      }
      return out;
    }
  }
  class Sheet {
    constructor(name) { this.name = name; this.rows = []; this.fmt = {}; }
    getRange(a, b, c, d) {
      if (typeof a === 'string') {
        if (/^[A-Z]:[A-Z]$/.test(a)) { const col = a.charCodeAt(0) - 64; return new Range(this, 1, col, 1000, 1); }
        const m = a.match(/^([A-Z])(\d+):([A-Z])(\d+)$/);
        const c1 = m[1].charCodeAt(0) - 64, r1 = +m[2], c2 = m[3].charCodeAt(0) - 64, r2 = +m[4];
        return new Range(this, r1, c1, r2 - r1 + 1, c2 - c1 + 1);
      }
      return new Range(this, a, b, c || 1, d || 1);
    }
    getLastRow() { let n = this.rows.length; while (n > 0 && !(this.rows[n - 1] || []).some(v => v !== '' && v !== undefined)) n--; return n; }
    setFrozenRows() {} clear() { this.rows = []; } setColumnWidth() {}
    deleteRow(r) { this.rows.splice(r - 1, 1); }
    appendRow(v) { this.rows.push(v); }
  }
  const sheets = {};
  const ss = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = new Sheet(n)),
  };
  const props = {};
  const cacheStore = {};
  let fetchLog = [];
  const resp = (code, body, headers) => ({ getResponseCode: () => code, getContentText: () => body, getAllHeaders: () => headers || {} });
  const doFetch = (req) => {
    const r = typeof req === 'string' ? { url: req } : req;
    fetchLog.push(r.url + (r.payload && r.payload.co_id ? '#co_id=' + r.payload.co_id + '&TYPEK=' + r.payload.TYPEK : ''));
    fetchTimes.push([ctx.__now(), r.url]);
    const out = fetchHandler(r.url, r);
    if (out instanceof Error) throw out;
    return resp(out.code, out.body, out.headers);
  };

  // ---------- XmlService（用 xml-js 模擬 getRootElement / getChild / getChildren / getChildText / getText） ----------
  function wrap(el) {
    const kids = () => (el.elements || []).filter(e => e.type === 'element');
    const text = (e) => (e.elements || []).filter(x => x.type === 'text' || x.type === 'cdata').map(x => x.text != null ? x.text : x.cdata).join('');
    return {
      getChild: n => { const k = kids().find(e => e.name === n); return k ? wrap(k) : null; },
      getChildren: n => kids().filter(e => e.name === n).map(wrap),
      getChildText: n => { const k = kids().find(e => e.name === n); return k ? text(k) : null; },
      getText: () => text(el),
    };
  }

  const ctx = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; } }) },
    // 和真的 CacheService 一樣：有到期時間（最長 6 小時）、單筆上限 100KB
    CacheService: { getScriptCache: () => ({
      get: k => {
        if (k.length > 250) throw new Error('key too long');
        const e = cacheExp[k];
        if (e != null && ctx.__now() >= e) { delete cacheStore[k]; delete cacheExp[k]; return null; }
        return cacheStore[k] || null;
      },
      put: (k, v, ttl) => {
        if (k.length > 250) throw new Error('key too long');
        if (String(v).length > 100 * 1024) throw new Error('Argument too large: value');
        cacheStore[k] = v; cacheExp[k] = ctx.__now() + Math.min(ttl || 600, 21600) * 1000;
      } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Logger: { log: () => {} },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      base64EncodeWebSafe: b => Buffer.from(b).toString('base64url'),
      computeDigest: (alg, s) => Array.from(crypto.createHash('md5').update(s, 'utf8').digest()),
      DigestAlgorithm: { MD5: 'MD5' }, Charset: { UTF_8: 'UTF-8' },
      sleep: (ms) => { sleeps.push(ms); if (opts.onSleep) opts.onSleep(ms); else { const end = Date.now() + ms; while (Date.now() < end) { /* 真的等 */ } } },
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: s => ({ setMimeType() { return this; }, getContent: () => s }),
    },
    XmlService: { parse: xml => { const j = convert.xml2js(xml, { compact: false }); const root = j.elements.find(e => e.type === 'element'); return { getRootElement: () => wrap(root) }; } },
    UrlFetchApp: {
      fetch: (u, o) => { quotaCheck(1); return doFetch(Object.assign({ url: u }, o || {})); },
      fetchAll: reqs => { quotaCheck(reqs.length); return reqs.map(doFetch); }
    },
    ScriptApp: {
      getProjectTriggers: () => { if (opts.triggerError) throw new Error('需要授權'); return triggers.slice(); },
      newTrigger: (fn) => ({ timeBased: () => ({ everyMinutes: (n) => ({ create: () => { const t = { getHandlerFunction: () => fn, minutes: n }; triggers.push(t); return t; } }) }) }),
      deleteTrigger: (t) => { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
    },
    __now: () => Date.now(),
  };
  vm.createContext(ctx);
  // Code.gs 用 Date.now() 判斷開收盤；測試可以覆寫 Node 的 Date.now 來控制時間
  vm.runInContext('Date.now = function () { return __now(); };', ctx);
  const code = fs.readFileSync(path.join(__dirname, '../backend/Code.gs'), 'utf8');
  vm.runInContext(code, ctx, { filename: 'Code.gs' });
  return {
    ctx, sheets, props, cacheStore, triggers, sleeps, fetchTimes, fetchCount: () => fetchCount,
    fetchLog: () => fetchLog, resetFetchLog: () => { fetchLog = []; },
    clearCache: () => { for (const k in cacheStore) delete cacheStore[k]; },
    get: (params) => JSON.parse(ctx.doGet({ parameter: params }).getContent()),
    post: (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).getContent()),
  };
}

module.exports = { makeEnv };
