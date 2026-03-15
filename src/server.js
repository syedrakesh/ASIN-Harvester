'use strict';
require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server: SocketIO } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const { AmazonScraper } = require('./scraper');
const { Exporter } = require('./exporter');
const logger = require('./logger');

const app = express();
const server = http.createServer(app);
const io = new SocketIO(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── State ───────────────────────────────────────────────────────────────────
let scraper = null;
let isRunning = false;
let scrapedResults = [];
const exporter = new Exporter();

// ─── REST API ────────────────────────────────────────────────────────────────

// POST /api/scrape — start a scrape job
app.post('/api/scrape', async (req, res) => {
  if (isRunning) return res.status(409).json({ error: 'Scrape already running' });

  const {
    asins = [], keywords = [], categoryUrl,
    mode = 'asin',
    marketplace = 'com',
    rpm = 20, jitterMs = 1500, maxRetries = 3, timeoutMs = 15000,
    proxies = [], stickyProxies = false,
    fields = null,
    // Search options
    maxPages = 5,
    includeSponsored = true,
    stopOnEmpty = true,
    thinPageThreshold = 5,
    scrapeSearchMetadataOnly = false,
  } = req.body;

  scraper = new AmazonScraper({ marketplace, rpm, jitterMs, maxRetries, timeoutMs, proxies, stickyProxies });
  scrapedResults = [];
  isRunning = true;

  res.json({ ok: true, message: 'Scrape started' });

  // Run async
  (async () => {
    try {
      let targets = [...asins];
      // Shared seen-ASIN set so keywords don't duplicate each other
      const globalSeen = new Set(asins);
      // Collect search-page metadata (available without a product request)
      const searchMetadata = [];

      if (mode === 'search' && keywords.length) {
        io.emit('log', { type: 'info', msg: `Searching ${keywords.length} keyword(s) — up to ${maxPages} page(s) each${includeSponsored ? '' : ', skipping sponsored'}...` });

        for (const kw of keywords) {
          if (scraper.aborted) break;

          io.emit('log', { type: 'info', msg: `🔍 Searching: "${kw}"` });

          const result = await scraper.scrapeSearch(kw, {
            maxPages,
            includeSponsored,
            stopOnEmpty,
            thinPageThreshold,
            globalSeenASINs: globalSeen,
            onPageDone: ({ page, maxPages, newASINs, totalCollected, detectedTotal, thin, noResults }) => {
              const total = detectedTotal ? `~${detectedTotal.toLocaleString()} total on Amazon` : '';
              const flags = [thin ? '⚠ thin' : '', noResults ? '✗ no results' : ''].filter(Boolean).join(' ');
              io.emit('log', {
                type: noResults ? 'warn' : (thin ? 'warn' : 'ok'),
                msg: `  Page ${page}/${maxPages}: +${newASINs} ASINs (${totalCollected} so far)${total ? ' · ' + total : ''}${flags ? ' · ' + flags : ''}`,
              });
              io.emit('search:page', { keyword: kw, page, maxPages, newASINs, totalCollected, detectedTotal });
            },
          });

          targets.push(...result.asins);
          searchMetadata.push(...result.metadata);

          const sponsoredCount = result.metadata.filter(m => m.is_sponsored).length;
          io.emit('log', {
            type: 'ok',
            msg: `✓ "${kw}" → ${result.asins.length} unique ASINs` +
              (result.detectedTotal ? ` (Amazon: ~${result.detectedTotal.toLocaleString()})` : '') +
              (sponsoredCount ? ` · ${sponsoredCount} sponsored skipped or included` : ''),
          });
        }

        // If metadata-only mode, push metadata directly as results and skip product scraping
        if (scrapeSearchMetadataOnly) {
          scrapedResults = searchMetadata;
          io.emit('scrape:start', { total: 0 });
          io.emit('scrape:complete', { stats: scraper.getStats(), total: scrapedResults.length });
          io.emit('log', { type: 'ok', msg: `Search metadata mode: ${scrapedResults.length} products collected from search pages (no product requests made).` });
          return;
        }
      }

      io.emit('scrape:start', { total: targets.length });
      io.emit('log', { type: 'info', msg: `Starting scrape of ${targets.length} ASINs...` });

      await scraper.scrapeMany(targets, fields, ({ current, total, result, stats }) => {
        if (result.ok) scrapedResults.push(result.data);

        io.emit('scrape:progress', {
          current, total,
          pct: Math.round((current / total) * 100),
          result,
          stats,
        });

        const msg = result.ok
          ? `✓ ${result.data.asin} — "${(result.data.title || '').substring(0, 45)}..."`
          : `✗ ${result.asin} — ${result.error}`;
        io.emit('log', { type: result.ok ? 'ok' : (result.captcha ? 'warn' : 'err'), msg });
      });

      io.emit('scrape:complete', { stats: scraper.getStats(), total: scrapedResults.length });
      io.emit('log', { type: 'ok', msg: `Scraping complete! ${scrapedResults.length} products collected.` });

    } catch (err) {
      logger.error(err);
      io.emit('scrape:error', { error: err.message });
    } finally {
      isRunning = false;
    }
  })();
});

// POST /api/stop
app.post('/api/stop', (req, res) => {
  if (scraper) scraper.abort();
  isRunning = false;
  io.emit('log', { type: 'warn', msg: 'Scrape stopped by user.' });
  res.json({ ok: true });
});

// GET /api/results
app.get('/api/results', (req, res) => {
  const { q, sort, order = 'asc' } = req.query;
  let data = [...scrapedResults];

  if (q) {
    const lq = q.toLowerCase();
    data = data.filter(p =>
      (p.title || '').toLowerCase().includes(lq) ||
      (p.asin || '').toLowerCase().includes(lq)
    );
  }

  if (sort) {
    data.sort((a, b) => {
      const av = a[sort] ?? '', bv = b[sort] ?? '';
      if (typeof av === 'number') return order === 'asc' ? av - bv : bv - av;
      return order === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
    });
  }

  res.json({ ok: true, count: data.length, data });
});

// GET /api/stats
app.get('/api/stats', (req, res) => {
  res.json({ ok: true, stats: scraper ? scraper.getStats() : null, isRunning, resultCount: scrapedResults.length });
});

// POST /api/export
app.post('/api/export', (req, res) => {
  const { format = 'csv', filename = 'amazon_products', flattenNested = true } = req.body;
  if (!scrapedResults.length) return res.status(400).json({ error: 'No data to export' });

  try {
    const fp = exporter.export(format, scrapedResults, { filename, flattenNested });
    const fname = path.basename(fp);
    res.download(fp, fname, (err) => {
      if (err) logger.error('Download error:', err);
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/proxies/add
app.post('/api/proxies/add', (req, res) => {
  const { proxy } = req.body;
  if (!proxy) return res.status(400).json({ error: 'No proxy provided' });
  if (scraper) scraper.proxyManager.add(proxy);
  res.json({ ok: true });
});

// GET /api/proxies
app.get('/api/proxies', (req, res) => {
  const proxies = scraper ? scraper.proxyManager.getAll() : [];
  res.json({ ok: true, proxies });
});

// ─── Socket.io ───────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id}`);
  socket.emit('log', { type: 'info', msg: 'Connected to ASIN Harvester server.' });
  socket.emit('stats', { isRunning, resultCount: scrapedResults.length });

  socket.on('disconnect', () => logger.info(`Client disconnected: ${socket.id}`));
});

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`🕸  ASIN Harvester running → http://localhost:${PORT}`);
});
