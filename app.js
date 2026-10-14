
const $ = id => document.getElementById(id);

const fmt = n =>
  Number.isFinite(n)
    ? n.toLocaleString('en-US', { maximumFractionDigits: 6 })
    : '—';

let deferredInstall = null;

// نصب برنامه
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstall = e;

  if ($('install')) $('install').hidden = false;
});

if ($('install')) {
  $('install').addEventListener('click', async () => {
    if (!deferredInstall) return;

    deferredInstall.prompt();
    await deferredInstall.userChoice;

    deferredInstall = null;
    $('install').hidden = true;
  });
}

// میانه بیشترین و کمترین قیمت در یک بازه
function mid(c, end, period) {
  if (
    !Number.isInteger(end) ||
    !Number.isInteger(period) ||
    period < 1 ||
    end < period - 1 ||
    end >= c.length
  ) {
    return NaN;
  }

  const w = c.slice(end - period + 1, end + 1);

  return (
    Math.max(...w.map(x => x.h)) +
    Math.min(...w.map(x => x.l))
  ) / 2;
}

// RSI استاندارد با هموارسازی وایلدر
function rsi(c, p = 14) {
  if (c.length <= p) return NaN;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= p; i++) {
    const d = c[i].c - c[i - 1].c;

    gain += Math.max(d, 0);
    loss += Math.max(-d, 0);
  }

  let avgGain = gain / p;
  let avgLoss = loss / p;

  for (let i = p + 1; i < c.length; i++) {
    const d = c[i].c - c[i - 1].c;

    avgGain =
      (avgGain * (p - 1) + Math.max(d, 0)) / p;

    avgLoss =
      (avgLoss * (p - 1) + Math.max(-d, 0)) / p;
  }

  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;

  return 100 - 100 / (1 + avgGain / avgLoss);
}

// میانگین دامنه واقعی ATR
function atr(c, p = 14) {
  if (c.length < p + 1) return NaN;

  const values = [];

  for (let i = c.length - p; i < c.length; i++) {
    const tr = Math.max(
      c[i].h - c[i].l,
      Math.abs(c[i].h - c[i - 1].c),
      Math.abs(c[i].l - c[i - 1].c)
    );

    values.push(tr);
  }

  return values.reduce((a, b) => a + b, 0) / values.length;
}

// تبدیل تایم‌فریم به ثانیه
function timeframeSeconds(res) {
  const value = String(res).trim();

  const known = {
    '1m': 60,
    '3m': 180,
    '5m': 300,
    '15m': 900,
    '30m': 1800,
    '45m': 2700,
    '1h': 3600,
    '2h': 7200,
    '3h': 10800,
    '4h': 14400,
    '6h': 21600,
    '8h': 28800,
    '12h': 43200,
    '1d': 86400,
    '1w': 604800
  };

  if (known[value.toLowerCase()]) {
    return known[value.toLowerCase()];
  }

  if (/^\d+$/.test(value)) {
    const minutes = Number(value);

    if (minutes > 0) return minutes * 60;
  }

  if (/^\d+D$/i.test(value)) {
    return Number(value.slice(0, -1)) * 86400;
  }

  if (/^\d+W$/i.test(value)) {
    return Number(value.slice(0, -1)) * 604800;
  }

  return 0;
}

// دریافت کندل از API نمودار نوبیتکس
async function loadCandles(symbol, res) {
  const to = Math.floor(Date.now() / 1000);

  const url =
    'https://apiv2.nobitex.ir/market/udf/history' +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&resolution=${encodeURIComponent(res)}` +
    `&to=${to}&countback=250`;

  const response = await fetch(url, {
    cache: 'no-store'
  });

  if (!response.ok) {
    throw new Error(
      'خطای دریافت کندل: HTTP ' + response.status
    );
  }

  const j = await response.json();

  if (j.s !== 'ok' || !Array.isArray(j.t)) {
    throw new Error(
      j.errmsg || 'داده معتبر کندل دریافت نشد'
    );
  }

  const c = j.t.map((t, i) => ({
    t: Number(t),
    o: Number(j.o[i]),
    h: Number(j.h[i]),
    l: Number(j.l[i]),
    c: Number(j.c[i]),
    v: Number(j.v[i])
  })).filter(x =>
    Number.isFinite(x.t) &&
    Number.isFinite(x.o) &&
    Number.isFinite(x.h) &&
    Number.isFinite(x.l) &&
    Number.isFinite(x.c) &&
    Number.isFinite(x.v) &&
    x.t > 0 &&
    x.o > 0 &&
    x.h > 0 &&
    x.l > 0 &&
    x.c > 0 &&
    x.v >= 0 &&
    x.h >= x.l &&
    x.h >= Math.max(x.o, x.c) &&
    x.l <= Math.min(x.o, x.c)
  );

  // مرتب‌سازی زمانی و حذف کندل‌های تکراری
  const unique = [
    ...new Map(c.map(x => [x.t, x])).values()
  ].sort((a, b) => a.t - b.t);

  if (unique.length < 100) {
    throw new Error(
      'تعداد کندل‌های دریافتی برای تحلیل کافی نیست: ' +
      unique.length
    );
  }

  return unique;
}

// محاسبه ایچیموکو، RSI، حجم و مدیریت ریسک
function analyze(raw, capital, riskPct, res) {
  const step = timeframeSeconds(res);

  if (!step) {
    throw new Error(
      'تایم‌فریم ناشناخته است: ' + res
    );
  }

  const now = Math.floor(Date.now() / 1000);

  // فقط کندل‌هایی که زمان پایانشان گذشته است
  const c = raw.filter(x => x.t + step <= now);

  if (c.length < 100) {
    throw new Error(
      'تعداد کندل‌های بسته‌شده کافی نیست: ' + c.length
    );
  }

  const i = c.length - 1;

  // قیمت مرجع تحلیل = بسته‌شدن آخرین کندل کامل
  const price = c[i].c;

  // خطوط اصلی ایچیموکو
  const ten = mid(c, i, 9);
  const kij = mid(c, i, 26);

  // ابر قابل مشاهده در زمان کندل فعلی:
  // سنکوها ۲۶ کندل پیش محاسبه شده‌اند.
  const cloudIndex = i - 26;

  const spanA = (
    mid(c, cloudIndex, 9) +
    mid(c, cloudIndex, 26)
  ) / 2;

  const spanB = mid(c, cloudIndex, 52);

  const top = Math.max(spanA, spanB);
  const bottom = Math.min(spanA, spanB);

  const rv = rsi(c, 14);
  const a = atr(c, 14);

  // حجم کندل اخیر در برابر ۲۰ کندل قبل از آن
  const previousVolumes = c
    .slice(i - 20, i)
    .map(x => x.v);

  const volAvg = previousVolumes.reduce(
    (sum, value) => sum + value,
    0
  ) / previousVolumes.length;

  const volRatio = volAvg > 0
    ? c[i].v / volAvg
    : 0;

  if (
    !Number.isFinite(price) ||
    !Number.isFinite(ten) ||
    !Number.isFinite(kij) ||
    !Number.isFinite(spanA) ||
    !Number.isFinite(spanB) ||
    !Number.isFinite(rv) ||
    !Number.isFinite(a)
  ) {
    throw new Error(
      'محاسبه اندیکاتورها نامعتبر است'
    );
  }

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
    `قیمت بسته‌شدن کندل: ${fmt(price)}`,

    `وضعیت قیمت نسبت به ابر: ${
      price > top
        ? 'بالای ابر'
        : price < bottom
          ? 'زیر ابر'
          : 'داخل ابر'
    }`,

    `تنکان ${ten > kij
      ? 'بالاتر از'
      : ten < kij
        ? 'پایین‌تر از'
        : 'برابر با'} کیجون است`,

    `RSI(14) با روش وایلدر: ${rv.toFixed(2)}`,

    `حجم کندل بسته‌شده ${volRatio.toFixed(2)} برابر میانگین ۲۰ کندل قبلی است`
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

  // بدون سیگنال، قیمت ورود و حد ضرر ارائه نمی‌شود
  if (!buy && !sell) return out;

  const isLong = buy;
  const recent = c.slice(-12);

  const struct = isLong
    ? Math.min(...recent.map(x => x.l))
    : Math.max(...recent.map(x => x.h));

  const stop = isLong
    ? Math.min(struct, price - 1.5 * a)
    : Math.max(struct, price + 1.5 * a);

  const dist = Math.abs(price - stop);

  if (
    !Number.isFinite(dist) ||
    dist <= 0 ||
    a <= 0
  ) {
    return {
      ...out,
      signal: 'انتظار / حد ضرر نامعتبر'
    };
  }

  const riskFraction = dist / price;

  // ریسک مجاز بر مبنای سرمایه واردشده
  const safeCapital = Math.max(0, capital);

  const safeRisk = Math.max(
    0.1,
    Math.min(2, riskPct)
  );

  const riskBudget = safeCapital * safeRisk / 100;

  out.entry = price;
  out.stop = stop;

  out.t1 = price +
    (isLong ? 1 : -1) * 1.5 * dist;

  out.t2 = price +
    (isLong ? 1 : -1) * 2 * dist;

  // ارزش اسمی موقعیت با سقف اهرم ۲ برابر
  out.position = Math.min(
    safeCapital * 2,
    riskBudget / riskFraction
  );

  out.riskPct = riskFraction * 100;

  return out;
}

// اجرای تحلیل
$('analyze').addEventListener('click', async () => {
  $('analyze').disabled = true;
  $('status').className = 'status';
  $('status').textContent =
    'در حال دریافت داده‌های بازار…';

  $('err').textContent = '';

  try {
    const sym = $('symbol').value;
    const res = $('tf').value;

    const capital = Math.max(
      0,
      Number($('capital').value) || 0
    );

    const risk = Math.max(
      0.1,
      Math.min(
        2,
        Number($('risk').value) || 1
      )
    );

    const raw = await loadCandles(sym, res);

    const p = analyze(raw, capital, risk, res);

    // نمایش قیمت مرجع سیگنال، نه قیمت لحظه‌ای
    $('price').textContent = fmt(p.price);

    $('rsi').textContent = p.rsi.toFixed(2);
    $('vol').textContent = p.volRatio.toFixed(2) + '×';

    $('time').textContent =
      new Date(p.time * 1000).toLocaleString('fa-IR');

    $('status').textContent = p.signal;

    $('status').className =
      'status ' +
      (
        p.signal.startsWith('خرید')
          ? 'buy'
          : p.signal.startsWith('فروش')
            ? 'sell'
            : ''
      );

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

    // نمایش دلایل تحلیل با جلوگیری از درج HTML ناخواسته
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
    $('status').textContent =
      'تحلیل ناموفق — بدون سیگنال';

    $('status').className = 'status';

    $('err').textContent =
      (e.message || 'خطای ناشناخته') +
      '؛ اتصال اینترنت، تایم‌فریم و دسترسی API را بررسی کن.';

    for (const id of [
      'price',
      'rsi',
      'vol',
      'time',
      'entry',
      'stop',
      't1',
      't2'
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

// ثبت Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .catch(() => {});
  });
}
