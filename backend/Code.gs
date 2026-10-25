/**
 * 持股新聞 — Google Apps Script 後端
 *
 * 功能：
 *   1. 持倉存在這份 Google 試算表的「持倉」工作表（跨裝置同步的來源）
 *   2. 台股報價：證交所 MIS（上市 tse／上櫃 otc 自動判斷）→ 失敗時改用 Yahoo Finance
 *   3. 美股報價：Yahoo Finance（query1 → query2 備援）
 *   4. 美元兌台幣匯率：Yahoo（TWD=X）→ open.er-api.com 備援
 *   5. 每檔股票的新聞：Google 新聞 RSS
 *
 * 安裝：見 README。第一次請在編輯器執行 setup()，再「部署 → 新增部署作業 → 網頁應用程式」。
 */

var SHEET_HOLD = '持倉';
var SHEET_INFO = '說明';
var HEADERS = ['代號', '市場', '名稱', '股數', '平均成本', '新聞關鍵字', '備註'];
var VERSION = '1.0.0';

var CACHE_QUOTE_SEC = 15;
var CACHE_FX_SEC = 1800;
var CACHE_NEWS_SEC = 600;
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
      case 'news': return getNews_(String(p.codes || ''), p.days, p.en);
      case 'lookup': return lookup_(String(p.code || ''));
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

function newsQueries_(h, englishForUS) {
  var qs = [];
  if (h.keyword) {
    qs.push({ q: h.keyword, lang: h.market === 'US' && /^[\x00-\x7F]*$/.test(h.keyword) ? 'en' : 'zh' });
    return qs;
  }
  if (h.market === 'TW') {
    var name = h.name || '';
    qs.push({ q: name ? '"' + name + '"' : h.code + ' 股票', lang: 'zh' });
  } else {
    qs.push({ q: h.name && /[^\x00-\x7F]/.test(h.name) ? '"' + h.name + '" OR ' + h.code : h.code + ' 股', lang: 'zh' });
    if (englishForUS) qs.push({ q: '"' + h.code + '" stock', lang: 'en' });
  }
  return qs;
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
function getNews_(codesStr, daysParam, enParam) {
  var days = Math.max(1, Math.min(7, parseInt(daysParam, 10) || 1));
  var all = readHoldings_();
  var want = codesStr ? codesStr.split(',').map(function (s) { var n = normalizeCode_(s); return n && n.code; }).filter(Boolean) : null;
  var holdings = want ? all.filter(function (h) { return want.indexOf(h.code) >= 0; }) : all;
  var englishForUS = String(enParam) !== '0';
  // 試算表沒填名稱的台股 → 用報價查到的公司名稱搜尋新聞（報價多半已在快取）
  var noName = holdings.filter(function (h) { return !h.name && !h.keyword && h.market === 'TW'; });
  if (noName.length) {
    var qn = getQuotes_(noName);
    noName.forEach(function (h) { if (qn[h.code] && qn[h.code].name && /[^\x00-\x7F]/.test(qn[h.code].name)) h.name = qn[h.code].name; });
  }

  var result = {};
  var jobs = [];
  holdings.forEach(function (h) {
    var qs = newsQueries_(h, englishForUS);
    var key = 'n:' + days + ':' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(qs), Utilities.Charset.UTF_8));
    var cached = cacheGet_(key);
    if (cached) { result[h.code] = cached; return; }
    jobs.push({ h: h, qs: qs, key: key });
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

  var first = runJobs(jobs, days);
  // 一天內不到 3 則 → 自動放寬到 7 天，避免冷門股一片空白
  var retryIdx = [];
  if (days < 7) first.forEach(function (p, i) { if (p.errors < p.total && dedupe_(p.items).length < 3) retryIdx.push(i); });
  var second = retryIdx.length ? runJobs(retryIdx.map(function (i) { return jobs[i]; }), 7) : [];

  jobs.forEach(function (job, i) {
    var p = first[i];
    var widened = false;
    var ri = retryIdx.indexOf(i);
    if (ri >= 0 && second[ri] && second[ri].errors < second[ri].total) {
      p = { items: p.items.concat(second[ri].items), errors: 0, total: second[ri].total };
      widened = true;
    }
    var items = dedupe_(p.items).slice(0, 20);
    var entry = {
      items: items,
      days: widened ? 7 : days,
      widened: widened,
      error: p.total > 0 && p.errors === p.total ? 'Google 新聞暫時無法連線' : null,
      fetchedAt: Date.now()
    };
    result[job.h.code] = entry;
    if (!entry.error) cachePut_(job.key, entry, CACHE_NEWS_SEC);
  });
  return { news: result, days: days };
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
      probe('Google 新聞', newsUrl_('台積電', 'zh', 1))
    ]
  };
}
