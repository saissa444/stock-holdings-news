// 在 Node 模擬 Google Apps Script 執行環境，用來測試 Code.gs
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const convert = require('/opt/npm-tools/node_modules/xml-js');

function makeEnv(fetchHandler) {
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
    CacheService: { getScriptCache: () => ({
      get: k => { if (k.length > 250) throw new Error('key too long'); return cacheStore[k] || null; },
      put: (k, v) => { if (k.length > 250) throw new Error('key too long'); cacheStore[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Logger: { log: () => {} },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      base64EncodeWebSafe: b => Buffer.from(b).toString('base64url'),
      computeDigest: (alg, s) => Array.from(crypto.createHash('md5').update(s, 'utf8').digest()),
      DigestAlgorithm: { MD5: 'MD5' }, Charset: { UTF_8: 'UTF-8' },
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: s => ({ setMimeType() { return this; }, getContent: () => s }),
    },
    XmlService: { parse: xml => { const j = convert.xml2js(xml, { compact: false }); const root = j.elements.find(e => e.type === 'element'); return { getRootElement: () => wrap(root) }; } },
    UrlFetchApp: { fetch: (u, o) => doFetch(Object.assign({ url: u }, o || {})), fetchAll: reqs => reqs.map(doFetch) },
  };
  vm.createContext(ctx);
  const code = fs.readFileSync(path.join(__dirname, '../backend/Code.gs'), 'utf8');
  vm.runInContext(code, ctx, { filename: 'Code.gs' });
  return {
    ctx, sheets, props, cacheStore,
    fetchLog: () => fetchLog, resetFetchLog: () => { fetchLog = []; },
    clearCache: () => { for (const k in cacheStore) delete cacheStore[k]; },
    get: (params) => JSON.parse(ctx.doGet({ parameter: params }).getContent()),
    post: (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).getContent()),
  };
}

module.exports = { makeEnv };
