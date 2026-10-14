
const $ = id => document.getElementById(id);

const fmt = n =>
  Number.isFinite(n)
    ? n.toLocaleString('en-US', { maximumFractionDigits: 6 })
    : '—';

let deferredInstall = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstall = e;
  $('install').hidden = false;
});

$('install').addEventListener('click', async () => {
  if (!deferredInstall) return;

  deferredInstall.prompt();
  await deferredInstall.userChoice;

  deferredInstall = null;
  $('install').hidden = true;
});

function mid(c, end, period) {
  const w = c.slice(end - period + 1, end + 1);
  return (Math.max(...w.map(x => x.h)) +
          Math.min(...w.map(x => x.l))) / 2;
}

function rsi(c, p = 14) {
  let g = 0, l = 0;

  for (let i = c.length - p; i < c.length; i++) {
    const d = c[i].c - c[i - 1].c;
    if (d >= 0) g += d;
    else l -= d;
  }

  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}

function atr(c, p = 14) {
  const a = [];

  for (let i = Math.max(1, c.length - p); i < c.length; i++) {
    a.push(Math.max(
      c[i].h - c[i].l,
      Math.abs(c[i].h - c[i - 1].c),
      Math.abs(c[i].l - c[i - 1].c)
    ));
  }

  return a.length
    ? a.reduce((x, y) => x + y, 0) / a.length
    : 0;
}

// دریافت کندل‌ها از API نمودار نوبیتکس
async function loadCandles(symbol, res) {
  const to = Math.floor(Date.now() / 1000);

  const url =
    `https://apiv2.nobitex.ir/market/udf/history` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&resolution=${encodeURIComponent(res)}` +
    `&to=${to}&countback=200`;

  const response = await fetch(url, { cache: 'no-store' });

  if (!response.ok) {
    throw new Error('خطای دریافت کندل: HTTP ' + response.status);
  }

  const j = await response.json();

  if (j.s !== 'ok') {
    throw new Error(j.errmsg || 'داده معتبر کندل دریافت نشد');
  }

  const c = j.t.map((t, i) => ({
    t: Number(t),
    o: Number(j.o[i]),
    h: Number(j.h[i]),
    l: Number(j.l[i]),
    c: Number(j.c[i]),
    v: Number(j.v[i])
  })).filter(x =>
    [x.t, x.o, x.h, x.l, x.c, x.v].every(Number.isFinite)
  );

  if (c.length < 60) {
    throw new Error('تعداد کندل‌های دریافتی کافی نیست: ' + c.length);
  }

  return c;
}

// قیمت آخرین معامله در بازار نقدی BTC/USDT نوبیتکس
async function getLiveBtcUsdt() {
  const url =
    'https://apiv2.nobitex.ir/market/stats' +
    '?srcCurrency=btc&dstCurrency=usdt';

  const response = await fetch(url, { cache: 'no-store' });

  if (!response.ok) {
    throw new Error('دریافت قیمت لحظه‌ای ناموفق بود');
  }

  const data = await response.json();
  const market = data.stats?.['btc-usdt'];
  const price = Number(market?.latest);

  if (
    data.status !== 'ok' ||
    !Number.isFinite(price) ||
    price <= 0
  ) {
    throw new Error('قیمت معتبر BTC/USDT دریافت نشد');
  }

  return price;
}

function analyze(c, capital, riskPct) {
  // استفاده از کندل‌های بسته‌شده برای تحلیل
  c = c.slice(0, -1);

  if (c.length < 60) {
    throw new Error('پس از کنار گذاشتن کندل جاری، داده کافی نیست');
  }

  const i = c.length - 1;
  const price = c[i].c;

  const ten = mid(c, i, 9);
  const kij = mid(c, i, 26);
  const spanA = (ten + kij) / 2;
  const spanB = mid(c, i, 52);

  const top = Math.max(spanA, spanB);
  const bottom = Math.min(spanA, spanB);

  const rv = rsi(c);
  const volAvg =
    c.slice(-21, -1).reduce((s, x) => s + x.v, 0) / 20;

  const volRatio = volAvg ? c[i].v / volAvg : 0;

  const buy =
    price > top &&
    ten > kij &&
    rv >= 52 &&
    rv <= 70 &&
    volRatio > 1.15;

  const sell =
    price < bottom &&
    ten < kij &&
    rv >= 30 &&
    rv <= 48 &&
    volRatio > 1.15;

  const reasons = [
    `قیمت کندل نسبت به ابر: ${
      price > top ? 'بالای ابر' :
      price < bottom ? 'زیر ابر' : 'داخل ابر'
    }`,
    `تنکان ${ten > kij ? 'بالاتر از' : 'پایین‌تر یا برابر با'} کیجون است`,
    `RSI(14): ${rv.toFixed(1)}`,
    `حجم کندل بسته‌شده ${volRatio.toFixed(2)} برابر میانگین ۲۰ کندل است`
  ];

  const out = {
    price,
    rsi: rv,
    volRatio,
    time: c[i].t,
    reasons,
    signal: buy
      ? 'خرید احتمالی — نیازمند تأیید'
      : sell
        ? 'فروش احتمالی — نیازمند تأیید'
        : 'انتظار / بدون سیگنال'
  };

  if (!buy && !sell) return out;

  const isLong = buy;
  const a = atr(c);
  const recent = c.slice(-12);

  const struct = isLong
    ? Math.min(...recent.map(x => x.l))
    : Math.max(...recent.map(x => x.h));

  const stop = isLong
    ? Math.min(struct, price - 1.5 * a)
    : Math.max(struct, price + 1.5 * a);

  const dist = Math.abs(price - stop);

  if (!Number.isFinite(dist) || dist <= 0) {
    return { ...out, signal: 'انتظار / حد ضرر نامعتبر' };
  }

  const riskFraction = dist / price;
  const riskBudget =
    capital * Math.max(0.1, Math.min(2, riskPct)) / 100;

  out.entry = price;
  out.stop = stop;
  out.t1 = price + (isLong ? 1 : -1) * 1.5 * dist;
  out.t2 = price + (isLong ? 1 : -1) * 2 * dist;

  out.position = Math.min(
    capital * 2,
    riskBudget / riskFraction
  );

  out.riskPct = riskFraction * 100;

  return out;
}

$('analyze').addEventListener('click', async () => {
  $('analyze').disabled = true;
  $('status').className = 'status';
  $('status').textContent = 'در حال دریافت داده‌های بازار…';
  $('err').textContent = '';

  try {
    const sym = $('symbol').value;
    const res = $('tf').value;

    const capital = Math.max(0, +$('capital').value || 0);
    const risk = Math.max(
      0.1,
      Math.min(2, +$('risk').value || 1)
    );

    const raw = await loadCandles(sym, res);
    const p = analyze(raw, capital, risk);

    // قیمت لحظه‌ای فقط برای جفت‌ارز BTC/USDT
    // سایر نمادها از قیمت کندل تحلیل استفاده می‌کنند.
    const isBtcUsdt =
      sym.toLowerCase().replace(/[-_/]/g, '') === 'btcusdt';

    const livePrice = isBtcUsdt
      ? await getLiveBtcUsdt()
      : p.price;

    $('price').textContent = fmt(livePrice);
    $('rsi').textContent = p.rsi.toFixed(1);
    $('vol').textContent = p.volRatio.toFixed(2) + '×';
    $('time').textContent =
      new Date(p.time * 1000).toLocaleString('fa-IR');

    $('status').textContent = p.signal;
    $('status').className =
      'status ' +
      (p.signal.startsWith('خرید')
        ? 'buy'
        : p.signal.startsWith('فروش')
          ? 'sell'
          : '');

    for (const [id, key] of [
      ['entry', 'entry'],
      ['stop', 'stop'],
      ['t1', 't1'],
      ['t2', 't2']
    ]) {
      $(id).textContent = fmt(p[key]);
    }

    $('position').textContent = p.position
      ? `ارزش اسمی تخمینی موقعیت با سقف ۲×: ${
          fmt(p.position)
        } واحد پول سرمایه واردشده. هزینه‌ها و تبدیل ارز لحاظ نشده است.`
      : 'اندازه موقعیت محاسبه نشد؛ ورود تأیید نشده است.';

    $('reasons').innerHTML = p.reasons.map(x =>
      '<li>' +
      x.replace(/[&<>"]/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;'
      }[ch])) +
      '</li>'
    ).join('');

  } catch (e) {
    $('status').textContent = 'تحلیل ناموفق — بدون سیگنال';
    $('err').textContent =
      (e.message || 'خطای ناشناخته') +
      '؛ اتصال اینترنت و دسترسی API را بررسی کن.';

    for (const id of [
      'price', 'rsi', 'vol', 'time',
      'entry', 'stop', 't1', 't2'
    ]) {
      $(id).textContent = '—';
    }

    $('position').textContent =
      'تا زمان دریافت داده معتبر، وارد معامله نشو.';

    $('reasons').innerHTML = '';
  } finally {
    $('analyze').disabled = false;
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .catch(() => {});
  });
}
