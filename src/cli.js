#!/usr/bin/env node
'use strict';
/**
 * cli.js — Command-line interface for ASIN Harvester
 * Usage: node src/cli.js --asins B08N5WRWNW,B09G9FPTP1 --format csv
 */
require('dotenv').config();

const { AmazonScraper } = require('./scraper');
const { Exporter } = require('./exporter');
const logger = require('./logger');

const cliProgress = require('cli-progress');
const chalk = require('chalk');

// ─── Parse CLI args ──────────────────────────────────────────────────────────
const args = {};
process.argv.slice(2).forEach((a, i, arr) => {
  if (a.startsWith('--')) args[a.slice(2)] = arr[i + 1] || true;
});

const asins     = (args.asins || '').split(',').map(s => s.trim()).filter(Boolean);
const keywords  = (args.keywords || '').split(',').map(s => s.trim()).filter(Boolean);
const format    = args.format || 'csv';
const proxies   = (args.proxies || process.env.PROXIES || '').split(',').map(s => s.trim()).filter(Boolean);
const rpm       = parseInt(args.rpm || process.env.REQUESTS_PER_MINUTE || 20);
const jitter    = parseInt(args.jitter || process.env.JITTER_MAX_MS || 1500);
const retries   = parseInt(args.retries || process.env.MAX_RETRIES || 3);
const market    = args.market || process.env.DEFAULT_MARKETPLACE || 'com';
const filename  = args.output || 'amazon_products';

if (!asins.length && !keywords.length) {
  console.log(chalk.red('\nError: Provide --asins or --keywords\n'));
  console.log(chalk.yellow('Usage:'));
  console.log('  node src/cli.js --asins B08N5WRWNW,B09G9FPTP1 [options]');
  console.log('  node src/cli.js --keywords "wireless earbuds" --format json\n');
  console.log(chalk.yellow('Options:'));
  console.log('  --asins      Comma-separated ASIN list');
  console.log('  --keywords   Comma-separated search keywords');
  console.log('  --format     csv | json | tsv | ndjson | xml | xlsx  (default: csv)');
  console.log('  --proxies    Comma-separated proxy list (host:port)');
  console.log('  --rpm        Requests per minute (default: 20)');
  console.log('  --jitter     Max jitter ms (default: 1500)');
  console.log('  --market     Amazon marketplace: com, co.uk, de, etc.  (default: com)');
  console.log('  --output     Output filename prefix (default: amazon_products)');
  process.exit(1);
}

// ─── Banner ──────────────────────────────────────────────────────────────────
console.log(chalk.hex('#F97316').bold('\n╔══════════════════════════════╗'));
console.log(chalk.hex('#F97316').bold('║      ASIN Harvester v1.0     ║'));
console.log(chalk.hex('#F97316').bold('╚══════════════════════════════╝\n'));
console.log(chalk.gray(`  Marketplace : amazon.${market}`));
console.log(chalk.gray(`  Rate limit  : ${rpm} req/min`));
console.log(chalk.gray(`  Jitter      : ${jitter}ms`));
console.log(chalk.gray(`  Retries     : ${retries}`));
console.log(chalk.gray(`  Proxies     : ${proxies.length || 'none (direct)'}`));
console.log(chalk.gray(`  Export fmt  : ${format}\n`));

// ─── Run ──────────────────────────────────────────────────────────────────────
(async () => {
  const scraper = new AmazonScraper({ marketplace: market, rpm, jitterMs: jitter, maxRetries: retries, proxies });
  const exporter = new Exporter();
  const results = [];

  let targets = [...asins];

  if (keywords.length) {
    console.log(chalk.cyan(`Searching for keywords: ${keywords.join(', ')}`));
    for (const kw of keywords) {
      const found = await scraper.scrapeSearch(kw);
      console.log(chalk.green(`  "${kw}" → ${found.length} ASINs found`));
      targets.push(...found);
    }
    targets = [...new Set(targets)];
  }

  if (!targets.length) {
    console.log(chalk.red('No ASINs found to scrape.'));
    process.exit(1);
  }

  console.log(chalk.white(`\nScraping ${targets.length} product(s)...\n`));

  const bar = new cliProgress.SingleBar({
    format: `  Progress |${chalk.hex('#F97316')('{bar}')}| {percentage}% | {value}/{total} | ETA: {eta}s | ✓ {success} ✗ {failed}`,
    barCompleteChar: '█',
    barIncompleteChar: '░',
    hideCursor: true,
  });

  bar.start(targets.length, 0, { success: 0, failed: 0 });

  await scraper.scrapeMany(targets, null, ({ current, result, stats }) => {
    if (result.ok) results.push(result.data);
    bar.update(current, { success: stats.success, failed: stats.failed });
  });

  bar.stop();

  const s = scraper.getStats();
  console.log(chalk.white(`\n  Results: ${chalk.green(s.success + ' success')}  ${chalk.red(s.failed + ' failed')}  ${chalk.yellow(s.captchas + ' captchas')}\n`));

  if (!results.length) {
    console.log(chalk.red('No data collected. Check proxies or network.'));
    process.exit(1);
  }

  try {
    const fp = exporter.export(format, results, { filename });
    console.log(chalk.green(`✓ Exported ${results.length} products → ${fp}\n`));
  } catch (err) {
    console.log(chalk.red(`Export failed: ${err.message}`));
  }
})();
