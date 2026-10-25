// 新聞精準度測試：查詢字串、標題比對、排除關鍵字、嚴格模式開關
const assert = require('assert');
const { makeEnv } = require('./gas-mock');
const { makeHandler } = require('./fixtures');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('✓', name); }
  catch (e) { console.log('✗', name); console.log(e); process.exitCode = 1; }
}

const env = makeEnv(makeHandler({}));
const token = env.ctx.setup();
const add = (code, extra) => assert.ok(env.post({ action: 'upsert', token, holding: Object.assign({ code, shares: 10, cost: 100 }, extra || {}) }).ok);
add('MU'); add('SNDK'); add('2330', { name: '台積電' });
const titles = (r, code) => r.data.news[code].items.map(i => i.title);
const T = env.ctx.titleMatches_;
const plain = (x) => JSON.parse(JSON.stringify(x));
const NT = (...a) => plain(env.ctx.newsTerms_(...a));
const NQ = (...a) => plain(env.ctx.newsQueries_(...a));

t('查詢字串：美股用中英文公司名稱，不再用代號', () => {
  const q = NQ(NT({ code: 'MU', market: 'US', name: '', keyword: '' }, ''), true);
  assert.deepStrictEqual(q.map(x => x.q), ['"美光" OR "Micron"', '("Micron") stock']);
  const q2 = NQ(NT({ code: 'SNDK', market: 'US', name: '', keyword: '' }, ''), false);
  assert.deepStrictEqual(q2.map(x => x.q), ['"閃迪" OR "SanDisk"']);
});

t('美光：留下標題有提到的；曼聯 (MU)、MU 5G 手機、泛記憶體、盤前要聞都略過', () => {
  const r = env.get({ action: 'news', token, codes: 'MU' });
  const got = titles(r, 'MU');
  assert.deepStrictEqual(got.sort(), [
    'Memory chip stocks rally; $MU leads gains', 'Micron shares jump as AI memory demand surges',
    'Micron 擴大台中投資', '美光財報優於預期 盤後大漲'].sort());
  assert.strictEqual(r.data.news.MU.filtered, 5);
});

t('閃迪：大小寫不同的 Sandisk 也算；迪士尼、只寫族群的不算', () => {
  const got = titles(env.get({ action: 'news', token, codes: 'SNDK' }), 'SNDK');
  assert.ok(got.includes('SanDisk stock soars on NAND price hikes'));
  assert.ok(got.includes('Western Digital and Sandisk split one year later'));
  assert.ok(got.includes('閃迪 NAND 合約價再漲 群聯受惠') && got.includes('旺宏法說：與閃迪合作延續'));
  assert.ok(!got.some(x => /迪士尼|族群走強|storage names/.test(x)));
});

t('關閉嚴格篩選（strict=0）→ 全部顯示', () => {
  env.clearCache();
  const r = env.get({ action: 'news', token, codes: 'MU', strict: '0' });
  assert.strictEqual(r.data.news.MU.items.length, 9);
  assert.strictEqual(r.data.news.MU.filtered, 0);
});

t('新聞關鍵字：多個關鍵字、用 - 排除（查詢與篩選都生效）', () => {
  env.clearCache();
  add('MU', { keyword: '美光科技, -擴大' });
  const terms = NT({ code: 'MU', market: 'US', name: '', keyword: '美光科技, -擴大' }, '');
  assert.deepStrictEqual(terms.excl, ['擴大']);
  assert.ok(terms.zh.includes('美光科技') && terms.zh.includes('美光'));
  assert.match(NQ(terms, true)[0].q, / -"擴大"$/);
  const got = titles(env.get({ action: 'news', token, codes: 'MU' }), 'MU');
  assert.ok(!got.some(x => x.includes('擴大')));
  assert.ok(got.includes('美光財報優於預期 盤後大漲'));
  add('MU', { keyword: '' });
});

const mu = NT({ code: 'MU', market: 'US', name: '', keyword: '' }, '');
const tsla = NT({ code: 'TSLA', market: 'US', name: '', keyword: '' }, '');
const arm = NT({ code: 'ARM', market: 'US', name: '', keyword: '' }, '');
const brk = NT({ code: 'BRK.B', market: 'US', name: '', keyword: '' }, '');
const rklb = NT({ code: 'RKLB', market: 'US', name: '', keyword: '' }, 'Rocket Lab USA, Inc.');
const tw = NT({ code: '2330', market: 'TW', name: '台積電', keyword: '' }, '');
const ky = NT({ code: '4966', market: 'TW', name: '譜瑞-KY', keyword: '' }, '');
const etf = NT({ code: '0050', market: 'TW', name: '元大台灣50', keyword: '' }, '');

t('代號比對：$MU、NASDAQ:MU 算；(MU)、裸寫 MU、muscle 不算', () => {
  assert.ok(T('Chip stocks: $MU up 5%', mu));
  assert.ok(T('NASDAQ: MU hits record', mu));
  assert.ok(!T('Manchester United (MU) falls', mu));
  assert.ok(!T('MU 5G phone review', mu));
  assert.ok(!T('Build muscle fast', mu));
});

t('代號比對：長代號裸寫 TSLA 算；常見字 ARM 不算但 Arm Holdings 算；BRK.B／BRK-B', () => {
  assert.ok(T('TSLA rallies after deliveries', tsla));
  assert.ok(T('特斯拉交車數創高', tsla));
  assert.ok(!T('Arm wrestling championship', arm));
  assert.ok(!T('ARM yourself with these tips', arm));
  assert.ok(T('Arm Holdings beats estimates', arm));
  assert.ok(T('$BRK.B and $BRK-B explained', brk));
  assert.ok(T('BRK-B hits all-time high', brk));
  assert.ok(T('波克夏股東會重點', brk));
});

t('字典沒有的美股：用 Yahoo 英文名稱去掉字尾（Rocket Lab USA, Inc. → Rocket Lab）', () => {
  assert.deepStrictEqual(rklb.en, ['Rocket Lab']);
  assert.ok(T('Rocket Lab launches Neutron', rklb));
  assert.ok(T('RKLB jumps 10%', rklb));
});

t('台股：公司名或完整代號；23301 不算 2330；-KY 公司用簡稱也算；ETF 用代號', () => {
  assert.ok(T('台積電法說會', tw));
  assert.ok(T('2330 外資買超', tw));
  assert.ok(!T('23301 是什麼', tw));
  assert.ok(T('譜瑞營收創新高', ky));
  assert.ok(T('0050 除息', etf));
  assert.ok(!T('台股 ETF 資金動向', etf));
});

t('篩選後太少 → 放寬到 7 天的判斷用「篩選後」的數量', () => {
  env.clearCache();
  add('6488', { name: '環球晶' });
  const n = env.get({ action: 'news', token, codes: '6488' }).data.news['6488'];
  assert.strictEqual(n.widened, true);
});

console.log(`\n${passed} passed`);
