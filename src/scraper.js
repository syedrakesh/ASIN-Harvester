'use strict';
/**
 * scraper.js — Core Amazon scraping logic
 * Handles: proxy rotation, rate limiting, UA rotation, retries, CAPTCHA detection
 */

const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const cheerio = require('cheerio');
const { HttpsProxyAgent } = require('https-proxy-agent');
const UserAgent = require('user-agents');
const logger = require('./logger');

// ─── Rate Limiter ────────────────────────────────────────────────────────────
class RateLimiter {
  constructor(rpm) {
    this.rpm = rpm;
    this.queue = [];
    this.running = false;
    this.callsThisMinute = 0;
    this.windowStart = Date.now();
  }

  setRPM(rpm) { this.rpm = rpm; }

  async throttle() {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this._process();
    });
  }

  _process() {
    if (this.running) return;
    this.running = true;

    const tick = () => {
      if (!this.queue.length) { this.running = false; return; }

      const now = Date.now();
      if (now - this.windowStart >= 60000) {
        this.callsThisMinute = 0;
        this.windowStart = now;
      }

      if (this.callsThisMinute < this.rpm) {
        this.callsThisMinute++;
        const resolve = this.queue.shift();
        resolve();
        const delay = Math.floor(60000 / this.rpm);
        setTimeout(tick, delay);
      } else {
        const wait = 60000 - (now - this.windowStart) + 100;
        setTimeout(tick, wait);
      }
    };
    tick();
  }

  getStats() {
    return {
      rpm: this.rpm,
      callsThisMinute: this.callsThisMinute,
      queued: this.queue.length,
    };
  }
}

// ─── Proxy Manager ───────────────────────────────────────────────────────────
class ProxyManager {
  constructor(proxies = []) {
    this.proxies = proxies.map((p, i) => ({
      id: i,
      url: p.startsWith('http') ? p : `http://${p}`,
      raw: p,
      failures: 0,
      requests: 0,
      retired: false,
      latencyMs: null,
    }));
    this.idx = 0;
  }

  add(proxy) {
    const url = proxy.startsWith('http') ? proxy : `http://${proxy}`;
    this.proxies.push({ id: this.proxies.length, url, raw: proxy, failures: 0, requests: 0, retired: false, latencyMs: null });
  }

  next(stickyKey = null) {
    const active = this.proxies.filter(p => !p.retired);
    if (!active.length) return null; // direct
    if (stickyKey != null) {
      const idx = Math.abs(this._hash(stickyKey)) % active.length;
      return active[idx];
    }
    const proxy = active[this.idx % active.length];
    this.idx++;
    return proxy;
  }

  markFailure(proxy) {
    if (!proxy) return;
    proxy.failures++;
    if (proxy.failures >= 3) {
      proxy.retired = true;
      logger.warn(`Proxy retired (3 failures): ${proxy.raw}`);
    }
  }

  markSuccess(proxy, latencyMs) {
    if (!proxy) return;
    proxy.failures = 0;
    proxy.requests++;
    proxy.latencyMs = latencyMs;
  }

  getAll() { return this.proxies; }

  _hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    return h;
  }
}

// ─── Main Scraper ────────────────────────────────────────────────────────────
class AmazonScraper {
  constructor(options = {}) {
    this.options = {
      marketplace: options.marketplace || 'com',
      rpm: options.rpm || 20,
      jitterMs: options.jitterMs || 1500,
      maxRetries: options.maxRetries || 3,
      timeoutMs: options.timeoutMs || 15000,
      stickyProxies: options.stickyProxies || false,
      autoRetireProxies: options.autoRetireProxies !== false,
      randomUA: options.randomUA !== false,
    };

    this.rateLimiter = new RateLimiter(this.options.rpm);
    this.proxyManager = new ProxyManager(options.proxies || []);
    this.stats = { scraped: 0, success: 0, failed: 0, retried: 0, captchas: 0 };
    this.aborted = false;
  }

  abort() { this.aborted = true; }
  reset() { this.aborted = false; this.stats = { scraped: 0, success: 0, failed: 0, retried: 0, captchas: 0 }; }

  baseURL() { return `https://www.amazon.${this.options.marketplace}`; }

  _jitter() {
    return new Promise(r => setTimeout(r, Math.random() * this.options.jitterMs));
  }

  _userAgent() {
    if (!this.options.randomUA) return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    return new UserAgent({ deviceCategory: 'desktop' }).toString();
  }

  _makeClient(proxy) {
    const cfg = {
      timeout: this.options.timeoutMs,
      headers: {
        'User-Agent': this._userAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Cache-Control': 'max-age=0',
      },
    };
    if (proxy) cfg.httpsAgent = new HttpsProxyAgent(proxy.url);

    const client = axios.create(cfg);
    axiosRetry(client, {
      retries: this.options.maxRetries,
      retryDelay: (n) => axiosRetry.exponentialDelay(n) + Math.random() * 1000,
      retryCondition: (err) => axiosRetry.isNetworkOrIdempotentRequestError(err) || err?.response?.status === 503,
      onRetry: (n, err) => {
        this.stats.retried++;
        logger.warn(`Retry ${n} for request: ${err.config?.url}`);
      },
    });
    return client;
  }

  _isCaptcha($) {
    const title = $('title').text().toLowerCase();
    const body = $('body').text().toLowerCase();
    return title.includes('robot') || title.includes('captcha') ||
      body.includes('enter the characters you see below') ||
      body.includes('type the characters you see in this image');
  }

  // ── Parse a product page ──────────────────────────────────────────────────
  _parseProduct($, asin, fields) {
    const get = (selectors) => {
      for (const sel of selectors) {
        const txt = $(sel).first().text().trim();
        if (txt) return txt;
      }
      return null;
    };

    const data = { asin, url: `${this.baseURL()}/dp/${asin}`, scraped_at: new Date().toISOString() };

    if (!fields || fields.includes('title'))
      data.title = get(['#productTitle', 'h1#title span', '.product-title-word-break']);

    if (!fields || fields.includes('price')) {
      data.price = get(['.a-price .a-offscreen', '#priceblock_ourprice', '#priceblock_dealprice', '.apexPriceToPay .a-offscreen']);
      data.price_symbol = data.price ? data.price.replace(/[\d.,\s]/g, '').trim() || null : null;
      data.price_value = data.price ? parseFloat(data.price.replace(/[^0-9.]/g, '')) || null : null;
    }

    if (!fields || fields.includes('rating')) {
      const ratingText = get(['.a-icon-alt', '#acrPopover .a-icon-alt', '[data-hook="rating-out-of-text"]']);
      data.rating = ratingText ? parseFloat(ratingText.split(' ')[0]) || null : null;
    }

    if (!fields || fields.includes('reviews')) {
      const reviewText = get(['#acrCustomerReviewText', '[data-hook="total-review-count"]']);
      data.review_count = reviewText ? parseInt(reviewText.replace(/[^0-9]/g, '')) || null : null;
    }

    if (!fields || fields.includes('images')) {
      const imgs = [];
      $('img[data-old-hires], img[data-a-dynamic-image]').each((_, el) => {
        const src = $(el).attr('data-old-hires') || $(el).attr('src');
        if (src && src.includes('images/I/') && !imgs.includes(src)) imgs.push(src);
      });
      data.images = imgs.slice(0, 10);
    }

    if (!fields || fields.includes('description')) {
      data.description = get(['#productDescription p', '#feature-bullets .a-list-item', '#bookDescription_feature_div']);
    }

    if (!fields || fields.includes('features')) {
      const bullets = [];
      $('#feature-bullets li span.a-list-item').each((_, el) => {
        const t = $(el).text().trim();
        if (t) bullets.push(t);
      });
      data.features = bullets;
    }

    if (!fields || fields.includes('seller')) {
      data.seller = get(['#bylineInfo', '#merchant-info', '#sellerProfileTriggerId', '.tabular-buybox-text[tabindex="0"]']);
      data.fulfilled_by = $('body').text().includes('Fulfilled by Amazon') ? 'Amazon' : 'Seller';
    }

    if (!fields || fields.includes('bsr')) {
      const bsrMatch = $('body').text().match(/#([\d,]+)\s+in\s+([^\(]+)/i);
      data.bsr_rank = bsrMatch ? parseInt(bsrMatch[1].replace(/,/g, '')) : null;
      data.bsr_category = bsrMatch ? bsrMatch[2].trim() : null;
    }

    if (!fields || fields.includes('dimensions')) {
      const dims = {};
      $('table tr, .a-normal tr').each((_, row) => {
        const key = $(row).find('th, td:first-child').text().trim().toLowerCase();
        const val = $(row).find('td:last-child').text().trim();
        if (key.includes('dimension') || key.includes('weight') || key.includes('size')) dims[key] = val;
      });
      data.dimensions = Object.keys(dims).length ? dims : null;
    }

    if (!fields || fields.includes('sku')) {
      const skus = [];
      $('#variation_color_name li, #variation_size_name li').each((_, el) => {
        const v = $(el).attr('data-defaultasin') || $(el).attr('data-asin');
        if (v) skus.push(v);
      });
      data.variants = skus;
    }

    if (!fields || fields.includes('qa')) {
      const qa = [];
      $('[data-hook="qa-card"]').each((_, el) => {
        const q = $(el).find('[data-hook="question"]').text().trim();
        const a = $(el).find('[data-hook="answer"]').text().trim();
        if (q) qa.push({ q, a: a || null });
      });
      data.qa = qa.slice(0, 5);
    }

    // Availability
    data.availability = get(['#availability span', '#outOfStock', '.availRed', '.availGreen']) || 'Unknown';
    data.brand = get(['#bylineInfo', '#brand', 'a#bylineInfo']);

    return data;
  }

  // ── Scrape a single ASIN ─────────────────────────────────────────────────
  async scrapeASIN(asin, fields = null) {
    if (this.aborted) throw new Error('Scraper aborted');

    await this.rateLimiter.throttle();
    await this._jitter();

    const proxy = this.proxyManager.next(this.options.stickyProxies ? asin : null);
    const client = this._makeClient(proxy);
    const url = `${this.baseURL()}/dp/${asin}`;
    const t0 = Date.now();

    try {
      logger.info(`Scraping ${asin} via ${proxy ? proxy.raw : 'direct'}`);
      const res = await client.get(url);
      const latency = Date.now() - t0;

      const $ = cheerio.load(res.data);

      if (this._isCaptcha($)) {
        this.stats.captchas++;
        this.proxyManager.markFailure(proxy);
        throw new Error('CAPTCHA_DETECTED');
      }

      this.proxyManager.markSuccess(proxy, latency);
      const product = this._parseProduct($, asin, fields);
      product.latency_ms = latency;
      product.proxy_used = proxy ? proxy.raw : 'direct';

      this.stats.scraped++;
      this.stats.success++;
      logger.info(`✓ ${asin} — "${(product.title || '').substring(0, 50)}" (${latency}ms)`);
      return { ok: true, data: product };

    } catch (err) {
      this.stats.scraped++;
      this.stats.failed++;
      const isCaptcha = err.message === 'CAPTCHA_DETECTED';
      if (!isCaptcha) this.proxyManager.markFailure(proxy);
      logger.error(`✗ ${asin} — ${err.message}`);
      return { ok: false, asin, error: err.message, captcha: isCaptcha };
    }
  }

  // ── Bulk scrape ──────────────────────────────────────────────────────────
  async scrapeMany(asins, fields = null, onProgress = null) {
    this.reset();
    const results = [];

    for (let i = 0; i < asins.length; i++) {
      if (this.aborted) break;
      const result = await this.scrapeASIN(asins[i], fields);
      results.push(result);
      if (onProgress) onProgress({ current: i + 1, total: asins.length, result, stats: this.stats });
    }

    return results;
  }

  // ── Search scraping ──────────────────────────────────────────────────────
  async scrapeSearch(keyword, pages = 1) {
    const asins = [];
    for (let page = 1; page <= pages; page++) {
      if (this.aborted) break;
      await this.rateLimiter.throttle();
      await this._jitter();

      const proxy = this.proxyManager.next();
      const client = this._makeClient(proxy);
      const url = `${this.baseURL()}/s?k=${encodeURIComponent(keyword)}&page=${page}`;

      try {
        const res = await client.get(url);
        const $ = cheerio.load(res.data);
        $('[data-asin]').each((_, el) => {
          const a = $(el).attr('data-asin');
          if (a && a.length === 10) asins.push(a);
        });
        logger.info(`Search page ${page}/${pages} for "${keyword}": found ${asins.length} ASINs`);
      } catch (err) {
        logger.error(`Search error page ${page}: ${err.message}`);
      }
    }
    return [...new Set(asins)];
  }

  getStats() { return { ...this.stats, rateLimiter: this.rateLimiter.getStats(), proxies: this.proxyManager.getAll() }; }
}

module.exports = { AmazonScraper, ProxyManager, RateLimiter };
