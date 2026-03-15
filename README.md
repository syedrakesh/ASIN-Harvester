# 🕸 ASIN Harvester

A powerful Amazon Product Data Scraper with proxy rotation, rate limiting, real-time UI, and multi-format export.

---

## ✅ Requirements

- **Node.js v18+** — [Download](https://nodejs.org)
- Internet connection (proxies optional but recommended)

---

## 🚀 Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy and configure environment
cp .env.example .env

# 3. Start the web server
npm start

# 4. Open your browser
open http://localhost:3000
```

---

## 🖥 Web UI Features

- **Target Modes**: ASIN list, keyword search
- **Marketplaces**: US, UK, DE, JP, CA, AU
- **Data Fields**: Title, Price, Rating, Reviews, Images, Description, Features, Seller, BSR, Q&A, Dimensions, Variants
- **Rate Limiting**: Slider 5–60 req/min with jitter control
- **Proxy Management**: Add proxies via UI, round-robin rotation, auto-retire failed proxies
- **Real-time Progress**: Live log, metrics, progress bar via WebSocket
- **Export**: CSV, JSON, Excel (.xlsx), TSV, NDJSON, XML

---

## 💻 CLI Usage

```bash
# Scrape by ASINs
node src/cli.js --asins B08N5WRWNW,B09G9FPTP1 --format csv

# Scrape by keyword
node src/cli.js --keywords "wireless earbuds" --format json

# With proxies and rate limit
node src/cli.js --asins B08N5WRWNW --proxies user:pass@host:port --rpm 15 --format xlsx

# All options
node src/cli.js \
  --asins B08N5WRWNW,B09G9FPTP1 \
  --format xlsx \
  --proxies proxy1:8080,proxy2:8080 \
  --rpm 20 \
  --jitter 2000 \
  --retries 3 \
  --market com \
  --output my_products
```

---

## 🌐 REST API

The server also exposes a REST API:

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/scrape` | Start a scrape job |
| POST | `/api/stop` | Stop current scrape |
| GET | `/api/results` | Get scraped results (supports `?q=` search) |
| GET | `/api/stats` | Get scraper stats |
| POST | `/api/export` | Download export file |
| POST | `/api/proxies/add` | Add a proxy |
| GET | `/api/proxies` | List proxies |

### Example: Start a scrape via API

```bash
curl -X POST http://localhost:3000/api/scrape \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "asin",
    "asins": ["B08N5WRWNW", "B09G9FPTP1"],
    "marketplace": "com",
    "rpm": 15,
    "fields": ["title", "price", "rating", "reviews"]
  }'
```

---

## ⚙️ Configuration (`.env`)

```env
PORT=3000
DEFAULT_MARKETPLACE=com
REQUESTS_PER_MINUTE=20
JITTER_MAX_MS=2000
MAX_RETRIES=3
TIMEOUT_MS=15000
PROXIES=user:pass@host1:port,user:pass@host2:port
LOG_LEVEL=info
LOG_TO_FILE=true
```

---

## 📁 Project Structure

```
asin-harvester/
├── src/
│   ├── server.js      # Express + Socket.io server
│   ├── scraper.js     # Core scraping logic
│   ├── exporter.js    # Multi-format export
│   ├── logger.js      # Winston logger
│   └── cli.js         # CLI interface
├── public/
│   └── index.html     # Web UI
├── exports/           # Exported files saved here
├── logs/              # Log files
├── .env.example
├── package.json
└── README.md
```

---

## ⚠️ Legal Notice

This tool is for **educational and personal use only**. Web scraping may violate Amazon's Terms of Service. Use responsibly, respect `robots.txt`, and ensure compliance with applicable laws in your region.

---

## 🔧 Tips for Best Results

1. **Use rotating proxies** (residential proxies work best for Amazon)
2. **Keep RPM low** (10–20 req/min is safer than 60)
3. **Add jitter** to randomize request timing
4. **Use random User-Agent** to avoid fingerprinting
5. **Monitor captcha detection** in the logs
