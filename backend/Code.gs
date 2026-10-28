/**
 * 持股新聞 — Google Apps Script 後端
 *
 * 功能：
 *   1. 持倉存在這份 Google 試算表的「持倉」工作表（跨裝置同步的來源）
 *   2. 台股報價：證交所 MIS（上市 tse／上櫃 otc 自動判斷）→ 失敗時改用 Yahoo Finance
 *   3. 美股報價：Yahoo Finance（query1 → query2 備援）
 *   4. 美元兌台幣匯率：Yahoo（TWD=X）→ open.er-api.com 備援
 *   5. 每檔股票的新聞：Google 新聞 RSS
 *   8. 每日市值：台北時間每天 13:30（等收盤價公布）記錄總市值與每檔明細到「每日市值」「市值明細」工作表
 *   7. 走勢圖：Yahoo 分鐘線＋每分鐘排程紀錄的證交所報價（台股 Yahoo 延遲 20 分鐘，用紀錄補上）
 *   6. 重要時程：台股法說會（公開資訊觀測站）、美股財報日與除息日（Yahoo）、
 *      台股除權息（證交所／櫃買預告表）、台股財報與月營收法定公告期限
 *
 * 安裝：見 README。第一次請在編輯器執行 setup()，再「部署 → 新增部署作業 → 網頁應用程式」。
 */

var SHEET_HOLD = '持倉';
var SHEET_INFO = '說明';
var HEADERS = ['代號', '市場', '名稱', '股數', '平均成本', '新聞關鍵字', '備註'];
var VERSION = '1.4.0';

var CACHE_QUOTE_SEC = 15;        // 開盤中報價快取
var CACHE_QUOTE_CLOSED_SEC = 600; // 收盤後報價快取（價格不會變，省額度）
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
  ensureDailySheets_();
  var rec = '';
  try { ensureRecorder_(); rec = '已建立盤中紀錄排程（每分鐘）。'; }
  catch (e) { rec = '盤中紀錄排程建立失敗：' + (e && e.message) + '。台股當日走勢最近 20 分鐘會缺資料。'; }
  info.getRange('A5:B5').setValues([['盤中紀錄', rec]]);
  Logger.log('設定完成。存取金鑰：' + token + '\n' + rec);
  return token;
}

/** 每分鐘排程：台股盤中紀錄證交所報價，給走勢圖用（Yahoo 台股延遲 20 分鐘） */
function ensureRecorder_() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'recordTick'; });
  if (!exists) ScriptApp.newTrigger('recordTick').timeBased().everyMinutes(1).create();
}

/** 不想要盤中紀錄時執行（台股當日走勢最近 20 分鐘會缺資料） */
function removeRecorder() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'recordTick') ScriptApp.deleteTrigger(t); });
}

/** 排程呼叫：只在台股開盤時間做事，其他時間立刻結束 */
function recordTick() {
  flushUsage_(true);
  try { snapshotDaily_(); } catch (e) { Logger.log('每日市值紀錄失敗：' + (e && e.message)); }
  if (!marketOpen_('TW')) return;
  var tw = readHoldings_().filter(function (h) { return h.market === 'TW'; });
  if (!tw.length) return;
  getQuotes_(tw, 20);   // 內部會把成交價寫進紀錄
  cachePut_('rec:last', Date.now(), 21600);
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
      case 'chart': return chart_(String(p.code || ''), String(p.range || '1d'));
      case 'live': return live_(String(p.code || ''));
      case 'spark': return spark_();
      case 'history': return history_(p.detail === '1');
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
        case 'settings': return saveSettings_(body.settings || {});
        default: throw userError_('未知的動作：' + body.action);
      }
    } finally {
      lock.releaseLock();
    }
  });
}

function handle_(fn) {
  var out;
  QUOTA_NOTICE = null;
  try {
    var data = fn();
    out = { ok: true, data: data, serverTime: Date.now() };
  } catch (err) {
    if (isQuotaErr_(err) && err.code !== 'quota') err = userError_(QUOTA_MSG, 'quota');
    out = {
      ok: false,
      error: (err && err.userMessage) || ('伺服器錯誤：' + (err && err.message ? err.message : String(err))),
      code: (err && err.code) || 'server_error',
      serverTime: Date.now()
    };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

var QUOTA_MSG = '今天的 Google 免費連線額度（每天 20,000 次）已用完，約 24 小時後恢復；期間無法更新報價與新聞。';
function isQuotaErr_(e) {
  return !!e && (e.code === 'quota' || /too many times|Service invoked too many|Bandwidth quota|quota exceeded/i.test(String(e.message || e)));
}
/** 在吞掉例外的 catch 裡呼叫：額度用完的錯誤要往上丟，不能被當成「查不到資料」 */
function rethrowQuota_(e) {
  if (e && e.code === 'quota') throw e;            // 自己的安全上限：保留原訊息
  if (isQuotaErr_(e)) throw userError_(QUOTA_MSG, 'quota');
}
var QUOTA_NOTICE = null;   // 這次請求中報價因額度暫停時的說明（回傳給前端顯示）

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
  cachePut_('codes:TW', list.filter(function (h) { return h.market === 'TW'; }).map(function (h) { return h.code; }), 21600);
  cachePut_('codes:US', list.filter(function (h) { return h.market === 'US'; }).map(function (h) { return h.code; }), 21600);
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
  try { resps = fetchAll_(reqs); } catch (e) { rethrowQuota_(e); return out; }
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
    try { resps = fetchAll_(reqs); } catch (e) { rethrowQuota_(e); continue; }
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

/* ===================== 連線總量與頻率控管 ===================== */
/*
 * 兩條硬性規則（不論開了幾台裝置）：
 *   1. 證交所即時報價：所有台股持股合併成「一次」請求，最多每 5 秒一次；
 *      新增股票等需要立刻查的情況，任何 5 秒內也最多 2 次（證交所限制是 5 秒 3 次）。
 *   2. Google 每日連線額度（一般帳號 20,000 次）：自己計數，
 *      超過 12,000 進入省額度模式（更新變慢），超過 16,000 只用快取、報價最多每分鐘更新一次。
 */
var BUDGET_SOFT = 12000;
var BUDGET_HARD = 16000;
var BUDGET_STOP = 19000;      // 任何 24 小時內到這個數字就完全停止對外連線（Google 上限 20,000）
var GOOGLE_DAILY_LIMIT = 20000;

/*
 * 用量以「最近 24 小時」計算（Google 的額度是從第一次請求起算 24 小時，用滑動視窗才保證任何時段都不超過）。
 * 每次連線先記在快取，最多每分鐘彙整到「每小時一格」的指令碼屬性（屬性寫入每天約 1,440 次，遠低於限制）。
 */
function hourIdx_(ms) { return Math.floor(ms / 3600e3); }
function usageBuckets_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('USAGE') || '{}'); } catch (e) { return {}; }
}
function flushUsage_(force) {
  var now = Date.now();
  var lastFlush = Number(cacheGet_('uf:flushAt')) || 0;
  if (!force && now - lastFlush < 60000) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return;
  try {
    var pending = Number(cacheGet_('uf:pending')) || 0;
    var b = usageBuckets_();
    var h = hourIdx_(now);
    if (pending) b[h] = (b[h] || 0) + pending;
    Object.keys(b).forEach(function (k) { if (Number(k) < h - 25) delete b[k]; });
    PropertiesService.getScriptProperties().setProperty('USAGE', JSON.stringify(b));
    cachePut_('uf:pending', 0, 21600);
    cachePut_('uf:flushAt', now, 21600);
  } finally { lock.releaseLock(); }
}
/** 最近 24 小時的對外連線次數 */
function usage_() {
  var b = usageBuckets_(), h = hourIdx_(Date.now()), sum = Number(cacheGet_('uf:pending')) || 0;
  Object.keys(b).forEach(function (k) { if (Number(k) > h - 24) sum += b[k]; });
  return sum;
}
function countFetch_(n) {
  if (usage_() + n > BUDGET_STOP) throw userError_(QUOTA_MSG_SELF, 'quota');
  cachePut_('uf:pending', (Number(cacheGet_('uf:pending')) || 0) + n, 21600);
  flushUsage_(false);
}
var QUOTA_MSG_SELF = '最近 24 小時的連線次數已達安全上限（19,000 次，Google 上限 20,000），暫停更新以免超過額度；用量降下來後會自動恢復。';
function budgetLevel_() { var u = usage_(); return u >= BUDGET_HARD ? 2 : u >= BUDGET_SOFT ? 1 : 0; }
function usageInfo_() { var u = usage_(); return { count: u, soft: BUDGET_SOFT, hard: BUDGET_HARD, stop: BUDGET_STOP, limit: GOOGLE_DAILY_LIMIT, level: u >= BUDGET_HARD ? 2 : u >= BUDGET_SOFT ? 1 : 0 }; }
function fetchAll_(reqs) { countFetch_(reqs.length); return UrlFetchApp.fetchAll(reqs); }
function fetch1_(url, opts) { countFetch_(1); return UrlFetchApp.fetch(url, opts); }

/** 例行更新的最短間隔（毫秒） */
function quoteGap_(market) {
  var lv = budgetLevel_();
  if (lv === 2) return 60000;
  if (lv === 1) return 15000;
  if (market === 'US' && Date.now() - (Number(cacheGet_('yq:fail')) || 0) < 600000) return 15000;  // Yahoo 批次查詢失敗、改逐檔查時放慢
  return 5000;
}
/** 取得某來源的抓取權（跨所有請求、所有裝置）。urgent：有股票完全沒有報價（例如剛新增）。 */
function takeSlot_(name, gapMs, urgent) {
  for (var attempt = 0; attempt < 2; attempt++) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) return false;
    var wait = 0;
    try {
      var now = Date.now();
      var hist = (cacheGet_('thr:' + name) || []).filter(function (t) { return now - t < 60000; });
      var last = hist.length ? hist[hist.length - 1] : 0;
      var in5 = hist.filter(function (t) { return now - t < 5000; });
      var ok = urgent ? in5.length < 2 : now - last >= gapMs;
      if (ok) { hist.push(now); cachePut_('thr:' + name, hist.slice(-5), 3600); return true; }
      if (!urgent) return false;
      wait = 5000 - (now - in5[0]) + 50;   // 等到 5 秒視窗裡空出位置
    } finally { lock.releaseLock(); }
    if (wait > 0 && wait <= 5100) Utilities.sleep(wait);
  }
  return false;
}

function parseYahooQuote_(r) {
  if (!r || !r.symbol) return null;
  var price = num_(r.regularMarketPrice);
  if (price === null) return null;
  var sym = String(r.symbol).toUpperCase();
  var tw = /\.TWO?$/.test(sym);
  var t = Number(r.regularMarketTime);
  return {
    code: tw ? sym.replace(/\.TWO?$/, '') : sym.replace('-', '.'),
    market: tw ? 'TW' : (sym === 'TWD=X' ? 'FX' : 'US'),
    exchange: r.exchange || r.fullExchangeName || '',
    name: String(r.shortName || r.longName || '').trim(),
    price: price,
    priceType: 'trade',
    prevClose: num_(r.regularMarketPreviousClose),
    open: num_(r.regularMarketOpen),
    high: num_(r.regularMarketDayHigh),
    low: num_(r.regularMarketDayLow),
    currency: r.currency || (tw ? 'TWD' : 'USD'),
    time: isFinite(t) && t > 0 ? (t > 1e12 ? t : t * 1000) : null,
    source: 'Yahoo'
  };
}
/** Yahoo 一次查多檔（1 次連線）。失敗回傳 ok:false，由呼叫端改逐檔查 */
function yahooQuoteBatch_(syms) {
  var out = {};
  if (!syms.length) return { quotes: out, ok: true };
  var auth = yahooAuth_(false);
  for (var attempt = 0; auth && attempt < 2; attempt++) {
    var res;
    try {
      res = fetch1_('https://query1.finance.yahoo.com/v7/finance/quote?symbols=' + encodeURIComponent(syms.join(',')) + '&crumb=' + encodeURIComponent(auth.crumb),
        { muteHttpExceptions: true, headers: { 'User-Agent': UA, 'Cookie': auth.cookie, 'Accept': 'application/json' } });
    } catch (e) { rethrowQuota_(e); break; }
    if (res.getResponseCode() === 401 && attempt === 0) { auth = yahooAuth_(true); continue; }
    if (res.getResponseCode() !== 200) break;
    try {
      var list = JSON.parse(res.getContentText('UTF-8')).quoteResponse.result || [];
      list.forEach(function (r) { var q = parseYahooQuote_(r); if (q) out[String(r.symbol).toUpperCase()] = q; });
      return { quotes: out, ok: true };
    } catch (e) { break; }
  }
  cachePut_('yq:fail', Date.now(), 3600);
  return { quotes: out, ok: false };
}

/** 台股：證交所（即時）；證交所失敗時改用 Yahoo（延遲約 20 分鐘） */
function refreshTw_(codes) {
  var out = {};
  var nf = cacheGet_('nf:TW') || {};
  var misFailAt = Number(cacheGet_('mis:fail')) || 0;
  if (Date.now() - misFailAt > 60000) {     // 證交所失敗後 1 分鐘內不再打（避免被當成攻擊）
    out = fetchTwseMis_(codes);
    if (!Object.keys(out).length) cachePut_('mis:fail', Date.now(), 600);
  }
  // 證交所查不到、且 10 分鐘內 Yahoo 也查不到的代號不再補查；證交所失敗時改用 Yahoo，但最多每分鐘一次（Yahoo 台股本來就延遲 20 分鐘）
  var misOk = Object.keys(out).length > 0;
  var miss = codes.filter(function (c) { return !out[c] && !(nf[c] && Date.now() - nf[c] < 600000); });
  if (miss.length && !misOk) {
    if (Date.now() - (Number(cacheGet_('tw:yfb')) || 0) < 60000) miss = miss.filter(function (c) { return !cacheGet_('q:TW:' + c); });
    else cachePut_('tw:yfb', Date.now(), 3600);
  }
  if (miss.length) {
    var yb = yahooQuoteBatch_([].concat.apply([], miss.map(function (c) { return [c + '.TW', c + '.TWO']; })));
    var fromY = {};
    if (yb.ok) {
      miss.forEach(function (c) { var q = yb.quotes[c + '.TW'] || yb.quotes[c + '.TWO']; if (q) fromY[c] = q; });
    } else {
      var y1 = fetchYahoo_(miss.map(function (c) { return { key: c, symbol: c + '.TW', market: 'TW' }; }));
      Object.keys(y1).forEach(function (k) { fromY[k] = y1[k]; });
      var miss2 = miss.filter(function (c) { return !fromY[c]; });
      if (miss2.length) {
        var y2 = fetchYahoo_(miss2.map(function (c) { return { key: c, symbol: c + '.TWO', market: 'TW' }; }));
        Object.keys(y2).forEach(function (k) { fromY[k] = y2[k]; });
      }
    }
    Object.keys(fromY).forEach(function (c) { fromY[c].delayed = true; out[c] = fromY[c]; });
    miss.forEach(function (c) { if (!fromY[c]) nf[c] = Date.now(); else delete nf[c]; });
    cachePut_('nf:TW', nf, 3600);
  }
  return out;
}

/** 美股：Yahoo 一次查全部持股（順便更新美元匯率）；失敗時逐檔查 */
function refreshUs_(codes) {
  var out = {};
  var nf = cacheGet_('nf:US') || {};
  var syms = codes.map(function (c) { return yahooSymbol_(c, 'US'); });
  var yb = yahooQuoteBatch_(syms.concat(['TWD=X']));
  if (yb.ok) {
    codes.forEach(function (c, i) { var q = yb.quotes[syms[i].toUpperCase()]; if (q) { q.code = c; out[c] = q; } });
    var f = yb.quotes['TWD=X'];
    if (f && f.price > 20 && f.price < 60) cachePut_('fx:USDTWD', { rate: f.price, time: f.time, source: 'Yahoo' }, CACHE_FX_SEC);
  } else {
    out = fetchYahoo_(codes.map(function (c, i) { return { key: c, symbol: syms[i], market: 'US' }; }));
  }
  codes.forEach(function (c) { if (!out[c]) nf[c] = Date.now(); else delete nf[c]; });
  cachePut_('nf:US', nf, 3600);
  return out;
}

/** 取得持倉報價：{code: quote | {error}}。maxAgeSec：可接受的快取秒數（預設：開盤 15 秒、收盤 10 分鐘） */
function getQuotes_(holdings, maxAgeSec) {
  var now = Date.now(), result = {};
  var need = { TW: [], US: [] }, urgent = { TW: false, US: false };
  holdings.forEach(function (h) {
    var c = cacheGet_('q:' + h.market + ':' + h.code);
    var maxAge = maxAgeSec != null ? maxAgeSec : (marketOpen_(h.market, now) ? CACHE_QUOTE_SEC : CACHE_QUOTE_CLOSED_SEC);
    if (c) result[h.code] = c;                 // 先用快取，抓到新的再覆蓋
    if (!c || !c._at || now - c._at > maxAge * 1000) {
      // 10 分鐘內查過且查不到的代號（代號錯誤、暫停交易）：先不重查，避免每次請求都多打一次
      var nf = cacheGet_('nf:' + h.market) || {};
      if (!c && nf[h.code] && now - nf[h.code] < 600000) return;
      need[h.market].push(h.code);
      if (!c) urgent[h.market] = true;   // 完全沒有報價（剛新增）才算急件
    }
  });
  var forRec = [];
  ['TW', 'US'].forEach(function (mk) {
    if (!need[mk].length) return;
    // 一律連同其他持股一起查：同樣 1 次連線，其他裝置接下來 5 秒都直接用快取
    var codes = need[mk].concat((cacheGet_('codes:' + mk) || []).filter(function (c) { return need[mk].indexOf(c) < 0; }));
    if (usage_() + 2 > BUDGET_STOP) { QUOTA_NOTICE = QUOTA_MSG_SELF; return; }   // 已到安全上限：只用快取
    if (!takeSlot_('q' + mk, quoteGap_(mk), urgent[mk])) return;
    var fresh;
    try { fresh = mk === 'TW' ? refreshTw_(codes) : refreshUs_(codes); }
    catch (e) { if (e && e.code === 'quota') { QUOTA_NOTICE = e.userMessage; return; } throw e; }
    Object.keys(fresh).forEach(function (code) {
      var q = fresh[code];
      q._at = Date.now();
      cachePut_('q:' + mk + ':' + code, q, CACHE_QUOTE_CLOSED_SEC);
      if (result.hasOwnProperty(code) || need[mk].indexOf(code) >= 0) result[code] = q;
      if (mk === 'TW' && q.source === 'TWSE') forRec.push(q);
    });
  });
  holdings.forEach(function (h) {
    if (!result[h.code]) result[h.code] = { code: h.code, market: h.market, error: '查不到報價（代號錯誤或資料來源暫時無法連線）' };
  });
  if (forRec.length) recAppend_(forRec);
  return result;
}

function getFx_() {
  var c = cacheGet_('fx:USDTWD');
  if (c) return c;
  if (usage_() + 2 > BUDGET_STOP) return null;
  var fx = null;
  var y = fetchYahoo_([{ key: 'FX', symbol: 'TWD=X', market: 'FX' }]);
  if (y.FX && y.FX.price > 20 && y.FX.price < 60) {
    fx = { rate: y.FX.price, time: y.FX.time, source: 'Yahoo' };
  }
  if (!fx) {
    try {
      var res = fetch1_('https://open.er-api.com/v6/latest/USD', { muteHttpExceptions: true });
      if (res.getResponseCode() === 200) {
        var j = JSON.parse(res.getContentText('UTF-8'));
        var r = j && j.rates && Number(j.rates.TWD);
        if (r > 20 && r < 60) fx = { rate: r, time: (Number(j.time_last_update_unix) || 0) * 1000 || null, source: 'ExchangeRate-API' };
      }
    } catch (e) { rethrowQuota_(e); /* 兩個來源都失敗 → 回傳 null，前端提示 */ }
  }
  if (fx) cachePut_('fx:USDTWD', fx, CACHE_FX_SEC);
  return fx;
}

function getData_() {
  var holdings = readHoldings_();
  var quotes = getQuotes_(holdings);
  // 排程沒在跑時的備援：13:31 以後有人打開 App，就補記今天（已記過會立刻略過）
  try { if (!cacheGet_('snap:' + tpeParts_(Date.now()).iso)) snapshotDaily_(); } catch (e) { if (e && e.code === 'quota') QUOTA_NOTICE = e.userMessage; }
  var hasUS = holdings.some(function (h) { return h.market === 'US'; });
  return {
    holdings: holdings.map(function (h) { delete h.row; return h; }),
    quotes: quotes,
    fx: hasUS ? (function () { try { return getFx_(); } catch (e) { if (e && e.code === 'quota') { QUOTA_NOTICE = e.userMessage; return null; } throw e; } })() : (cacheGet_('fx:USDTWD') || null),
    usage: usageInfo_(),
    notice: QUOTA_NOTICE,
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
    if (budgetLevel_() === 2) { result[h.code] = { items: [], filtered: 0, terms: [], days: days, widened: false, error: '省額度模式：新聞暫停更新', fetchedAt: Date.now() }; return; }
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
      try { resps = resps.concat(fetchAll_(reqs.slice(i, i + 10))); }
      catch (e) { rethrowQuota_(e); for (var k = i; k < Math.min(i + 10, reqs.length); k++) resps.push(null); }
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
    // 盤中 10 分鐘、收盤後 30 分鐘（新聞量少，也省額度）
    if (!entry.error) cachePut_(job.key, entry, marketOpen_('TW') || marketOpen_('US') ? CACHE_NEWS_SEC : 1800);
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
      var res = fetch1_(url, { muteHttpExceptions: true, headers: { 'User-Agent': UA } });
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
      recorderStatus_(),
      (function () { var u = usageInfo_(); return { name: '今日 Google 連線用量', ok: u.level < 2, detail: u.count.toLocaleString() + ' 次（上限 ' + u.limit.toLocaleString() + '；' + (u.level === 2 ? '已進入只用快取模式' : u.level === 1 ? '已進入省額度模式' : '正常') + '）', ms: 0 }; })(),
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
  for (var i = 0; i < reqs.length; i += 2) {   // 觀測站有防爬限制：一次 2 個、間隔 1.5 秒（時程 3 小時才查一次）
    if (i) Utilities.sleep(1500);
    try { resps = resps.concat(fetchAll_(reqs.slice(i, i + 2))); }
    catch (e) { rethrowQuota_(e); for (var k = i; k < Math.min(i + 2, reqs.length); k++) resps.push(null); }
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
    resps = fetchAll_(srcs.map(function (s) { return { url: s.url, muteHttpExceptions: true, headers: { 'User-Agent': UA, 'Accept': 'application/json' } }; }));
  } catch (e) { rethrowQuota_(e); return { events: [], status: { ok: false, detail: '除權息預告表暫時無法連線' } }; }
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
      var r = fetch1_(u, { muteHttpExceptions: true, followRedirects: false, headers: { 'User-Agent': UA } });
      var h = r.getAllHeaders()['Set-Cookie'];
      var list = Array.isArray(h) ? h : h ? [h] : [];
      cookie = list.map(function (x) { return String(x).split(';')[0]; }).filter(function (x) { return /=/.test(x); }).join('; ');
    } catch (e) { rethrowQuota_(e); cookie = ''; }
    return !!cookie;
  });
  if (!cookie) return null;
  var crumb = '';
  ['https://query1.finance.yahoo.com/v1/test/getcrumb', 'https://query2.finance.yahoo.com/v1/test/getcrumb'].some(function (u) {
    try {
      var r = fetch1_(u, { muteHttpExceptions: true, headers: { 'User-Agent': UA, 'Cookie': cookie } });
      var t = r.getContentText().trim();
      if (r.getResponseCode() === 200 && t && t.length < 40 && !/[<{\s]/.test(t)) crumb = t;
    } catch (e) { rethrowQuota_(e); crumb = ''; }
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
    return fetchAll_(stocks.map(function (h) {
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
  } catch (e) { rethrowQuota_(e); return { events: [], status: { ok: false, detail: 'Yahoo 財報日資料暫時無法取得' } }; }
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
  if (budgetLevel_() === 2) return { events: [], sources: { saving: { ok: false, detail: '省額度模式：時程暫停更新' } }, today: ymd_(today), fetchedAt: Date.now() };

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
    var res = fetch1_(mopsConfReq_('2330', 'sii', tpeToday_().getUTCFullYear() - 1911).url, mopsConfReq_('2330', 'sii', tpeToday_().getUTCFullYear() - 1911));
    var list = res.getResponseCode() === 200 ? parseMopsConf_(res.getContentText('UTF-8')) : null;
    return { name: '法說會（觀測站）', ok: list !== null, detail: list === null ? ('無法讀取（HTTP ' + res.getResponseCode() + '）') : ('台積電今年 ' + list.length + ' 場'), ms: Date.now() - t0 };
  } catch (e) { return { name: '法說會（觀測站）', ok: false, detail: String(e && e.message || e).slice(0, 120), ms: Date.now() - t0 }; }
}

function probeYahooCal_() {
  var t0 = Date.now();
  var a = yahooAuth_(true);
  if (!a) return { name: 'Yahoo 財報日', ok: false, detail: '取不到 Yahoo 驗證碼', ms: Date.now() - t0 };
  try {
    var res = fetch1_('https://query2.finance.yahoo.com/v10/finance/quoteSummary/AAPL?modules=calendarEvents&crumb=' + encodeURIComponent(a.crumb), { muteHttpExceptions: true, headers: { 'User-Agent': UA, 'Cookie': a.cookie } });
    var j = JSON.parse(res.getContentText('UTF-8'));
    var e = j.quoteSummary.result[0].calendarEvents.earnings.earningsDate;
    return { name: 'Yahoo 財報日', ok: !!(e && e.length), detail: e && e.length ? ('AAPL ' + e[0].fmt) : '沒有資料', ms: Date.now() - t0 };
  } catch (err) { return { name: 'Yahoo 財報日', ok: false, detail: String(err && err.message || err).slice(0, 120), ms: Date.now() - t0 }; }
}

/* ===================== 走勢圖 ===================== */

var REC_TTL = 21600;          // 紀錄保留 6 小時（CacheService 上限），收盤後晚上改用 Yahoo 完整資料
var REC_MAX = 3600;
var CHART_RANGES = {
  '1d': { range: '1d', interval: '1m', ttl: 120 },
  '5d': { range: '5d', interval: '5m', ttl: 600 },
  '1mo': { range: '1mo', interval: '60m', ttl: 1800 },
  '6mo': { range: '6mo', interval: '1d', ttl: 3600 },
  '1y': { range: '1y', interval: '1d', ttl: 3600 },
  '5y': { range: '5y', interval: '1wk', ttl: 21600 }
};

function tpeParts_(ms) {
  var d = new Date(ms + 8 * 3600e3);
  return { iso: ymd_(d), wd: d.getUTCDay(), mins: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
/** 開盤時間（未排除國定假日）：台股 09:00–13:35（含收盤撮合），美股美東 09:30–16:05 */
function marketOpen_(market, ms) {
  ms = ms || Date.now();
  if (market === 'TW') {
    var p = tpeParts_(ms);
    return p.wd >= 1 && p.wd <= 5 && p.mins >= 540 && p.mins <= 815;
  }
  var n = nyParts_(ms);
  var wd = new Date(Date.parse(n.iso + 'T00:00:00Z')).getUTCDay();
  var m = n.hour * 60 + n.minute;
  return wd >= 1 && wd <= 5 && m >= 570 && m <= 965;
}
/** 台股某日 09:00–13:30（台北）的毫秒區間 */
function twSession_(iso) {
  var base = Date.parse(iso + 'T00:00:00Z') - 8 * 3600e3;
  return { start: base + 9 * 3600e3, end: base + 13.5 * 3600e3 };
}

function recKey_(code, iso) { return 'rec:' + iso + ':' + code; }
/** 把證交所的成交價寫進當日紀錄（只記有成交的快照，同一筆快照不重複記） */
function recAppend_(quotes) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1500)) return;   // 搶不到鎖就這次不記，不拖慢回應
  try {
    quotes.forEach(function (q) {
      if (!q || q.market !== 'TW' || !q.time || q.priceType !== 'trade') return;
      var key = recKey_(q.code, tpeParts_(q.time).iso);
      var arr = cacheGet_(key) || [];
      var t = Math.floor(q.time / 1000);
      if (arr.length && arr[arr.length - 1][0] >= t) return;
      arr.push([t, q.price]);
      if (arr.length > REC_MAX) arr = thinRec_(arr);
      cachePut_(key, arr, REC_TTL);
    });
  } finally { lock.releaseLock(); }
}
/** 紀錄太多時：最近 1200 筆保留，較早的每分鐘只留一筆 */
function thinRec_(arr) {
  var keep = arr.slice(-1200), old = arr.slice(0, -1200), out = [], lastMin = -1;
  old.forEach(function (p) { var m = Math.floor(p[0] / 60); if (m !== lastMin) { out.push(p); lastMin = m; } });
  return out.concat(keep);
}

/** 依時間分桶，每桶保留最低與最高點（線的形狀不會失真） */
function downsample_(pts, maxPts) {
  if (pts.length <= maxPts) return pts;
  var buckets = Math.floor(maxPts / 2), size = pts.length / buckets, out = [];
  for (var b = 0; b < buckets; b++) {
    var seg = pts.slice(Math.floor(b * size), Math.floor((b + 1) * size));
    if (!seg.length) continue;
    var lo = seg[0], hi = seg[0];
    seg.forEach(function (p) { if (p[1] < lo[1]) lo = p; if (p[1] > hi[1]) hi = p; });
    if (lo === hi) out.push(lo); else if (lo[0] < hi[0]) out.push(lo, hi); else out.push(hi, lo);
  }
  var last = pts[pts.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

function parseYahooBars_(j) {
  var r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.meta) return null;
  var ts = r.timestamp || [];
  var closes = (r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close) || [];
  var pts = [];
  for (var i = 0; i < ts.length; i++) {
    var c = closes[i];
    if (c != null && isFinite(c) && c > 0) pts.push([ts[i], Math.round(c * 10000) / 10000]);
  }
  var m = r.meta;
  var periods = [];
  (m.tradingPeriods || []).forEach(function (row) {
    (Array.isArray(row) ? row : [row]).forEach(function (p) { if (p && p.start && p.end) periods.push([p.start, p.end]); });
  });
  if (!periods.length && m.currentTradingPeriod && m.currentTradingPeriod.regular) periods.push([m.currentTradingPeriod.regular.start, m.currentTradingPeriod.regular.end]);
  return {
    points: pts,
    prevClose: num_(m.previousClose) || num_(m.chartPreviousClose),
    chartPrevClose: num_(m.chartPreviousClose),
    periods: periods,
    currency: m.currency || '',
    exchange: m.exchangeName || ''
  };
}

/** 一次抓多個 Yahoo 走勢（有快取就不抓）。items: [{sym, rk}] → {sym|rk: bars | null} */
function yahooBarsMany_(items) {
  // 收盤後的當日走勢不會再變：快取 6 小時；省額度模式下其他區間快取加長
  var lv = budgetLevel_();
  var out = {}, need = [];
  items.forEach(function (it) {
    var key = 'ch:' + it.rk + ':' + it.sym;
    var c = cacheGet_(key);
    if (c) out[it.sym + '|' + it.rk] = c; else need.push(it);
  });
  var hosts = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
  for (var h = 0; h < hosts.length && need.length; h++) {
    var R = need.map(function (it) {
      var cfg = CHART_RANGES[it.rk];
      return { url: hosts[h] + '/v8/finance/chart/' + encodeURIComponent(it.sym) + '?range=' + cfg.range + '&interval=' + cfg.interval + '&includePrePost=false',
        muteHttpExceptions: true, headers: { 'User-Agent': UA, 'Accept': 'application/json' } };
    });
    var resps;
    try { resps = fetchAll_(R); } catch (e) { rethrowQuota_(e); continue; }
    var still = [];
    resps.forEach(function (res, i) {
      var it = need[i], bars = null;
      if (res.getResponseCode() === 200) { try { bars = parseYahooBars_(JSON.parse(res.getContentText('UTF-8'))); } catch (e) { bars = null; } }
      if (bars) {
        out[it.sym + '|' + it.rk] = bars;
        var ttl = CHART_RANGES[it.rk].ttl;
        if (it.rk === '1d' && it.market && !marketOpen_(it.market)) ttl = 21600;
        else if (lv) ttl = Math.min(21600, ttl * 3);
        cachePut_('ch:' + it.rk + ':' + it.sym, bars, ttl);
      }
      else if (res.getResponseCode() === 404) out[it.sym + '|' + it.rk] = null;
      else still.push(it);
    });
    need = still;
  }
  return out;
}

function isOtc_(q) { return !!q && (q.exchange === 'OTC' || /^TWO$/i.test(q.exchange)); }
function yahooSymFor_(h, q) { return h.market === 'TW' ? h.code + (isOtc_(q) ? '.TWO' : '.TW') : yahooSymbol_(h.code, 'US'); }

/** 組出一檔股票某區間的走勢。bars：yahooBarsMany_ 的結果（可能是 null）；q：報價 */
function buildChart_(h, rk, bars, q) {
  var live = q && !q.error ? q : null;
  var pts = bars ? bars.points.map(function (p) { return [p[0] * 1000, p[1]]; }) : [];
  var res = { code: h.code, market: h.market, range: rk, points: [], ref: null, refLabel: '', start: null, end: null,
    currency: h.market === 'TW' ? 'TWD' : 'USD', last: live ? { price: live.price, time: live.time, priceType: live.priceType } : null,
    gap: false, recorded: 0, open: marketOpen_(h.market) };

  if (rk === '1d') {
    if (h.market === 'TW') {
      var lastYahooDay = pts.length ? tpeParts_(pts[pts.length - 1][0]).iso : null;
      var day = live && live.time ? tpeParts_(live.time).iso : lastYahooDay;
      if (!day) day = tpeParts_(Date.now()).iso;
      var ses = twSession_(day);
      pts = pts.filter(function (p) { return p[0] >= ses.start && p[0] <= ses.end + 60e3; });
      var rec = (cacheGet_(recKey_(h.code, day)) || []).map(function (p) { return [p[0] * 1000, p[1]]; });
      res.recorded = rec.length;
      if (rec.length) pts = pts.filter(function (p) { return p[0] < rec[0][0]; }).concat(rec);
      if (live && live.time && live.priceType === 'trade' && tpeParts_(live.time).iso === day && (!pts.length || live.time > pts[pts.length - 1][0])) pts.push([live.time, live.price]);
      res.start = ses.start; res.end = ses.end;
      res.ref = live && live.prevClose && live.time && tpeParts_(live.time).iso === day ? live.prevClose : (bars && bars.prevClose);
      // 盤中但排程最近 3 分鐘沒跑：Yahoo 延遲 20 分鐘的那段會是空的
      var recLast = Number(cacheGet_('rec:last')) || 0;
      if (res.open && day === tpeParts_(Date.now()).iso && Date.now() - recLast > 3 * 60e3) res.gap = true;
    } else {
      var lastT = pts.length ? pts[pts.length - 1][0] / 1000 : null;
      var per = bars && bars.periods.filter(function (p) { return lastT != null && lastT >= p[0] - 60 && lastT <= p[1] + 60; })[0];
      if (!per && bars && bars.periods.length) per = bars.periods[bars.periods.length - 1];
      if (per) { res.start = per[0] * 1000; res.end = per[1] * 1000; }
      else if (pts.length) { res.start = pts[0][0]; res.end = pts[pts.length - 1][0]; }
      if (live && live.time && res.start && live.time >= res.start && live.time <= res.end + 300e3 && (!pts.length || live.time > pts[pts.length - 1][0])) pts.push([Math.min(live.time, res.end), live.price]);
      res.ref = bars && bars.prevClose;
    }
    res.refLabel = '昨收';
  } else {
    if (live && live.time && pts.length) {
      var lp = pts[pts.length - 1];
      var daily = CHART_RANGES[rk].interval === '1d' || CHART_RANGES[rk].interval === '1wk';
      var sameDay = h.market === 'TW' ? tpeParts_(lp[0]).iso === tpeParts_(live.time).iso : nyParts_(lp[0]).iso === nyParts_(live.time).iso;
      if (daily && (sameDay || CHART_RANGES[rk].interval === '1wk' && live.time - lp[0] < 7 * 864e5)) lp[1] = live.price;
      else if (live.time > lp[0] + 60e3) pts.push([live.time, live.price]);
    }
    res.ref = (bars && bars.chartPrevClose) || (pts.length ? pts[0][1] : null);
    res.refLabel = '區間起點';
  }
  res.points = downsample_(pts, 600);
  return res;
}

function holdingFor_(raw) {
  var nc = normalizeCode_(raw);
  if (!nc) throw userError_('代號格式不正確');
  var h = readHoldings_().filter(function (x) { return x.code === nc.code; })[0];
  return h || { code: nc.code, market: nc.market, name: '', shares: 0, cost: null, keyword: '' };
}

function chart_(raw, rk) {
  if (!CHART_RANGES[rk]) throw userError_('不支援的區間：' + rk);
  var h = holdingFor_(raw);
  var q = getQuotes_([h])[h.code];
  var sym = yahooSymFor_(h, q);
  var got = yahooBarsMany_([{ sym: sym, rk: rk, market: h.market }]);
  var bars = got[sym + '|' + rk];
  if (bars === null && h.market === 'TW') {   // 上市／上櫃判斷錯：換另一個後綴
    var alt = h.code + (sym.slice(-4) === '.TWO' ? '.TW' : '.TWO');
    bars = yahooBarsMany_([{ sym: alt, rk: rk, market: h.market }])[alt + '|' + rk];
  }
  var res = buildChart_(h, rk, bars, q);
  if (!res.points.length && (!q || q.error)) throw userError_('查不到 ' + h.code + ' 的走勢資料', 'not_found');
  return res;
}

/** 明細頁每 5 秒呼叫：只抓這一檔、最多 4 秒的快取 */
function live_(raw) {
  var h = holdingFor_(raw);
  var q = getQuotes_([h], 4)[h.code];
  var lv = budgetLevel_();
  return { quote: q, open: marketOpen_(h.market), next: lv === 2 ? 60000 : lv === 1 ? 15000 : 5000, usage: usageInfo_(), notice: QUOTA_NOTICE };
}

/** 持股列的迷你走勢：所有持股的當日走勢，每檔最多 60 點 */
function spark_() {
  var holdings = readHoldings_();
  var key = 'spark:' + holdings.map(function (h) { return h.code; }).sort().join(',');
  var cached = cacheGet_(key);
  if (cached) return cached;
  if (budgetLevel_() === 2) throw userError_('省額度模式：迷你走勢暫停更新', 'budget');
  var quotes = getQuotes_(holdings);
  var items = holdings.map(function (h) { return { sym: yahooSymFor_(h, quotes[h.code]), rk: '1d', market: h.market }; });
  var bars = yahooBarsMany_(items);
  var out = {};
  holdings.forEach(function (h, i) {
    var c = buildChart_(h, '1d', bars[items[i].sym + '|1d'], quotes[h.code]);
    out[h.code] = { points: downsample_(c.points, 60), ref: c.ref, start: c.start, end: c.end, gap: c.gap };
  });
  var res = { spark: out };
  var anyOpen = marketOpen_('TW') || marketOpen_('US');
  cachePut_(key, res, anyOpen ? 240 : 1800);   // 盤中 4 分鐘、收盤後 30 分鐘，所有裝置共用
  return res;
}

function recorderStatus_() {
  var exists = false;
  try { exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'recordTick'; }); }
  catch (e) { return { name: '盤中紀錄排程', ok: false, detail: '無法讀取排程：請在 Apps Script 重新執行 setup 並授權', ms: 0 }; }
  if (!exists) return { name: '盤中紀錄排程', ok: false, detail: '尚未建立：請在 Apps Script 執行 setup', ms: 0 };
  var last = cacheGet_('rec:last');
  return { name: '盤中紀錄排程', ok: true, detail: '每分鐘' + (last ? '，最近一次 ' + new Date(Number(last) + 8 * 3600e3).toISOString().slice(5, 16).replace('T', ' ') : '（台股盤中才會執行）'), ms: 0 };
}

/* ===================== 每日市值紀錄 ===================== */

var SHEET_DAILY = '每日市值';
var SHEET_DAILY_DET = '市值明細';
var DAILY_HEADERS = ['日期', '紀錄時間', '總市值', '台股市值', '美股市值(台幣)', '美股市值(美元)', '美元匯率', '總成本', '未實現損益', '報酬率', '市值變化', '市值變化%', '損益變化', '持股檔數', '備註'];
var DET_HEADERS = ['日期', '代號', '名稱', '市場', '股數', '價格', '幣別', '市值(原幣)', '市值(台幣)', '成本(台幣)', '未實現損益(台幣)', '報價時間', '備註'];
var SNAP_MIN = 13 * 60 + 31;     // 13:31 起記錄（13:30 收盤撮合結果公布後）
var SNAP_WAIT_UNTIL = 13 * 60 + 45;   // 收盤價最晚等到 13:45，之後就用拿得到的價格

function ensureDailySheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var d = ss.getSheetByName(SHEET_DAILY);
  if (!d) {
    d = ss.insertSheet(SHEET_DAILY);
    ['A:A', 'B:B'].forEach(function (c) { d.getRange(c).setNumberFormat('@'); });   // 日期、時間存文字，避免時區換算
    d.getRange(1, 1, 1, DAILY_HEADERS.length).setValues([DAILY_HEADERS]).setFontWeight('bold');
    d.setFrozenRows(1);
    [['C:F', '#,##0'], ['H:I', '#,##0']].forEach(function (x) { rangeCols_(d, x[0]).forEach(function (c) { d.getRange(c).setNumberFormat(x[1]); }); });
    d.getRange('F:F').setNumberFormat('#,##0.00');
    d.getRange('G:G').setNumberFormat('0.000');
    d.getRange('J:J').setNumberFormat('0.00%');
    // 與前一日的變化：增加紅色 ▲、減少綠色 ▼，顯示確切金額
    d.getRange('K:K').setNumberFormat('[Red]"▲"#,##0;[Green]"▼"#,##0;0');
    d.getRange('M:M').setNumberFormat('[Red]"▲"#,##0;[Green]"▼"#,##0;0');
    d.getRange('L:L').setNumberFormat('[Red]"▲"0.00%;[Green]"▼"0.00%;0.00%');
  }
  var t = ss.getSheetByName(SHEET_DAILY_DET);
  if (!t) {
    t = ss.insertSheet(SHEET_DAILY_DET);
    ['A:A', 'B:B', 'L:L'].forEach(function (c) { t.getRange(c).setNumberFormat('@'); });   // 代號要文字，0050 才不會掉 0
    t.getRange(1, 1, 1, DET_HEADERS.length).setValues([DET_HEADERS]).setFontWeight('bold');
    t.setFrozenRows(1);
  }
  return { daily: d, det: t };
}
function rangeCols_(sh, spec) {   // 'C:F' → ['C:C','D:D','E:E','F:F']
  var a = spec.charCodeAt(0), b = spec.charCodeAt(2), out = [];
  for (var c = a; c <= b; c++) out.push(String.fromCharCode(c) + ':' + String.fromCharCode(c));
  return out;
}

/** 損益計算設定（App 的設定會同步過來，讓紀錄的損益和畫面上一致） */
function pnlSettings_() {
  var p = PropertiesService.getScriptProperties();
  var fees = p.getProperty('PNL_FEES');
  var disc = Number(p.getProperty('PNL_DISCOUNT'));
  return { fees: fees == null ? true : fees === '1', discount: disc > 0 && disc <= 10 ? disc : 10 };
}
function saveSettings_(st) {
  var p = PropertiesService.getScriptProperties();
  var disc = Number(st.discount);
  p.setProperty('PNL_FEES', st.fees === false ? '0' : '1');
  p.setProperty('PNL_DISCOUNT', String(disc > 0 && disc <= 10 ? disc : 10));
  return pnlSettings_();
}
/** 與 App 相同：台股預估賣出手續費＋證交稅 */
function sellCost_(code, shares, mv, st) {
  if (!st.fees || !(mv > 0)) return 0;
  var disc = Math.min(1, Math.max(0.01, st.discount / 10));
  var minFee = Math.floor(shares) === shares && shares % 1000 === 0 ? 20 : 1;
  var fee = Math.max(Math.floor(mv * 0.001425 * disc), minFee);
  var rate = /^00\d+B$/.test(code) ? 0 : /^00/.test(code) ? 0.001 : 0.003;
  return fee + Math.floor(mv * rate);
}

function hm_(ms) { var d = new Date(ms + 8 * 3600e3); return ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2); }
function lastDaily_(sh) {
  var last = sh.getLastRow();
  if (last < 2) return null;
  var r = sh.getRange(last, 1, 1, DAILY_HEADERS.length).getValues()[0];
  return { date: String(r[0]), total: Number(r[2]) || 0, pnl: Number(r[8]) || 0, fx: Number(r[6]) || null };
}
function detailsOf_(sh, date, maxRows) {
  var last = sh.getLastRow();
  if (last < 2 || !date) return {};
  var n = Math.min(last - 1, maxRows);
  var rows = sh.getRange(last - n + 1, 1, n, DET_HEADERS.length).getValues();
  var out = {};
  rows.forEach(function (r) {
    if (String(r[0]) !== date) return;
    var code = typeof r[1] === 'number' ? String(r[1]).padStart(4, '0') : String(r[1]);
    out[code] = { shares: Number(r[4]), price: Number(r[5]) };
  });
  return out;
}

/**
 * 記錄今天 13:30 的持倉市值。每分鐘排程呼叫；一天只記一次（已記過立刻結束）。
 * 13:31 起：台股今天有交易時，等到拿到 13:30 收盤價（最晚 13:45）；台股休市日直接用最後收盤價。
 * 美股用前一晚收盤價（台北 13:30 美股已收盤），匯率用記錄當下的美元匯率。
 */
function snapshotDaily_() {
  var now = Date.now(), tp = tpeParts_(now), day = tp.iso;
  if (tp.mins < SNAP_MIN) return { skipped: 'before' };
  if (cacheGet_('snap:' + day)) return { skipped: 'done' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { skipped: 'busy' };
  try {
    var sh = ensureDailySheets_();
    var prev = lastDaily_(sh.daily);
    if (prev && prev.date === day) { cachePut_('snap:' + day, 1, 21600); return { skipped: 'done' }; }
    var holdings = readHoldings_();
    if (!holdings.length) return { skipped: 'empty' };
    var quotes = getQuotes_(holdings, 60);
    var notes = [];
    var tw = holdings.filter(function (h) { return h.market === 'TW'; });
    var twToday = tw.some(function (h) { var q = quotes[h.code]; return q && !q.error && q.time && tpeParts_(q.time).iso === day; });
    if (twToday && tp.mins < SNAP_WAIT_UNTIL) {
      // 證交所整批報價的時間到了 13:30 才代表收盤價已公布（冷門股最後成交可能更早，所以看整批最新的時間）
      var close = twSession_(day).end;
      var latest = Math.max.apply(null, tw.map(function (h) { var q = quotes[h.code]; return q && !q.error && q.source === 'TWSE' && q.time ? q.time : 0; }));
      var anyTwse = latest > 0;
      if (anyTwse && latest < close) return { skipped: 'waiting' };   // 收盤價還沒出來，下一分鐘再試
    }
    if (tw.length && !twToday) notes.push('台股休市');
    if (prev && prev.date !== ymd_(addDays_(new Date(Date.parse(day + 'T00:00:00Z')), -1))) notes.push('與 ' + prev.date + ' 比較');
    var hasUS = holdings.some(function (h) { return h.market === 'US'; });
    var fx = null;
    if (hasUS) {
      var f = getFx_();
      fx = f && f.rate ? f.rate : (prev && prev.fx);
      if (!(f && f.rate)) notes.push(fx ? '匯率取不到，沿用前一日' : '匯率取不到，美股未計入');
    }
    var st = pnlSettings_();
    var prevDet = prev ? detailsOf_(sh.det, prev.date, holdings.length + 200) : {};
    var tot = { mv: 0, tw: 0, usT: 0, usUsd: 0, cost: 0, pnl: 0, n: 0 }, det = [], carried = [], missing = [];
    holdings.forEach(function (h) {
      var q = quotes[h.code], price = null, qtime = '', dnote = '';
      if (q && !q.error && q.price) { price = q.price; qtime = q.time ? (tpeParts_(q.time).iso + ' ' + hm_(q.time)) : ''; if (q.delayed) dnote = 'Yahoo 延遲報價'; }
      else if (prevDet[h.code] && prevDet[h.code].price) { price = prevDet[h.code].price; dnote = '缺報價，沿用前一日價格'; carried.push(h.code); }
      if (price == null) { missing.push(h.code); return; }
      var rate = h.market === 'US' ? fx : 1;
      if (!rate) { missing.push(h.code); return; }
      var mvL = price * h.shares, mvT = mvL * rate;
      var costL = h.cost != null ? h.cost * h.shares : null;
      var fee = h.market === 'TW' ? sellCost_(h.code, h.shares, mvL, st) : 0;
      var pnlT = costL != null ? (mvL - fee - costL) * rate : null;
      tot.mv += mvT; tot.n++;
      if (h.market === 'TW') tot.tw += mvT; else { tot.usT += mvT; tot.usUsd += mvL; }
      if (costL != null) { tot.cost += costL * rate; tot.pnl += pnlT; }
      det.push([day, h.code, h.name || (q && q.name ? (h.market === 'US' ? enCore_(q.name) : q.name) : ''), h.market === 'TW' ? '台股' : '美股', h.shares, price, h.market === 'TW' ? 'TWD' : 'USD',
        Math.round(mvL * 100) / 100, Math.round(mvT), costL != null ? Math.round(costL * rate) : '', pnlT != null ? Math.round(pnlT) : '', qtime, dnote]);
    });
    if (!det.length) return { skipped: 'noquotes' };
    if (carried.length) notes.push(carried.length + ' 檔缺報價，沿用前一日價格');
    if (missing.length) notes.push(missing.length + ' 檔沒有報價，未計入');
    // 持股變動（新增、刪除、股數改變）：市值變化會包含買賣，看「損益變化」才是漲跌
    if (prev && Object.keys(prevDet).length) {
      var nowSet = {}; holdings.forEach(function (h) { nowSet[h.code] = h.shares; });
      var changed = Object.keys(prevDet).some(function (c) { return nowSet[c] !== prevDet[c].shares; }) || Object.keys(nowSet).some(function (c) { return !prevDet[c]; });
      if (changed) notes.push('持股有變動');
    }
    var total = Math.round(tot.mv), pnl = Math.round(tot.pnl), cost = Math.round(tot.cost);
    var row = [day, hm_(now), total, Math.round(tot.tw), Math.round(tot.usT), Math.round(tot.usUsd * 100) / 100, fx ? Math.round(fx * 1000) / 1000 : '',
      cost, pnl, cost ? Math.round(pnl / cost * 1e6) / 1e6 : '',
      prev ? total - prev.total : '', prev && prev.total ? Math.round((total - prev.total) / prev.total * 1e6) / 1e6 : '', prev ? pnl - prev.pnl : '',
      tot.n, notes.join('；')];
    sh.daily.getRange(sh.daily.getLastRow() + 1, 1, 1, row.length).setValues([row]);
    sh.det.getRange(sh.det.getLastRow() + 1, 1, det.length, DET_HEADERS.length).setValues(det);
    cachePut_('snap:' + day, 1, 21600);
    return { recorded: true, row: row };
  } finally { lock.releaseLock(); }
}

function history_(withDetail) {
  var sh = ensureDailySheets_();
  var last = sh.daily.getLastRow();
  var rows = last < 2 ? [] : sh.daily.getRange(2, 1, last - 1, DAILY_HEADERS.length).getValues().map(function (r) {
    var num = function (v) { return v === '' || v == null ? null : Number(v); };
    return { date: String(r[0]), time: String(r[1]), total: num(r[2]), tw: num(r[3]), usT: num(r[4]), usUsd: num(r[5]), fx: num(r[6]),
      cost: num(r[7]), pnl: num(r[8]), ret: num(r[9]), dMv: num(r[10]), dPct: num(r[11]), dPnl: num(r[12]), count: num(r[13]), note: String(r[14] || '') };
  }).filter(function (r) { return /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.total != null; });
  var out = { rows: rows, settings: pnlSettings_(), snapTime: '13:30' };
  if (withDetail) {
    var dl = sh.det.getLastRow();
    out.details = dl < 2 ? [] : sh.det.getRange(2, 1, dl - 1, DET_HEADERS.length).getValues().map(function (r) {
      return [String(r[0]), typeof r[1] === 'number' ? String(r[1]).padStart(4, '0') : String(r[1])].concat(r.slice(2));
    });
  }
  return out;
}
