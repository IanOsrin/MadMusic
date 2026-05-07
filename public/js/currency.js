/**
 * MADMusic Currency Detection & Display
 *
 * On page load this module:
 *   1. Detects the visitor's country via IP geolocation (cached in sessionStorage)
 *   2. Maps country → currency code
 *   3. Fetches a live ZAR exchange rate (cached in sessionStorage for 6 hours)
 *   4. Exposes window.MADCurrency.updatePlanPrices() which injects a
 *      local-currency hint (e.g. "≈ €2.45") next to each ZAR price
 *
 * South African visitors see their prices unchanged (no hint added).
 * All network calls are fire-and-forget — if they fail the UI is unaffected.
 */

(function () {
  'use strict';

  // ── Country → Currency ────────────────────────────────────────────────────
  const COUNTRY_CURRENCY = {
    // Southern Africa
    ZA: 'ZAR', ZW: 'ZWL', ZM: 'ZMW', BW: 'BWP', NA: 'NAD', SZ: 'SZL', LS: 'LSL',
    // Rest of Africa
    NG: 'NGN', GH: 'GHS', KE: 'KES', EG: 'EGP', MA: 'MAD',
    TZ: 'TZS', UG: 'UGX', RW: 'RWF', ET: 'ETB', SN: 'XOF',
    // Americas
    US: 'USD', CA: 'CAD', MX: 'MXN', BR: 'BRL', AR: 'ARS',
    CL: 'CLP', CO: 'COP', PE: 'PEN', UY: 'UYU',
    // Europe — Eurozone
    DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR',
    BE: 'EUR', AT: 'EUR', PT: 'EUR', IE: 'EUR', FI: 'EUR',
    GR: 'EUR', SK: 'EUR', SI: 'EUR', EE: 'EUR', LV: 'EUR',
    LT: 'EUR', LU: 'EUR', MT: 'EUR', CY: 'EUR',
    // Europe — non-Eurozone
    GB: 'GBP', CH: 'CHF', NO: 'NOK', SE: 'SEK', DK: 'DKK',
    PL: 'PLN', CZ: 'CZK', HU: 'HUF', RO: 'RON', HR: 'EUR',
    // Asia-Pacific
    AU: 'AUD', NZ: 'NZD', JP: 'JPY', CN: 'CNY', IN: 'INR',
    SG: 'SGD', HK: 'HKD', KR: 'KRW', TH: 'THB', MY: 'MYR',
    ID: 'IDR', PH: 'PHP', TW: 'TWD', VN: 'VND', PK: 'PKR',
    // Middle East
    AE: 'AED', SA: 'SAR', IL: 'ILS', TR: 'TRY', QA: 'QAR', KW: 'KWD',
  };

  // ── Currency → symbol prefix ──────────────────────────────────────────────
  const CURRENCY_SYMBOLS = {
    ZAR: 'R',    USD: '$',    EUR: '€',    GBP: '£',    CNY: '¥',
    JPY: '¥',    AUD: 'A$',   CAD: 'C$',   CHF: 'CHF ', NOK: 'kr ',
    SEK: 'kr ',  DKK: 'kr ',  INR: '₹',    KRW: '₩',    SGD: 'S$',
    HKD: 'HK$',  NZD: 'NZ$',  BRL: 'R$',   MXN: '$',    ARS: '$',
    CLP: '$',    COP: '$',    PEN: 'S/',   NGN: '₦',    GHS: 'GH₵',
    KES: 'KSh ', EGP: 'E£',   MAD: 'MAD ', TZS: 'TSh ', UGX: 'USh ',
    ZMW: 'K',    BWP: 'P',    NAD: 'N$',   AED: 'AED ', SAR: 'SAR ',
    ILS: '₪',    TRY: '₺',    QAR: 'QR ',  KWD: 'KD ',  THB: '฿',
    MYR: 'RM',   IDR: 'Rp',   PHP: '₱',    TWD: 'NT$',  VND: '₫',
    PLN: 'zł',   CZK: 'Kč',   HUF: 'Ft',   RON: 'lei ',
  };

  // Currencies where we show 0 decimal places (large-denomination)
  const WHOLE_NUMBER_CURRENCIES = new Set([
    'JPY', 'KRW', 'IDR', 'VND', 'CLP', 'UGX', 'TZS', 'RWF', 'XOF',
  ]);

  // sessionStorage keys
  const CACHE_COUNTRY_KEY  = 'mad_geo_country';
  const CACHE_RATE_PREFIX  = 'mad_fx_';          // + currency code
  const CACHE_RATE_TTL_MS  = 6 * 60 * 60 * 1000; // 6 hours

  // ── Internal state ────────────────────────────────────────────────────────
  let _currency = null;
  let _rate     = null;
  let _symbol   = null;

  let _resolveReady;
  const ready = new Promise(res => { _resolveReady = res; });

  // ── Helpers ───────────────────────────────────────────────────────────────

  function _sessionGet(key) {
    try { return sessionStorage.getItem(key); } catch { return null; }
  }

  function _sessionSet(key, value) {
    try { sessionStorage.setItem(key, value); } catch { /* ignore */ }
  }

  async function _detectCountry() {
    // Dev override — append ?testCountry=US (or DE, GB, AU, etc.) to the URL
    const testParam = new URLSearchParams(window.location.search).get('testCountry');
    if (testParam) {
      console.log(`[Currency] testCountry override: ${testParam}`);
      return testParam.toUpperCase();
    }

    const cached = _sessionGet(CACHE_COUNTRY_KEY);
    if (cached) return cached;

    try {
      // ipwho.is — free, no API key, HTTPS
      const res  = await fetch('https://ipwho.is/', { cache: 'no-store' });
      const data = await res.json();
      const code = data.country_code || null;
      if (code) _sessionSet(CACHE_COUNTRY_KEY, code);
      return code;
    } catch {
      return null;
    }
  }

  async function _fetchRate(targetCurrency) {
    if (targetCurrency === 'ZAR') return 1;

    const cacheKey  = CACHE_RATE_PREFIX + targetCurrency;
    const cached    = _sessionGet(cacheKey);
    if (cached) {
      const { rate, ts } = JSON.parse(cached);
      if (Date.now() - ts < CACHE_RATE_TTL_MS) return rate;
    }

    try {
      // open.er-api.com — free tier, no API key, refreshes daily
      const res  = await fetch(`https://open.er-api.com/v6/latest/ZAR`);
      const data = await res.json();
      const rate = data.rates?.[targetCurrency] ?? null;
      if (rate) {
        _sessionSet(cacheKey, JSON.stringify({ rate, ts: Date.now() }));
      }
      return rate;
    } catch {
      return null;
    }
  }

  // ── Initialisation ────────────────────────────────────────────────────────

  async function _init() {
    const countryCode = await _detectCountry();
    const currency    = (countryCode && COUNTRY_CURRENCY[countryCode]) || null;

    if (!currency || currency === 'ZAR') {
      _currency = 'ZAR';
      _rate     = 1;
      _symbol   = 'R';
      _resolveReady();
      return;
    }

    const rate = await _fetchRate(currency);
    if (!rate) {
      // Exchange rate lookup failed — fall back to ZAR display silently
      _currency = 'ZAR';
      _rate     = 1;
      _symbol   = 'R';
      _resolveReady();
      return;
    }

    _currency = currency;
    _rate     = rate;
    _symbol   = CURRENCY_SYMBOLS[currency] || (currency + ' ');
    _resolveReady();
    console.log(`[Currency] ${countryCode} → ${currency} (1 ZAR = ${rate.toFixed(4)} ${currency})`);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Given a ZAR amount in Paystack's minor unit (cents),
   * returns a formatted hint like "≈ €2.45", or null for ZAR visitors.
   */
  function getConvertedDisplay(zarCents) {
    if (!_rate || _currency === 'ZAR') return null;
    const zarAmount   = zarCents / 100;
    const localAmount = zarAmount * _rate;
    const formatted   = WHOLE_NUMBER_CURRENCIES.has(_currency)
      ? Math.round(localAmount).toLocaleString()
      : localAmount.toFixed(2);
    return `≈ ${_symbol}${formatted}`;
  }

  /**
   * Finds every .plan-price element that has a data-zar-cents attribute
   * and injects a local-currency hint span inside it.
   * Call this after renderPaymentPlans() has populated the DOM.
   */
  function updatePlanPrices() {
    document.querySelectorAll('.plan-price[data-zar-cents]').forEach(el => {
      const cents      = parseInt(el.dataset.zarCents, 10);
      const localHint  = getConvertedDisplay(cents);
      if (!localHint) return; // ZAR visitor — nothing to add

      // Avoid double-injection if called more than once
      if (el.querySelector('.plan-price-local')) return;

      const zarDisplay = el.dataset.zarDisplay || el.textContent.trim();
      el.innerHTML =
        `<span class="plan-price-zar">${zarDisplay}</span>` +
        `<span class="plan-price-local">${localHint}</span>`;
    });
  }

  window.MADCurrency = {
    ready,
    getConvertedDisplay,
    updatePlanPrices,
    getCurrency: () => _currency,
    getSymbol:   () => _symbol,
  };

  // Start detection immediately so the result is usually ready
  // by the time plans are rendered
  _init();

}());
