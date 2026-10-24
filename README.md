# ✂️ Snip — Link Shortener with Analytics

Snip is a full-stack URL shortener like Bitly. It turns long links into short ones with optional **custom aliases**, generates a **QR code** for each, and tracks every click with a clean **analytics dashboard**: clicks over time, unique visitors, referrers, browsers, operating systems and devices.

**Backend:** Node.js, Express, **Postgres** (Neon) in production and **SQLite** (built-in `node:sqlite`) locally, `qrcode`
**Frontend:** vanilla JavaScript + **Chart.js**
**Tests:** 16 integration tests with `node:test`, with the API tests run on both SQLite and Postgres (via PGlite)
**Hosting:** Vercel (serverless) + Neon Postgres

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/akrambgh1/link-shortener)

## ✨ Features

- 🔗 **Shorten any link**, with `https://` added automatically and validation (blocks `javascript:` and private or localhost addresses)
- ✏️ **Custom aliases** (`/my-portfolio`), with reserved words and duplicates rejected
- 📱 **QR code** for every link (SVG, downloadable)
- 📊 **Analytics dashboard** for each link:
  - Total clicks and **unique visitors**
  - **Clicks over time** chart (7 / 30 / 90 days)
  - **Devices** and **browsers** doughnut charts
  - Top **referrers** and **operating systems**
  - Table of recent clicks
- 🤖 **Bots and link-preview crawlers are ignored**, so the numbers stay honest
- 🕵️ **Privacy-friendly**: unique visitors use a daily salted hash, so raw IP addresses are never stored
- 👤 **No sign-up**: each browser gets an anonymous owner key, so you only see and manage your own links
- 🚦 Rate limiting, security headers, a friendly 404 page and JSON errors

## 🚀 Run Locally

Requires **Node.js 22.13 or newer**.

```bash
git clone https://github.com/akrambgh1/link-shortener.git
cd link-shortener
npm install
npm start      # http://localhost:4100
npm test
```

## 📖 API

All `/api/links` routes need an `X-Owner-Key` header (any random 16–64 character string).

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/links` | `{ url, alias? }` → create a short link |
| GET | `/api/links` | Your links with click counts |
| GET | `/api/links/:code/stats?days=30` | Totals, timeline, referrers, browsers, OS, devices, recent clicks |
| GET | `/api/links/:code/qr.svg` | QR code image |
| DELETE | `/api/links/:code` | Delete a link and its clicks |
| GET | `/:code` | **302 redirect** to the original URL (and records the click) |

```bash
curl -X POST http://localhost:4100/api/links \
  -H "Content-Type: application/json" -H "X-Owner-Key: my-secret-owner-key-123" \
  -d '{"url":"github.com/akrambgh1","alias":"me"}'
# → { "link": { "code": "me", "shortUrl": "http://localhost:4100/me", ... } }
```

## 🗄️ Database

```
links  (id, code UNIQUE, url, owner, created_at)
clicks (id, link_id → links ON DELETE CASCADE, clicked_at, referrer, browser, os, device, visitor)
```

Stats are calculated with SQL `GROUP BY` queries, and days with no clicks are filled in, so the chart never has gaps.

## ☁️ Deploy for free (Vercel + Neon)

1. Click **Deploy with Vercel** above (or import the repo at vercel.com/new).
2. In the project, open **Storage → Create Database → Neon (Postgres)** and connect it. This adds `DATABASE_URL`.
3. Optional: add a `VISITOR_SALT` environment variable (any random string), then **Redeploy**.

`vercel.json` sends `/api/*` and short codes like `/my-link` to the serverless function. Everything else (the dashboard) is served as static files.

## 🗄️ One codebase, two databases

`src/db.js` exposes a tiny `all()` / `get()` interface with `?` placeholders, converted to `$1, $2…` for Postgres. Case-insensitive aliases use a `lower(code)` unique index that works in both. The API tests run on SQLite **and** on real Postgres via [PGlite](https://pglite.dev).

## 📂 Project Structure

```
link-shortener/
├── server.js         # Local server
├── api/index.js      # Vercel serverless entry
├── vercel.json       # Rewrites for /api/* and short codes
├── src/
│   ├── app.js        # Routes, validation, redirect + click tracking, stats
│   ├── db.js         # SQLite / Postgres adapter + schema
│   └── ua.js         # User-agent & referrer parsing
├── public/           # Dashboard (HTML, CSS, JS + Chart.js), 404 page
└── test/api.test.js
```

## 📚 What I Learned

- Designing short codes (no look-alike characters) and handling collisions
- HTTP redirects and why `Cache-Control: no-store` matters for click counting
- Writing analytics queries and filling missing days for charts
- Counting unique visitors without storing personal data
- Building a dashboard with Chart.js without a frontend framework

## 📄 License

MIT. Free to use and modify.
