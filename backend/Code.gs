/**
 * 持股新聞 — Google Apps Script 後端
 *
 * 功能：
 *   1. 持倉存在這份 Google 試算表的「持倉」工作表（跨裝置同步的來源）
 *   2. 台股報價：證交所 MIS（上市 tse／上櫃 otc 自動判斷）→ 失敗時改用 Yahoo Finance
 *   3. 美股報價：Yahoo Finance（query1 → query2 備援）
 *   4. 美元兌台幣匯率：Yahoo（TWD=X）→ open.er-api.com 備援
 *   5. 每檔股票的新聞：Google 新聞 RSS
 *   6. 重要時程：台股法說會（公開資訊觀測站）、美股財報日與除息日（Yahoo）、
 *      台股除權息（證交所／櫃買預告表）、台股財報與月營收法定公告期限
 *
 * 安裝：見 README。第一次請在編輯器執行 setup()，再「部署 → 新增部署作業 → 網頁應用程式」。
 */

var SHEET_HOLD = '持倉';
var SHEET_INFO = '說明';
var HEADERS = ['代號', '市場', '名稱', '股數', '平均成本', '新聞關鍵字', '備註'];
var VERSION = '1.2.0';

var CACHE_QUOTE_SEC = 15;
var CACHE_FX_SEC = 1800;
var CACHE_NEWS_SEC = 600;
var CACHE_EVENTS_SEC = 10800;   // 時程 3 小時
var CACHE_EVENTS_ERR_SEC = 600; // 有來源失敗時只快取 10 分鐘，稍後重試
var UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/* ===================== 一次性設定 ===================== */

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('請從 Google 試算表的「擴充功能 → Apps Script」開啟這份程式碼，再執行 setup。');
  var sh = ss.getSheetByName(SHEET_HOLD) || ss.insertSheet(SHEET_HOLD, 0);
  // 代號欄一定要是「純文字」，否則 0050、00878 會被試算表吃掉前導零
  sh.getRange('A:A').setNumberFormat('@');
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
    props.setProperty('TOKEN', token);
  }
  var info = ss.getSheetByName(SHEET_INFO) || ss.insertSheet(SHEET_INFO);
  info.clear();
  info.getRange('A1:B4').setValues([
    ['存取金鑰', token],
    ['用途', '在 App 的「設定」貼上「網頁應用程式網址」與這個金鑰。金鑰請勿外流，外流請執行 resetToken()。'],
    ['持倉欄位', '代號（台股數字、美股英文）｜市場（TW/US，可留空自動判斷）｜名稱（可留空）｜股數｜平均成本｜新聞關鍵字（可留空）｜備註'],
    ['版本', VERSION]
  ]);
  info.setColumnWidth(1, 110);
  info.setColumnWidth(2, 520);
  Logger.log('設定完成。存取金鑰：' + token);
  return token;
}

/** 金鑰外流時執行：產生新金鑰，所有裝置要重新輸入 */
function resetToken() {
  PropertiesService.getScriptProperties().deleteProperty('TOKEN');
  return setup();
}

/** 部署前可在編輯器執行，確認各資料來源連得上（看「執行記錄」） */
function selfTest() {
  var r = diagnose_();
  Logger.log(JSON.stringify(r, null, 2));
  return r;
}

/* ===================== HTTP 入口 ===================== */

function doGet(e) {
  return handle_(function () {
    var p = (e && e.parameter) || {};
    checkToken_(p.token);
    switch (p.action) {
      case 'data': return getData_();
      case 'news': return getNews_(String(p.codes || ''), p.days, p.en, p.strict);
      case 'lookup': return lookup_(String(p.code || ''));
      case 'events': return getEvents_();
      case 'diagnose': return diagnose_();
      case 'ping': return { version: VERSION };
      default: throw userError_('未知的動作：' + p.action);
    }
  });
}

function doPost(e) {
  return handle_(function () {
    var body = {};
    try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
    catch (err) { throw userError_('資料格式錯誤'); }
    checkToken_(body.token);
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(15000)) throw userError_('試算表忙碌中，請稍後再試');
    try {
      switch (body.action) {
        case 'upsert': return upsertHolding_(body.holding || {}, body.originalCode);
        case 'delete': return deleteHolding_(String(body.code || ''));
        default: throw userError_('未知的動作：' + body.action);
      }
    } finally {
      lock.releaseLock();
    }
  });
}

function handle_(fn) {
  var out;
  try {
    var data = fn();
    out = { ok: true, data: data, serverTime: Date.now() };
  } catch (err) {
    out = {
      ok: false,
      error: (err && err.userMessage) || ('伺服器錯誤：' + (err && err.message ? err.message : String(err))),
      code: (err && err.code) || 'server_error',
      serverTime: Date.now()
    };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function userError_(msg, code) {
  var e = new Error(msg);
  e.userMessage = msg;
  e.code = code || 'bad_request';
  return e;
}

function checkToken_(t) {
  var token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!token) throw userError_('後端尚未設定：請先在 Apps Script 執行 setup()', 'not_setup');
  if (!t || String(t) !== token) throw userError_('存取金鑰不正確', 'bad_token');
}

/* ===================== 代號與市場 ===================== */

/** 把使用者輸入整理成 {code, market}；無法辨識回傳 null */
function normalizeCode_(raw, marketHint) {
  var s = String(raw == null ? '' : raw).trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  s = s.replace(/\.(TW|TWO)$/, '');
  var hint = String(marketHint || '').trim().toUpperCase();
  if (/^\d{4,6}[A-Z]?$/.test(s)) return { code: s, market: 'TW' };
  if (/^[A-Z][A-Z0-9]{0,5}([.\-][A-Z])?$/.test(s)) return { code: s.replace('-', '.'), market: hint === 'TW' ? 'TW' : 'US' };
  return null;
}

function yahooSymbol_(code, market, suffix) {
  if (market === 'TW') return code + (suffix || '.TW');
  return code.replace('.', '-');
}

/* ===================== 試算表：持倉 ===================== */

function holdSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_HOLD);
  if (!sh) throw userError_('找不到「持倉」工作表，請在 Apps Script 執行 setup()', 'not_setup');
  return sh;
}

function toNumber_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : NaN;
  var s = String(v == null ? '' : v).replace(/[,\s，]/g, '');
  if (s === '') return NaN;
  var n = Number(s);
  return isFinite(n) ? n : NaN;
}

function readHoldings_() {
  var sh = holdSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
  var list = [];
  var seen = {};
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    var rawCode = r[0];
    // 代號若被存成數字（使用者手動輸入且欄位不是文字格式），補回 4 碼
    if (typeof rawCode === 'number') rawCode = String(rawCode).padStart(4, '0');
    var nc = normalizeCode_(rawCode, r[1]);
    if (!nc) continue;
    if (seen[nc.code]) continue; // 重複代號只取第一列
    seen[nc.code] = true;
    var shares = toNumber_(r[3]);
    var cost = toNumber_(r[4]);
    list.push({
      row: i + 2,
      code: nc.code,
      market: nc.market,
      name: String(r[2] || '').trim(),
      shares: isNaN(shares) ? 0 : shares,
      cost: isNaN(cost) ? null : cost,
      keyword: String(r[5] || '').trim(),
      note: String(r[6] || '').trim()
    });
  }
  return list;
}

function upsertHolding_(h, originalCode) {
  var nc = normalizeCode_(h.code, h.market);
  if (!nc) throw userError_('代號格式不正確：台股請輸入數字代號（如 2330、0050），美股請輸入英文代號（如 AAPL）');
  var shares = toNumber_(h.shares);
  if (isNaN(shares) || shares <= 0) throw userError_('股數要是大於 0 的數字');
  var cost = toNumber_(h.cost);
  if (isNaN(cost) || cost < 0) throw userError_('平均成本要是 0 以上的數字');
  var name = String(h.name || '').trim().slice(0, 40);
  var keyword = String(h.keyword || '').trim().slice(0, 100);
  var note = String(h.note || '').trim().slice(0, 200);

  var sh = holdSheet_();
  sh.getRange('A:A').setNumberFormat('@');
  var list = readHoldings_();
  var orig = originalCode ? normalizeCode_(originalCode) : null;
  var targetRow = null;
  for (var i = 0; i < list.length; i++) {
    if (orig && list[i].code === orig.code) targetRow = list[i].row;
  }
  for (var j = 0; j < list.length; j++) {
    if (list[j].code === nc.code && list[j].row !== targetRow) {
      if (orig) throw userError_(nc.code + ' 已經在持倉中');
      targetRow = list[j].row; // 新增時遇到相同代號 → 視為更新
    }
  }
  var rowValues = [[nc.code, nc.market, name, shares, cost, keyword, note]];
  if (targetRow) {
    sh.getRange(targetRow, 1, 1, HEADERS.length).setValues(rowValues);
  } else {
    sh.getRange(sh.getLastRow() + 1, 1, 1, HEADERS.length).setValues(rowValues);
  }
  return { code: nc.code };
}

function deleteHolding_(code) {
  var nc = normalizeCode_(code);
  if (!nc) throw userError_('代號格式不正確');
  var sh = holdSheet_();
  var list = readHoldings_();
  var rows = [];
  // 刪掉所有符合的列（含重複），由下往上刪避免列號位移
  var last = sh.getLastRow();
  if (last >= 2) {
    var codes = sh.getRange(2, 1, last - 1, 2).getValues();
    for (var i = codes.length - 1; i >= 0; i--) {
      var c = codes[i][0];
      if (typeof c === 'number') c = String(c).padStart(4, '0');
      var n = normalizeCode_(c, codes[i][1]);
      if (n && n.code === nc.code) rows.push(i + 2);
    }
  }
  if (!rows.length) throw userError_('找不到 ' + nc.code);
  rows.forEach(function (r) { sh.deleteRow(r); });
  return { deleted: nc.code, rows: rows.length, remaining: list.length - 1 };
}

/* ===================== 報價 ===================== */

function cache_() { return CacheService.getScriptCache(); }

function cacheGet_(key) {
  try { var v = cache_().get(key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}

function cachePut_(key, obj, sec) {
  try { cache_().put(key, JSON.stringify(obj), sec); } catch (e) { /* 快取失敗不影響結果 */ }
}

function num_(s) {
  if (s === null || s === undefined) return null;
  var n = parseFloat(String(s));
  return isFinite(n) && n > 0 ? n : null;
}

/** 台股：證交所 MIS。回傳 {code: quote}；查不到的代號不會出現在結果裡 */
function fetchTwseMis_(codes) {
  var out = {};
  if (!codes.length) return out;
  // MIS 一次查太多會失敗，分批
  var batches = [];
  for (var i = 0; i < codes.length; i += 20) batches.push(codes.slice(i, i + 20));
  var reqs = batches.map(function (b) {
    var ch = b.map(function (c) { return 'tse_' + c + '.tw|otc_' + c + '.tw'; }).join('|');
    return {
      url: 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=' + encodeURIComponent(ch) + '&json=1&delay=0&_=' + Date.now(),
      muteHttpExceptions: true,
      headers: { 'User-Agent': UA, 'Referer': 'https://mis.twse.com.tw/stock/index.jsp' }
    };
  });
  var resps;
  try { resps = UrlFetchApp.fetchAll(reqs); } catch (e) { return out; }
  resps.forEach(function (res) {
    if (res.getResponseCode() !== 200) return;
    var j;
    try { j = JSON.parse(res.getContentText('UTF-8')); } catch (e) { return; }
    (j.msgArray || []).forEach(function (m) {
      var code = String(m.c || '').trim().toUpperCase();
      if (!code) return;
      var prev = num_(m.y);
      var last = num_(m.z);
      var bid = num_(String(m.b || '').split('_')[0]);
      var ask = num_(String(m.a || '').split('_')[0]);
      var priceType = 'trade';
      var price = last;
      if (price === null && bid !== null && ask !== null) { price = Math.round((bid + ask) / 2 * 100) / 100; priceType = 'mid'; }
      else if (price === null && bid !== null) { price = bid; priceType = 'bid'; }
      else if (price === null && ask !== null) { price = ask; priceType = 'ask'; }
      else if (price === null && prev !== null) { price = prev; priceType = 'prevClose'; }
      if (price === null) return;
      var t = Number(m.tlong);
      out[code] = {
        code: code,
        market: 'TW',
        exchange: m.ex === 'otc' ? 'OTC' : 'TWSE',
        name: String(m.n || '').trim(),
        price: price,
        priceType: priceType,
        prevClose: prev,
        open: num_(m.o),
        high: num_(m.h),
        low: num_(m.l),
        currency: 'TWD',
        time: isFinite(t) && t > 0 ? t : null,
        source: 'TWSE'
      };
    });
  });
  return out;
}

/** Yahoo Finance chart API。symbols: [{key, symbol, market}] */
function fetchYahoo_(items) {
  var out = {};
  if (!items.length) return out;
  var hosts = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
  var pending = items.slice();
  for (var h = 0; h < hosts.length && pending.length; h++) {
    var reqs = pending.map(function (it) {
      return {
        url: hosts[h] + '/v8/finance/chart/' + encodeURIComponent(it.symbol) + '?range=1d&interval=1d&includePrePost=false',
        muteHttpExceptions: true,
        headers: { 'User-Agent': UA, 'Accept': 'application/json' }
      };
    });
    var resps;
    try { resps = UrlFetchApp.fetchAll(reqs); } catch (e) { continue; }
    var still = [];
    resps.forEach(function (res, idx) {
      var it = pending[idx];
      var q = null;
      if (res.getResponseCode() === 200) {
        try { q = parseYahooChart_(JSON.parse(res.getContentText('UTF-8')), it); } catch (e) { q = null; }
      }
      if (q) out[it.key] = q; else if (res.getResponseCode() !== 404) still.push(it);
    });
    pending = still;
  }
  return out;
}

function parseYahooChart_(j, it) {
  var r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.meta) return null;
  var m = r.meta;
  var price = num_(m.regularMarketPrice);
  if (price === null) return null;
  var prev = num_(m.previousClose);
  if (prev === null) prev = num_(m.chartPreviousClose);
  var t = Number(m.regularMarketTime);
  return {
    code: it.key,
    market: it.market,
    exchange: m.exchangeName || m.fullExchangeName || '',
    name: String(m.shortName || m.longName || '').trim(),
    price: price,
    priceType: 'trade',
    prevClose: prev,
    open: null,
    high: num_(m.regularMarketDayHigh),
    low: num_(m.regularMarketDayLow),
    currency: m.currency || (it.market === 'TW' ? 'TWD' : 'USD'),
    time: isFinite(t) && t > 0 ? t * 1000 : null,
    source: 'Yahoo'
  };
}

/** 取得所有持倉的報價：{code: quote | {error}} */
function getQuotes_(holdings) {
  var result = {};
  var need = [];
  holdings.forEach(function (h) {
    var c = cacheGet_('q:' + h.market + ':' + h.code);
    if (c) result[h.code] = c; else need.push(h);
  });
  var tw = need.filter(function (h) { return h.market === 'TW'; });
  var us = need.filter(function (h) { return h.market === 'US'; });

  var twq = fetchTwseMis_(tw.map(function (h) { return h.code; }));
  var twMissing = tw.filter(function (h) { return !twq[h.code]; });
  // MIS 失敗 → Yahoo 上市(.TW)；再不行 → 上櫃(.TWO)
  if (twMissing.length) {
    var y1 = fetchYahoo_(twMissing.map(function (h) { return { key: h.code, symbol: h.code + '.TW', market: 'TW' }; }));
    Object.keys(y1).forEach(function (k) { twq[k] = y1[k]; });
    var miss2 = twMissing.filter(function (h) { return !twq[h.code]; });
    if (miss2.length) {
      var y2 = fetchYahoo_(miss2.map(function (h) { return { key: h.code, symbol: h.code + '.TWO', market: 'TW' }; }));
      Object.keys(y2).forEach(function (k) { twq[k] = y2[k]; });
    }
  }
  var usq = fetchYahoo_(us.map(function (h) { return { key: h.code, symbol: yahooSymbol_(h.code, 'US'), market: 'US' }; }));

  need.forEach(function (h) {
    var q = h.market === 'TW' ? twq[h.code] : usq[h.code];
    if (q) {
      result[h.code] = q;
      cachePut_('q:' + h.market + ':' + h.code, q, CACHE_QUOTE_SEC);
    } else {
      result[h.code] = { code: h.code, market: h.market, error: '查不到報價（代號錯誤或資料來源暫時無法連線）' };
    }
  });
  return result;
}

function getFx_() {
  var c = cacheGet_('fx:USDTWD');
  if (c) return c;
  var fx = null;
  var y = fetchYahoo_([{ key: 'FX', symbol: 'TWD=X', market: 'FX' }]);
  if (y.FX && y.FX.price > 20 && y.FX.price < 60) {
    fx = { rate: y.FX.price, time: y.FX.time, source: 'Yahoo' };
  }
  if (!fx) {
    try {
      var res = UrlFetchApp.fetch('https://open.er-api.com/v6/latest/USD', { muteHttpExceptions: true });
      if (res.getResponseCode() === 200) {
        var j = JSON.parse(res.getContentText('UTF-8'));
        var r = j && j.rates && Number(j.rates.TWD);
        if (r > 20 && r < 60) fx = { rate: r, time: (Number(j.time_last_update_unix) || 0) * 1000 || null, source: 'ExchangeRate-API' };
      }
    } catch (e) { /* 兩個來源都失敗 → 回傳 null，前端提示 */ }
  }
  if (fx) cachePut_('fx:USDTWD', fx, CACHE_FX_SEC);
  return fx;
}

function getData_() {
  var holdings = readHoldings_();
  var quotes = getQuotes_(holdings);
  var hasUS = holdings.some(function (h) { return h.market === 'US'; });
  return {
    holdings: holdings.map(function (h) { delete h.row; return h; }),
    quotes: quotes,
    fx: hasUS ? getFx_() : (cacheGet_('fx:USDTWD') || null),
    version: VERSION
  };
}

function lookup_(raw) {
  var nc = normalizeCode_(raw);
  if (!nc) throw userError_('代號格式不正確：台股請輸入數字代號（如 2330、0050），美股請輸入英文代號（如 AAPL）');
  var q = getQuotes_([{ code: nc.code, market: nc.market }])[nc.code];
  if (!q || q.error) throw userError_('查不到 ' + nc.code + ' 的報價，請確認代號', 'not_found');
  return q;
}

/* ===================== 新聞 ===================== */

/* 常見美股的中文／英文名稱（台灣媒體慣用）。沒列到的美股會用 Yahoo 的英文名稱；
   也可以在持股的「新聞關鍵字」自己補。 */
var US_NAMES = {
  AAPL: [['蘋果'], ['Apple']], MSFT: [['微軟'], ['Microsoft']], NVDA: [['輝達'], ['Nvidia']],
  GOOGL: [['谷歌'], ['Alphabet', 'Google']], GOOG: [['谷歌'], ['Alphabet', 'Google']], AMZN: [['亞馬遜'], ['Amazon']],
  META: [['臉書'], ['Meta Platforms', 'Meta']], TSLA: [['特斯拉'], ['Tesla']], AMD: [['超微'], ['AMD']],
  INTC: [['英特爾'], ['Intel']], AVGO: [['博通'], ['Broadcom']], QCOM: [['高通'], ['Qualcomm']],
  MU: [['美光'], ['Micron']], SNDK: [['閃迪'], ['SanDisk']], WDC: [['威騰'], ['Western Digital']],
  STX: [['希捷'], ['Seagate']], TSM: [['台積電'], ['TSMC', 'Taiwan Semiconductor']], ASML: [['艾司摩爾'], ['ASML']],
  ARM: [['安謀'], ['Arm Holdings']], SMCI: [['美超微'], ['Super Micro', 'Supermicro']], DELL: [['戴爾'], ['Dell']],
  HPQ: [['惠普'], ['HP Inc']], ORCL: [['甲骨文'], ['Oracle']], CRM: [[], ['Salesforce']], ADBE: [[], ['Adobe']],
  NFLX: [['網飛'], ['Netflix']], DIS: [['迪士尼'], ['Disney']], KO: [['可口可樂'], ['Coca-Cola']],
  PEP: [['百事'], ['PepsiCo']], MCD: [['麥當勞'], ["McDonald's", 'McDonald']], SBUX: [['星巴克'], ['Starbucks']],
  NKE: [['耐吉'], ['Nike']], COST: [['好市多'], ['Costco']], WMT: [['沃爾瑪'], ['Walmart']],
  JPM: [['摩根大通'], ['JPMorgan']], BAC: [['美國銀行'], ['Bank of America']], GS: [['高盛'], ['Goldman Sachs']],
  MS: [['摩根士丹利'], ['Morgan Stanley']], V: [[], ['Visa']], MA: [['萬事達'], ['Mastercard']],
  'BRK.B': [['波克夏'], ['Berkshire']], JNJ: [['嬌生'], ['Johnson & Johnson']], PFE: [['輝瑞'], ['Pfizer']],
  LLY: [['禮來'], ['Eli Lilly']], NVO: [['諾和諾德'], ['Novo Nordisk']], UNH: [['聯合健康'], ['UnitedHealth']],
  XOM: [['埃克森美孚'], ['Exxon']], CVX: [['雪佛龍'], ['Chevron']], BA: [['波音'], ['Boeing']],
  PLTR: [[], ['Palantir']], COIN: [[], ['Coinbase']], UBER: [[], ['Uber']], PYPL: [[], ['PayPal']],
  BABA: [['阿里巴巴'], ['Alibaba']], PDD: [['拼多多'], ['PDD Holdings', 'Temu']], TXN: [['德州儀器'], ['Texas Instruments']],
  LRCX: [['科林研發'], ['Lam Research']], AMAT: [['應用材料'], ['Applied Materials']], KLAC: [['科磊'], ['KLA']],
  MRVL: [['邁威爾'], ['Marvell']], ON: [['安森美'], ['onsemi']], NXPI: [['恩智浦'], ['NXP']],
  ADI: [['亞德諾'], ['Analog Devices']], CSCO: [['思科'], ['Cisco']], IBM: [[], ['IBM']], CRWD: [[], ['CrowdStrike']],
  MSTR: [['微策略'], ['MicroStrategy']], GE: [['奇異'], ['GE Aerospace']], F: [['福特'], ['Ford']],
  GM: [['通用汽車'], ['General Motors']], HD: [['家得寶'], ['Home Depot']], C: [['花旗'], ['Citigroup']],
  WFC: [['富國銀行'], ['Wells Fargo']], CAT: [['開拓重工'], ['Caterpillar']],
  SPY: [['標普500', '標普 500'], ['S&P 500']], VOO: [['標普500', '標普 500'], ['S&P 500']],
  QQQ: [['那斯達克100', '納斯達克100', '那斯達克 100'], ['Nasdaq 100', 'Nasdaq-100']], TQQQ: [['那斯達克100', '納斯達克100'], ['Nasdaq 100', 'Nasdaq-100']],
  SOXX: [['費半', '費城半導體'], ['Philadelphia Semiconductor', 'chip stocks']], SMH: [['費半', '費城半導體'], ['Philadelphia Semiconductor', 'chip stocks']],
  SOXL: [['費半', '費城半導體'], ['Philadelphia Semiconductor', 'chip stocks']]
};
/* 這些代號本身是常見英文字或太短，只有寫成 $MU、(MU)、NASDAQ:MU 才算提到 */
var AMBIGUOUS_TICKERS = ['ARM', 'ON', 'NOW', 'ALL', 'CAT', 'COST', 'KEY', 'DIS', 'LOW', 'FAST', 'PLAY', 'OPEN', 'REAL', 'GOOD', 'BIG', 'CAR', 'EAT', 'FUN', 'LIFE', 'MAIN', 'SAVE', 'TRUE', 'WELL', 'HAS', 'NICE', 'RUN', 'SHOP', 'ROCK', 'TEAM', 'ZONE', 'PEAK', 'BEST', 'GOLD', 'CASH'];

function enCore_(n) {
  var s = String(n || '').trim();
  for (var i = 0; i < 3; i++) {   // 「Rocket Lab USA, Inc.」要拿掉兩層字尾
    s = s.replace(/,?\s+(Corporation|Corp\.?|Incorporated|Inc\.?|Co\.,?\s*Ltd\.?|Company Limited|Limited|Ltd\.?|Holdings?|PLC|N\.V\.|S\.A\.|AG|SE|Class [A-C]|New|USA|Technologies|Technology|Group)$/i, '').trim();
  }
  return s;
}
function uniq_(arr) { var seen = {}; return arr.filter(function (x) { var k = String(x).toLowerCase(); if (!x || seen[k]) return false; seen[k] = true; return true; }); }

/** 一檔持股的新聞比對詞：中文名、英文名、代號、使用者關鍵字（前面加 - 為排除） */
function newsTerms_(h, quoteName) {
  var zh = [], en = [], excl = [];
  String(h.keyword || '').split(/[,，、;；\n]+/).forEach(function (k) {
    k = k.trim();
    if (!k) return;
    if (/^[-－]/.test(k)) { var x = k.replace(/^[-－]\s*/, ''); if (x) excl.push(x); return; }
    (/[^\x00-\x7F]/.test(k) ? zh : en).push(k);
  });
  if (h.market === 'TW') {
    var name = h.name || (quoteName && /[^\x00-\x7F]/.test(quoteName) ? quoteName : '');
    if (name) { zh.push(name); var bare = name.replace(/[-－*＊]?\s*KY$/i, '').replace(/[*＊]/g, '').trim(); if (bare && bare !== name) zh.push(bare); }
  } else {
    var d = US_NAMES[h.code];
    if (d) { zh = zh.concat(d[0]); en = en.concat(d[1]); }
    if (h.name) (/[^\x00-\x7F]/.test(h.name) ? zh : en).push(h.name);
    if (!d && quoteName) { var c = enCore_(quoteName); if (c && c.length >= 3) en.push(c); }
  }
  return { zh: uniq_(zh), en: uniq_(en), excl: uniq_(excl), code: h.code, market: h.market };
}

function quoteOr_(arr) { return arr.map(function (t) { return '"' + String(t).replace(/"/g, '') + '"'; }).join(' OR '); }

function newsQueries_(terms, englishForUS) {
  var ex = terms.excl.map(function (x) { return ' -"' + x.replace(/"/g, '') + '"'; }).join('');
  var qs = [];
  if (terms.market === 'TW') {
    var tw = terms.zh.concat(terms.en);
    qs.push({ q: (tw.length ? quoteOr_(tw) : '"' + terms.code + '" 股票') + ex, lang: 'zh' });
  } else {
    var all = terms.zh.concat(terms.en);
    qs.push({ q: (all.length ? quoteOr_(all) : '"' + terms.code + '"') + ex, lang: 'zh' });
    if (englishForUS) qs.push({ q: (terms.en.length ? '(' + quoteOr_(terms.en) + ')' : '"' + terms.code + '"') + ' stock' + ex, lang: 'en' });
  }
  return qs;
}

function escRe_(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 標題有沒有真的提到這家公司 */
function titleMatches_(title, terms) {
  var t = String(title || '');
  var lower = t.toLowerCase();
  for (var i = 0; i < terms.excl.length; i++) if (lower.indexOf(terms.excl[i].toLowerCase()) >= 0) return false;
  for (var a = 0; a < terms.zh.length; a++) if (t.indexOf(terms.zh[a]) >= 0) return true;
  for (var b = 0; b < terms.en.length; b++) {
    if (new RegExp('(^|[^A-Za-z0-9])' + escRe_(terms.en[b]) + '([^A-Za-z0-9]|$)', 'i').test(t)) return true;
  }
  var code = terms.code;
  if (terms.market === 'TW') return new RegExp('(^|[^0-9])' + escRe_(code) + '([^0-9]|$)').test(t);
  var sym = escRe_(code).replace('\\.', '[.\\-]?');
  // $MU、NASDAQ:MU 一定是代號；(MU)、裸寫 MU 只有在代號夠長、不是常見字時才算（避免 Manchester United (MU) 這類誤判）
  if (new RegExp('(\\$' + sym + '|(NASDAQ|NYSE|Nasdaq|Nyse)\\s*[:：]\\s*' + sym + ')(?![A-Za-z])').test(t)) return true;
  if (code.length >= 3 && AMBIGUOUS_TICKERS.indexOf(code) < 0 && new RegExp('(^|[^A-Za-z0-9$])' + sym + '([^A-Za-z0-9]|$)').test(t)) return true;
  return false;
}

function newsUrl_(q, lang, days) {
  var base = 'https://news.google.com/rss/search?q=' + encodeURIComponent(q + ' when:' + days + 'd');
  return lang === 'en' ? base + '&hl=en-US&gl=US&ceid=US:en' : base + '&hl=zh-TW&gl=TW&ceid=TW:zh-Hant';
}

function parseRss_(xml, lang) {
  var items = [];
  var doc = XmlService.parse(xml);
  var channel = doc.getRootElement().getChild('channel');
  if (!channel) return items;
  channel.getChildren('item').forEach(function (it) {
    var title = (it.getChildText('title') || '').trim();
    var link = (it.getChildText('link') || '').trim();
    var pub = Date.parse(it.getChildText('pubDate') || '');
    var srcEl = it.getChild('source');
    var source = srcEl ? srcEl.getText().trim() : '';
    if (source && title.slice(-(source.length + 3)) === ' - ' + source) title = title.slice(0, -(source.length + 3)).trim();
    else if (!source) title = title.replace(/\s+-\s+[^-]{1,40}$/, '').trim();
    if (!title || !/^https?:\/\//.test(link)) return;
    items.push({ title: title, link: link, source: source, time: isFinite(pub) ? pub : null, lang: lang });
  });
  return items;
}

function titleKey_(t) {
  return String(t).toLowerCase().replace(/[\s　「」『』"'“”‘’、，,。.!！?？:：()（）\[\]【】|｜\-–—]/g, '').slice(0, 40);
}

/** codes：逗號分隔；空字串＝全部持倉。days：1~7 */
function getNews_(codesStr, daysParam, enParam, strictParam) {
  var days = Math.max(1, Math.min(7, parseInt(daysParam, 10) || 1));
  var all = readHoldings_();
  var want = codesStr ? codesStr.split(',').map(function (s) { var n = normalizeCode_(s); return n && n.code; }).filter(Boolean) : null;
  var holdings = want ? all.filter(function (h) { return want.indexOf(h.code) >= 0; }) : all;
  var englishForUS = String(enParam) !== '0';
  var strict = String(strictParam) !== '0';
  // 沒填名稱的台股、字典裡沒有的美股 → 用報價查到的公司名稱（報價多半已在快取）
  var needName = holdings.filter(function (h) { return h.market === 'TW' ? !h.name : !US_NAMES[h.code]; });
  var qn = needName.length ? getQuotes_(needName) : {};

  var result = {};
  var jobs = [];
  holdings.forEach(function (h) {
    var terms = newsTerms_(h, qn[h.code] && !qn[h.code].error ? qn[h.code].name : '');
    var qs = newsQueries_(terms, englishForUS);
    var key = 'n2:' + days + ':' + (strict ? 's' : 'a') + ':' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify([qs, terms]), Utilities.Charset.UTF_8));
    var cached = cacheGet_(key);
    if (cached) { result[h.code] = cached; return; }
    jobs.push({ h: h, qs: qs, key: key, terms: terms });
  });

  function runJobs(list, d) {
    var reqs = [];
    var map = [];
    list.forEach(function (job, ji) {
      job.qs.forEach(function (q) {
        reqs.push({ url: newsUrl_(q.q, q.lang, d), muteHttpExceptions: true, headers: { 'User-Agent': UA } });
        map.push({ ji: ji, lang: q.lang });
      });
    });
    var per = list.map(function () { return { items: [], errors: 0, total: 0 }; });
    if (!reqs.length) return per;
    var resps = [];
    // Google 新聞同時打太多會被擋，分批 10 個
    for (var i = 0; i < reqs.length; i += 10) {
      try { resps = resps.concat(UrlFetchApp.fetchAll(reqs.slice(i, i + 10))); }
      catch (e) { for (var k = i; k < Math.min(i + 10, reqs.length); k++) resps.push(null); }
    }
    resps.forEach(function (res, idx) {
      var p = per[map[idx].ji];
      p.total++;
      if (!res || res.getResponseCode() !== 200) { p.errors++; return; }
      try { p.items = p.items.concat(parseRss_(res.getContentText('UTF-8'), map[idx].lang)); }
      catch (e) { p.errors++; }
    });
    return per;
  }
  function relevant(items, terms) {
    var d = dedupe_(items);
    if (!strict) return { items: d, dropped: 0 };
    var keep = d.filter(function (it) { return titleMatches_(it.title, terms); });
    return { items: keep, dropped: d.length - keep.length };
  }

  var first = runJobs(jobs, days);
  // 篩選後一天內不到 3 則 → 自動放寬到 7 天，避免冷門股一片空白
  var retryIdx = [];
  if (days < 7) first.forEach(function (p, i) { if (p.errors < p.total && relevant(p.items, jobs[i].terms).items.length < 3) retryIdx.push(i); });
  var second = retryIdx.length ? runJobs(retryIdx.map(function (i) { return jobs[i]; }), 7) : [];

  jobs.forEach(function (job, i) {
    var p = first[i];
    var widened = false;
    var ri = retryIdx.indexOf(i);
    if (ri >= 0 && second[ri] && second[ri].errors < second[ri].total) {
      p = { items: p.items.concat(second[ri].items), errors: 0, total: second[ri].total };
      widened = true;
    }
    var rel = relevant(p.items, job.terms);
    var entry = {
      items: rel.items.slice(0, 20),
      filtered: rel.dropped,
      terms: job.terms.zh.concat(job.terms.en),
      days: widened ? 7 : days,
      widened: widened,
      error: p.total > 0 && p.errors === p.total ? 'Google 新聞暫時無法連線' : null,
      fetchedAt: Date.now()
    };
    result[job.h.code] = entry;
    if (!entry.error) cachePut_(job.key, entry, CACHE_NEWS_SEC);
  });
  return { news: result, days: days, strict: strict };
}

function dedupe_(items) {
  var seen = {};
  var out = [];
  items.slice().sort(function (a, b) { return (b.time || 0) - (a.time || 0); }).forEach(function (it) {
    var k = titleKey_(it.title);
    if (seen[k]) return;
    seen[k] = true;
    out.push(it);
  });
  return out;
}

/* ===================== 診斷 ===================== */

function diagnose_() {
  function probe(name, url) {
    var t0 = Date.now();
    try {
      var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'User-Agent': UA } });
      var code = res.getResponseCode();
      var body = res.getContentText('UTF-8');
      var ok = code === 200;
      var detail = '';
      if (ok && name === '證交所 MIS') {
        var j = JSON.parse(body); ok = !!(j.msgArray && j.msgArray.length); detail = ok ? (j.msgArray[0].n + ' ' + (j.msgArray[0].z || '-')) : '沒有資料';
      } else if (ok && name.indexOf('Yahoo') === 0) {
        var y = JSON.parse(body); var m = y.chart && y.chart.result && y.chart.result[0] && y.chart.result[0].meta; ok = !!(m && m.regularMarketPrice); detail = ok ? (m.symbol + ' ' + m.regularMarketPrice) : '沒有資料';
      } else if (ok && name.indexOf('Google 新聞') === 0) {
        var n = parseRss_(body, 'zh').length; ok = n > 0; detail = n + ' 則';
      } else if (ok && name.indexOf('除權息預告') === 0) {
        var arr = JSON.parse(body); ok = Array.isArray(arr); detail = ok ? (arr.length + ' 筆') : '格式不符';
      } else if (ok && name === '匯率備援') {
        var r = JSON.parse(body); ok = !!(r.rates && r.rates.TWD); detail = ok ? ('USD/TWD ' + r.rates.TWD) : '沒有資料';
      } else if (!ok) {
        detail = 'HTTP ' + code;
      }
      return { name: name, ok: ok, detail: detail, ms: Date.now() - t0 };
    } catch (e) {
      return { name: name, ok: false, detail: String(e && e.message || e).slice(0, 120), ms: Date.now() - t0 };
    }
  }
  var sheetOk = true, sheetDetail = '';
  try { sheetDetail = readHoldings_().length + ' 檔持倉'; } catch (e) { sheetOk = false; sheetDetail = e.userMessage || e.message; }
  return {
    version: VERSION,
    checks: [
      { name: '持倉試算表', ok: sheetOk, detail: sheetDetail, ms: 0 },
      probe('證交所 MIS', 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=' + encodeURIComponent('tse_2330.tw') + '&json=1&delay=0'),
      probe('Yahoo（台股備援）', 'https://query1.finance.yahoo.com/v8/finance/chart/2330.TW?range=1d&interval=1d'),
      probe('Yahoo（美股）', 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=1d'),
      probe('Yahoo（匯率）', 'https://query1.finance.yahoo.com/v8/finance/chart/TWD%3DX?range=1d&interval=1d'),
      probe('匯率備援', 'https://open.er-api.com/v6/latest/USD'),
      probe('Google 新聞', newsUrl_('台積電', 'zh', 1)),
      probeMops_(),
      probe('除權息預告（上市）', 'https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL'),
      probe('除權息預告（上櫃）', 'https://www.tpex.org.tw/openapi/v1/tpex_exright_prepost'),
      probeYahooCal_()
    ]
  };
}

/* ===================== 重要時程 ===================== */

var FIN_HOLDINGS = ['2880', '2881', '2882', '2883', '2884', '2885', '2886', '2887', '2888', '2889', '2890', '2891', '2892', '5880'];
var EVENT_PAST_DAYS = 7;      // 也列出最近 7 天已過的時程
var EVENT_AHEAD_DAYS = 180;   // 往後看半年

/** 台北時間的「今天」(UTC 00:00 的 Date，只用 getUTC* 讀) */
function tpeToday_() {
  var d = new Date(Date.now() + 8 * 3600e3);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function ymd_(d) {
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
}
function addDays_(d, n) { return new Date(d.getTime() + n * 86400e3); }
/** 週六、週日順延到週一（國定假日無法得知，僅處理週末） */
function nextWeekday_(d) {
  var w = d.getUTCDay();
  return w === 6 ? addDays_(d, 2) : w === 0 ? addDays_(d, 1) : d;
}
/** 民國日期 → YYYY-MM-DD。接受 1151030、115/10/30、115年10月30日、2026-10-30 */
function rocToIso_(v) {
  var s = String(v == null ? '' : v).trim();
  var m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  m = s.match(/^(\d{2,3})\D+(\d{1,2})\D+(\d{1,2})\D*$/);
  if (!m) { var dg = s.replace(/\D/g, ''); if (dg.length === 7) m = [0, dg.slice(0, 3), dg.slice(3, 5), dg.slice(5, 7)]; }
  if (!m) return null;
  var y = +m[1] + 1911, mo = +m[2], da = +m[3];
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  return y + '-' + ('0' + mo).slice(-2) + '-' + ('0' + da).slice(-2);
}
function inWindow_(iso, today) {
  if (!iso) return false;
  var t = Date.parse(iso + 'T00:00:00Z');
  return t >= addDays_(today, -EVENT_PAST_DAYS).getTime() && t <= addDays_(today, EVENT_AHEAD_DAYS).getTime();
}
function isEtf_(code) { return /^0[0-2]/.test(code); }   // ETF（00xx）、REIT、ETN 沒有法說會與財報期限
function cashNum_(v) {
  var n = parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
  return isFinite(n) && n > 0 ? n : null;
}

/** 台股財報／月營收法定期限（全市場同一天，合併成一筆並列出受影響的持股） */
function deadlineEvents_(twStocks, today) {
  var out = [];
  if (!twStocks.length) return out;
  var normal = twStocks.filter(function (h) { return FIN_HOLDINGS.indexOf(h.code) < 0; }).map(function (h) { return h.code; });
  var fin = twStocks.filter(function (h) { return FIN_HOLDINGS.indexOf(h.code) >= 0; }).map(function (h) { return h.code; });
  var all = twStocks.map(function (h) { return h.code; });
  var y0 = today.getUTCFullYear();
  function push(y, mo, d, codes, title, detail) {
    if (!codes.length) return;
    var raw = new Date(Date.UTC(y, mo - 1, d));
    var due = nextWeekday_(raw);
    var iso = ymd_(due);
    if (!inWindow_(iso, today)) return;
    out.push({
      id: 'dl:' + iso + ':' + title, type: 'deadline', date: iso, time: null, codes: codes, title: title,
      detail: detail + (due.getTime() !== raw.getTime() ? '（' + (mo) + '/' + d + ' 遇週末順延）' : ''), source: '法規'
    });
  }
  for (var y = y0; y <= y0 + 1; y++) {
    for (var m = 1; m <= 12; m++) {
      var pm = m === 1 ? 12 : m - 1;
      push(y, m, 10, all, pm + ' 月營收公布期限', '上市櫃公司最晚於每月 10 日公布上月營收，多數公司會提早公布');
    }
    push(y, 3, 31, all, (y - 1912) + ' 年度財報公告期限', '年度財務報告最晚公告日');
    push(y, 5, 15, normal, '第一季財報公告期限', '一般上市櫃公司 Q1 財報最晚公告日');
    push(y, 8, 14, normal, '第二季財報公告期限', '一般上市櫃公司 Q2 財報最晚公告日');
    push(y, 11, 14, normal, '第三季財報公告期限', '一般上市櫃公司 Q3 財報最晚公告日');
    push(y, 5, 30, fin, '第一季財報公告期限（金控）', '金融控股公司 Q1 財報最晚公告日');
    push(y, 8, 31, fin, '第二季財報公告期限（金控）', '金融控股公司 Q2 財報最晚公告日');
    push(y, 11, 29, fin, '第三季財報公告期限（金控）', '金融控股公司 Q3 財報最晚公告日');
  }
  // 月營收每月都有，只列接下來 2 次，避免洗版
  var todayIso = ymd_(today), revKept = 0;
  out = out.filter(function (e) {
    if (!/月營收/.test(e.title)) return true;
    if (e.date < todayIso || revKept >= 2) return false;
    revKept++; return true;
  });
  return out;
}

/** 把 HTML 表格拆成二維文字陣列 */
function htmlTableRows_(html, tableId) {
  var start = html.indexOf('id="' + tableId + '"');
  if (start < 0) start = html.indexOf("id='" + tableId + "'");
  if (start < 0) return null;
  var end = html.indexOf('</table>', start);
  var t = html.slice(start, end < 0 ? undefined : end);
  var rows = [];
  var trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi, m;
  while ((m = trRe.exec(t))) {
    var cells = [];
    var tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi, c;
    while ((c = tdRe.exec(m[1]))) {
      cells.push(c[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/[ \t　]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim());
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/** 台股法說會：公開資訊觀測站 t100sb02_1（舊版頁面），每檔查今年（11、12 月再查明年） */
function mopsConfReq_(code, typek, rocYear) {
  return {
    url: 'https://mopsov.twse.com.tw/mops/web/ajax_t100sb02_1',
    method: 'post',
    payload: { encodeURIComponent: '1', step: '1', firstin: '1', off: '1', TYPEK: typek, year: String(rocYear), month: '', co_id: code },
    muteHttpExceptions: true,
    headers: { 'User-Agent': UA, 'Referer': 'https://mopsov.twse.com.tw/mops/web/t100sb02_1' }
  };
}
function parseMopsConf_(html) {
  if (/查無資料|查無所需資料/.test(html)) return [];
  var rows = htmlTableRows_(html, 'myTable');
  if (!rows || rows.length < 2) return null;     // null＝頁面格式不對（被擋或改版）
  var head = rows[0];
  function col(name, fallback) { var i = head.indexOf(name); return i >= 0 ? i : fallback; }
  var cCode = col('公司代號', 0), cName = col('公司名稱', 1), cDate = col('召開法人說明會日期', 2),
      cTime = col('召開法人說明會時間', 3), cPlace = col('召開法人說明會地點', 4), cSum = col('法人說明會擇要訊息', 5);
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    var iso = rocToIso_(r[cDate]);
    if (!iso || !/^\d/.test(r[cCode] || '')) continue;   // 第二列表頭或空列
    out.push({ code: r[cCode], name: r[cName] || '', date: iso, time: (r[cTime] || '').trim(), place: (r[cPlace] || '').trim(), summary: (r[cSum] || '').trim() });
  }
  return out;
}
function confEvents_(stocks, quotes, today) {
  var events = [], status = { ok: true, detail: '' };
  if (!stocks.length) return { events: events, status: status };
  var roc = today.getUTCFullYear() - 1911;
  var years = today.getUTCMonth() >= 10 ? [roc, roc + 1] : [roc];
  var reqs = [], meta = [];
  stocks.forEach(function (h) {
    var q = quotes[h.code];
    var typeks = q && q.exchange === 'OTC' ? ['otc'] : q && q.exchange === 'TWSE' ? ['sii'] : ['sii', 'otc'];
    typeks.forEach(function (tk) {
      years.forEach(function (y) { reqs.push(mopsConfReq_(h.code, tk, y)); meta.push(h.code); });
    });
  });
  var resps = [];
  for (var i = 0; i < reqs.length; i += 6) {   // 觀測站有防爬限制，一次最多 6 個
    try { resps = resps.concat(UrlFetchApp.fetchAll(reqs.slice(i, i + 6))); }
    catch (e) { for (var k = i; k < Math.min(i + 6, reqs.length); k++) resps.push(null); }
  }
  var fails = 0, seen = {};
  resps.forEach(function (res, idx) {
    var list = null;
    if (res && res.getResponseCode() === 200) {
      try { list = parseMopsConf_(res.getContentText('UTF-8')); } catch (e) { list = null; }
    }
    if (list === null) { fails++; return; }
    list.forEach(function (c) {
      if (c.code !== meta[idx] || !inWindow_(c.date, today)) return;
      var id = 'conf:' + c.code + ':' + c.date + ':' + c.time;
      if (seen[id]) return; seen[id] = true;
      events.push({ id: id, type: 'conf', date: c.date, time: /^\d{1,2}:\d{2}/.test(c.time) ? c.time.slice(0, 5) : null,
        codes: [c.code], title: '法說會', place: c.place, detail: c.summary, source: '公開資訊觀測站' });
    });
  });
  if (fails && fails === resps.length) status = { ok: false, detail: '公開資訊觀測站暫時無法連線，法說會資料抓不到' };
  else if (fails) status = { ok: false, detail: '部分公司的法說會資料抓不到' };
  return { events: events, status: status };
}

/** 台股除權息：證交所 TWT48U_ALL＋櫃買 tpex_exright_prepost */
function exdivTwEvents_(holdings, today) {
  var want = {};
  holdings.forEach(function (h) { want[h.code] = h; });
  var events = [], errs = [];
  var srcs = [
    { name: '上市', url: 'https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL', code: ['Code'], date: ['Date'], kind: ['Exdividend'], cash: ['CashDividend'], stock: ['StockDividendRatio'] },
    { name: '上櫃', url: 'https://www.tpex.org.tw/openapi/v1/tpex_exright_prepost', code: ['SecuritiesCompanyCode', 'Code'], date: ['ExRrightsExDividendDate', 'ExRightsExDividendDate', 'Date'], kind: ['ExRrightsExDividend', 'ExRightsExDividend', 'Exdividend'], cash: ['CashDividend'], stock: ['StockDividendRatio'] }
  ];
  var resps;
  try {
    resps = UrlFetchApp.fetchAll(srcs.map(function (s) { return { url: s.url, muteHttpExceptions: true, headers: { 'User-Agent': UA, 'Accept': 'application/json' } }; }));
  } catch (e) { return { events: [], status: { ok: false, detail: '除權息預告表暫時無法連線' } }; }
  resps.forEach(function (res, i) {
    var s = srcs[i];
    var arr = null;
    if (res.getResponseCode() === 200) { try { arr = JSON.parse(res.getContentText('UTF-8')); } catch (e) { arr = null; } }
    if (!Array.isArray(arr)) { errs.push(s.name); return; }
    function pick(row, keys) { for (var k = 0; k < keys.length; k++) if (row[keys[k]] != null) return row[keys[k]]; return null; }
    arr.forEach(function (row) {
      var code = String(pick(row, s.code) || '').trim().toUpperCase();
      if (!want[code]) return;
      var iso = rocToIso_(pick(row, s.date));
      if (!inWindow_(iso, today)) return;
      var kind = String(pick(row, s.kind) || '').trim();       // 權、息、權息
      var cash = cashNum_(pick(row, s.cash));
      var stockR = cashNum_(pick(row, s.stock));
      var title = kind === '權' ? '除權' : kind === '權息' ? '除權息' : '除息';
      events.push({ id: 'ex:' + code + ':' + iso + ':' + title, type: 'exdiv', date: iso, time: null, codes: [code], title: title,
        cash: cash, stockRatio: stockR, currency: 'TWD', source: s.name === '上市' ? '證交所' : '櫃買中心' });
    });
  });
  return { events: events, status: errs.length ? { ok: false, detail: errs.join('、') + '除權息預告表暫時抓不到' } : { ok: true, detail: '' } };
}

/** Yahoo 需要 cookie＋crumb 才能查財報日 */
function yahooAuth_(force) {
  var c = force ? null : cacheGet_('yh:auth');
  if (c) return c;
  var cookie = '';
  ['https://fc.yahoo.com', 'https://finance.yahoo.com/'].some(function (u) {
    try {
      var r = UrlFetchApp.fetch(u, { muteHttpExceptions: true, followRedirects: false, headers: { 'User-Agent': UA } });
      var h = r.getAllHeaders()['Set-Cookie'];
      var list = Array.isArray(h) ? h : h ? [h] : [];
      cookie = list.map(function (x) { return String(x).split(';')[0]; }).filter(function (x) { return /=/.test(x); }).join('; ');
    } catch (e) { cookie = ''; }
    return !!cookie;
  });
  if (!cookie) return null;
  var crumb = '';
  ['https://query1.finance.yahoo.com/v1/test/getcrumb', 'https://query2.finance.yahoo.com/v1/test/getcrumb'].some(function (u) {
    try {
      var r = UrlFetchApp.fetch(u, { muteHttpExceptions: true, headers: { 'User-Agent': UA, 'Cookie': cookie } });
      var t = r.getContentText().trim();
      if (r.getResponseCode() === 200 && t && t.length < 40 && !/[<{\s]/.test(t)) crumb = t;
    } catch (e) { crumb = ''; }
    return !!crumb;
  });
  if (!crumb) return null;
  var auth = { cookie: cookie, crumb: crumb };
  cachePut_('yh:auth', auth, 21600);
  return auth;
}

function nyParts_(ms) {
  // 美東時間（自動處理夏令時間：3 月第二個週日～11 月第一個週日）
  var d = new Date(ms);
  var y = d.getUTCFullYear();
  function nthSunday(month, n) { var first = new Date(Date.UTC(y, month, 1)); var add = (7 - first.getUTCDay()) % 7 + (n - 1) * 7; return Date.UTC(y, month, 1 + add); }
  var dstStart = nthSunday(2, 2) + 7 * 3600e3;   // 2:00 EST = 07:00 UTC
  var dstEnd = nthSunday(10, 1) + 6 * 3600e3;    // 2:00 EDT = 06:00 UTC
  var off = ms >= dstStart && ms < dstEnd ? -4 : -5;
  var n = new Date(ms + off * 3600e3);
  return { iso: ymd_(n), hour: n.getUTCHours(), minute: n.getUTCMinutes() };
}

function usEvents_(stocks, today) {
  var events = [], status = { ok: true, detail: '' };
  if (!stocks.length) return { events: events, status: status };
  var auth = yahooAuth_(false);
  if (!auth) return { events: [], status: { ok: false, detail: 'Yahoo 財報日資料暫時無法取得' } };
  function fetchAllWith(a) {
    return UrlFetchApp.fetchAll(stocks.map(function (h) {
      return { url: 'https://query2.finance.yahoo.com/v10/finance/quoteSummary/' + encodeURIComponent(yahooSymbol_(h.code, 'US')) +
        '?modules=calendarEvents,defaultKeyStatistics&crumb=' + encodeURIComponent(a.crumb),
        muteHttpExceptions: true, headers: { 'User-Agent': UA, 'Cookie': a.cookie } };
    }));
  }
  var resps;
  try {
    resps = fetchAllWith(auth);
    if (resps.every(function (r) { return r.getResponseCode() === 401; })) {   // crumb 過期 → 重拿一次
      auth = yahooAuth_(true);
      if (auth) resps = fetchAllWith(auth);
    }
  } catch (e) { return { events: [], status: { ok: false, detail: 'Yahoo 財報日資料暫時無法取得' } }; }
  var fails = 0;
  resps.forEach(function (res, i) {
    var h = stocks[i];
    var r = null;
    if (res.getResponseCode() === 200) {
      try { var j = JSON.parse(res.getContentText('UTF-8')); r = j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0]; } catch (e) { r = null; }
    }
    if (!r) { if (res.getResponseCode() !== 404) fails++; return; }
    var cal = r.calendarEvents || {};
    var e = cal.earnings || {};
    var dates = (e.earningsDate || []).map(function (x) { return x && x.raw ? x.raw * 1000 : null; }).filter(Boolean).sort();
    if (dates.length) {
      // 日期取 UTC 日期（Yahoo 只有日期時會給 UTC 00:00）；有具體時間時才用美東時間判斷盤前／盤後
      var first = new Date(dates[0]);
      var p = { iso: ymd_(first) };
      var est = !!e.isEarningsDateEstimate;
      var lastIso = ymd_(new Date(dates[dates.length - 1]));
      var range = lastIso !== p.iso ? lastIso : null;
      var timing = null;
      if (!range && (first.getUTCHours() || first.getUTCMinutes())) {
        var ny = nyParts_(dates[0]);
        var mins = ny.hour * 60 + ny.minute;
        if (mins < 9 * 60 + 30) timing = '盤前';
        else if (mins >= 16 * 60) timing = '盤後';
        else timing = '盤中';
      }
      if (inWindow_(p.iso, today) || (range && inWindow_(range, today))) {
        events.push({ id: 'er:' + h.code + ':' + p.iso, type: 'earnings', date: p.iso, dateEnd: range, time: null, timing: timing,
          codes: [h.code], title: '財報公布', estimate: est || !!range,
          detail: (timing ? '美東時間' + timing + '公布，台灣時間' + (timing === '盤後' ? '隔天清晨' : timing === '盤前' ? '當天晚上' : '當天深夜') : '公布時間未定') + (est || range ? '；日期為預估，公司正式公告後會更新' : ''),
          source: 'Yahoo' });
      }
    }
    var ex = cal.exDividendDate && cal.exDividendDate.raw ? ymd_(new Date(cal.exDividendDate.raw * 1000)) : null;
    if (ex && inWindow_(ex, today)) {
      var ks = r.defaultKeyStatistics || {};
      var last = ks.lastDividendValue && ks.lastDividendValue.raw ? ks.lastDividendValue.raw : null;
      var pay = cal.dividendDate && cal.dividendDate.raw ? ymd_(new Date(cal.dividendDate.raw * 1000)) : null;
      events.push({ id: 'ex:' + h.code + ':' + ex, type: 'exdiv', date: ex, time: null, codes: [h.code], title: '除息',
        cash: last, cashIsLast: true, payDate: pay, currency: 'USD', source: 'Yahoo' });
    }
  });
  if (fails && fails === resps.length) status = { ok: false, detail: 'Yahoo 財報日資料暫時無法取得' };
  else if (fails) status = { ok: false, detail: '部分美股的財報日抓不到' };
  return { events: events, status: status };
}

function getEvents_() {
  var holdings = readHoldings_();
  var today = tpeToday_();
  var key = 'ev:' + ymd_(today) + ':' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, holdings.map(function (h) { return h.market + h.code; }).sort().join(','), Utilities.Charset.UTF_8));
  var cached = cacheGet_(key);
  if (cached) return cached;

  var tw = holdings.filter(function (h) { return h.market === 'TW'; });
  var twStocks = tw.filter(function (h) { return !isEtf_(h.code); });
  var us = holdings.filter(function (h) { return h.market === 'US'; });
  var quotes = twStocks.length ? getQuotes_(twStocks) : {};

  var conf = confEvents_(twStocks, quotes, today);
  var exTw = tw.length ? exdivTwEvents_(tw, today) : { events: [], status: { ok: true, detail: '' } };
  var usr = usEvents_(us, today);
  var dl = deadlineEvents_(twStocks, today);

  var events = conf.events.concat(exTw.events, usr.events, dl).sort(function (a, b) {
    return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.time || '99') < (b.time || '99') ? -1 : 1;
  });
  var sources = {};
  if (twStocks.length) sources.conf = conf.status;
  if (tw.length) sources.exTw = exTw.status;
  if (us.length) sources.us = usr.status;
  var result = { events: events, sources: sources, today: ymd_(today), fetchedAt: Date.now() };
  var anyErr = Object.keys(sources).some(function (k) { return !sources[k].ok; });
  cachePut_(key, result, anyErr ? CACHE_EVENTS_ERR_SEC : CACHE_EVENTS_SEC);
  return result;
}

function probeMops_() {
  var t0 = Date.now();
  try {
    var res = UrlFetchApp.fetch(mopsConfReq_('2330', 'sii', tpeToday_().getUTCFullYear() - 1911).url, mopsConfReq_('2330', 'sii', tpeToday_().getUTCFullYear() - 1911));
    var list = res.getResponseCode() === 200 ? parseMopsConf_(res.getContentText('UTF-8')) : null;
    return { name: '法說會（觀測站）', ok: list !== null, detail: list === null ? ('無法讀取（HTTP ' + res.getResponseCode() + '）') : ('台積電今年 ' + list.length + ' 場'), ms: Date.now() - t0 };
  } catch (e) { return { name: '法說會（觀測站）', ok: false, detail: String(e && e.message || e).slice(0, 120), ms: Date.now() - t0 }; }
}

function probeYahooCal_() {
  var t0 = Date.now();
  var a = yahooAuth_(true);
  if (!a) return { name: 'Yahoo 財報日', ok: false, detail: '取不到 Yahoo 驗證碼', ms: Date.now() - t0 };
  try {
    var res = UrlFetchApp.fetch('https://query2.finance.yahoo.com/v10/finance/quoteSummary/AAPL?modules=calendarEvents&crumb=' + encodeURIComponent(a.crumb), { muteHttpExceptions: true, headers: { 'User-Agent': UA, 'Cookie': a.cookie } });
    var j = JSON.parse(res.getContentText('UTF-8'));
    var e = j.quoteSummary.result[0].calendarEvents.earnings.earningsDate;
    return { name: 'Yahoo 財報日', ok: !!(e && e.length), detail: e && e.length ? ('AAPL ' + e[0].fmt) : '沒有資料', ms: Date.now() - t0 };
  } catch (err) { return { name: 'Yahoo 財報日', ok: false, detail: String(err && err.message || err).slice(0, 120), ms: Date.now() - t0 }; }
}
