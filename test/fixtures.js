// 模擬外部資料來源的回應（格式依證交所 MIS、Yahoo chart v8、Google 新聞 RSS、open.er-api）
// 數值是測試用，不是真實行情。
const now = Date.now();

const MIS = {
  '2330': { ex: 'tse', n: '台積電', z: '1085.0000', y: '1070.0000', o: '1075.0000', h: '1090.0000', l: '1072.0000', b: '1080.0000_1075.0000_', a: '1090.0000_1095.0000_' },
  '0050': { ex: 'tse', n: '元大台灣50', z: '-', y: '195.2000', o: '196.0000', h: '197.0000', l: '195.0000', b: '196.4000_196.3000_', a: '196.5500_196.6000_' },
  '00878': { ex: 'tse', n: '國泰永續高股息', z: '22.0500', y: '22.1000', o: '22.1000', h: '22.1500', l: '22.0000', b: '22.0500_', a: '22.0600_' },
  '6488': { ex: 'otc', n: '環球晶', z: '420.5000', y: '415.0000', o: '416.0000', h: '421.0000', l: '414.0000', b: '420.0000_', a: '420.5000_' },
  '2412': { ex: 'tse', n: '中華電', z: '-', y: '128.5000', o: '-', h: '-', l: '-', b: '-', a: '-' },
};

const YAHOO = {
  'AAPL': { regularMarketPrice: 268.81, previousClose: 262.24, currency: 'USD', shortName: 'Apple Inc.', exchangeName: 'NMS' },
  'NVDA': { regularMarketPrice: 186.26, chartPreviousClose: 180.28, currency: 'USD', longName: 'NVIDIA Corporation', exchangeName: 'NMS' },
  'BRK-B': { regularMarketPrice: 489.1, previousClose: 491.0, currency: 'USD', shortName: 'Berkshire Hathaway Inc. New', exchangeName: 'NYQ' },
  'TWD=X': { regularMarketPrice: 30.62, previousClose: 30.55, currency: 'TWD', shortName: 'USD/TWD' },
  '2330.TW': { regularMarketPrice: 1084, previousClose: 1070, currency: 'TWD', longName: 'Taiwan Semiconductor Manufacturing Company Limited' },
  '6488.TWO': { regularMarketPrice: 420, previousClose: 415, currency: 'TWD', longName: 'GlobalWafers Co., Ltd.' },
};

function rss(items) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><rss xmlns:media="http://search.yahoo.com/mrss/" version="2.0"><channel><title>"q" - Google 新聞</title>` +
    items.map(i => `<item><title>${i.title}</title><link>${i.link}</link><guid isPermaLink="false">x</guid><pubDate>${new Date(i.time).toUTCString()}</pubDate><description>&lt;a href="x"&gt;x&lt;/a&gt;</description><source url="https://example.com">${i.source}</source></item>`).join('') +
    `</channel></rss>`;
}

function newsFor(q, lang, days) {
  const h = 3600e3;
  if (q.includes('台積電')) return [
    { title: '台積電法說會釋利多 外資連三買 - 經濟日報', source: '經濟日報', link: 'https://news.google.com/rss/articles/AAA1', time: now - 2 * h },
    { title: '台積電 2 奈米量產進度超前 &amp; 美國廠擴產 - 工商時報', source: '工商時報', link: 'https://news.google.com/rss/articles/AAA2', time: now - 5 * h },
    { title: '台積電法說會釋利多，外資連三買 - Yahoo奇摩股市', source: 'Yahoo奇摩股市', link: 'https://news.google.com/rss/articles/AAA3', time: now - 6 * h },
    { title: '<b>半導體</b>族群走強 台積電領軍 - 鉅亨網', source: '鉅亨網', link: 'https://news.google.com/rss/articles/AAA4', time: now - 30 * h },
  ];
  if (q.includes('環球晶')) return days >= 7 ? [
    { title: '環球晶美國新廠啟用 - 中央社', source: '中央社', link: 'https://news.google.com/rss/articles/BBB1', time: now - 80 * h },
    { title: '環球晶第三季營收年增 - 經濟日報', source: '經濟日報', link: 'https://news.google.com/rss/articles/BBB2', time: now - 100 * h },
  ] : [{ title: '環球晶法人說明會 - MoneyDJ', source: 'MoneyDJ', link: 'https://news.google.com/rss/articles/BBB0', time: now - 10 * h }];
  if (q.includes('元大台灣50')) return [
    { title: '0050 除息在即 存股族關注 - 經濟日報', source: '經濟日報', link: 'https://news.google.com/rss/articles/CCC1', time: now - 3 * h },
    { title: '0050 規模創新高 - 鉅亨網', source: '鉅亨網', link: 'https://news.google.com/rss/articles/CCC2', time: now - 4 * h },
    { title: '台股 ETF 資金動向 - 工商時報', source: '工商時報', link: 'https://news.google.com/rss/articles/CCC3', time: now - 9 * h },
  ];
  if (q.includes('AAPL') && lang === 'en') return [
    { title: 'Apple stock hits record high ahead of earnings - Reuters', source: 'Reuters', link: 'https://news.google.com/rss/articles/DDD1', time: now - 1 * h },
    { title: 'What to expect from Apple&#39;s quarter - CNBC', source: 'CNBC', link: 'https://news.google.com/rss/articles/DDD2', time: now - 7 * h },
  ];
  if (q.includes('AAPL')) return [
    { title: '蘋果財報前夕 AAPL 股價創高 - 鉅亨網', source: '鉅亨網', link: 'https://news.google.com/rss/articles/DDD3', time: now - 2 * h },
    { title: 'iPhone 18 拉貨動能 - 經濟日報', source: '經濟日報', link: 'https://news.google.com/rss/articles/DDD4', time: now - 12 * h },
    { title: '美股科技股收紅 - 中央社', source: '中央社', link: 'https://news.google.com/rss/articles/DDD5', time: now - 20 * h },
  ];
  if (q.includes('輝達') || q.includes('NVDA')) return [
    { title: '輝達 GTC 大會亮點整理 - 數位時代', source: '數位時代', link: 'https://news.google.com/rss/articles/EEE1', time: now - 4 * h },
    { title: 'Nvidia shares rise on AI demand - Bloomberg', source: 'Bloomberg', link: 'https://news.google.com/rss/articles/EEE2', time: now - 8 * h },
    { title: '輝達供應鏈受惠 - 工商時報', source: '工商時報', link: 'https://news.google.com/rss/articles/EEE3', time: now - 15 * h },
  ];
  return [];
}

/** state: { misDown, yahooDown, yahoo429, newsDown, fxYahooDown, erDown } */
function makeHandler(state = {}) {
  return function (url) {
    const u = new URL(url);
    if (u.hostname === 'mis.twse.com.tw') {
      if (state.misDown) return { code: 503, body: '<html>busy</html>' };
      const ch = decodeURIComponent(u.searchParams.get('ex_ch') || '');
      const arr = [];
      ch.split('|').forEach(part => {
        const m = part.match(/^(tse|otc)_(.+)\.tw$/); if (!m) return;
        const f = MIS[m[2]]; if (!f || f.ex !== m[1]) return;
        arr.push(Object.assign({ c: m[2], ch: m[2] + '.tw', tlong: String(now - 60000), d: '20261023', t: '13:30:00' }, f));
      });
      return { code: 200, body: JSON.stringify({ msgArray: arr, rtcode: '0000', rtmessage: 'OK' }) };
    }
    if (u.hostname.endsWith('finance.yahoo.com')) {
      if (state.yahooDown) return { code: 500, body: 'err' };
      if (state.yahoo429 && u.hostname.startsWith('query1')) return { code: 429, body: 'Too Many Requests' };
      if (state.fxYahooDown && u.pathname.includes('TWD')) return { code: 500, body: 'err' };
      const sym = decodeURIComponent(u.pathname.split('/').pop());
      const f = YAHOO[sym];
      if (!f) return { code: 404, body: JSON.stringify({ chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } }) };
      return { code: 200, body: JSON.stringify({ chart: { result: [{ meta: Object.assign({ symbol: sym, regularMarketTime: Math.floor(now / 1000) - 120 }, f), timestamp: [], indicators: {} }], error: null } }) };
    }
    if (u.hostname === 'news.google.com') {
      if (state.newsDown) return { code: 503, body: 'Service Unavailable' };
      const q = u.searchParams.get('q');
      const lang = u.searchParams.get('hl') === 'en-US' ? 'en' : 'zh';
      const days = +(q.match(/when:(\d+)d/) || [0, 1])[1];
      return { code: 200, body: rss(newsFor(q, lang, days)) };
    }
    if (u.hostname === 'open.er-api.com') {
      if (state.erDown) return { code: 500, body: '' };
      return { code: 200, body: JSON.stringify({ result: 'success', time_last_update_unix: Math.floor(now / 1000) - 3600, rates: { USD: 1, TWD: 30.7 } }) };
    }
    return { code: 404, body: 'unknown host ' + u.hostname };
  };
}

module.exports = { makeHandler };
