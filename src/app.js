import express from "express";
import { createHash, randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { parseUserAgent, referrerName } from "./ua.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no look-alike characters
const CODE_RE = /^[A-Za-z0-9_-]{3,32}$/;
const OWNER_RE = /^[A-Za-z0-9-]{16,64}$/;
const RESERVED = new Set(["api", "assets", "index", "app", "admin", "static", "favicon", "health", "stats"]);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const now = () => new Date().toISOString();

function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, _res, next) => {
    const t = Date.now();
    const list = (hits.get(req.ip) ?? []).filter((x) => t - x < windowMs);
    if (list.length >= max) return next(new HttpError(429, "You're creating links too fast. Try again in a minute."));
    list.push(t);
    hits.set(req.ip, list);
    next();
  };
}

export function normalizeUrl(raw) {
  let value = String(raw ?? "").trim();
  if (!value) throw new HttpError(400, "Please enter a URL");
  // Add https:// unless a scheme is given ("localhost:3000" has no scheme, "javascript:..." does)
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^(javascript|data|vbscript|file|mailto|tel):/i.test(value)) {
    value = `https://${value}`;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "That doesn't look like a valid URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new HttpError(400, "Only http and https links are allowed");
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host === "localhost" || /^(127\.|10\.|192\.168\.|0\.)/.test(host)) {
    throw new HttpError(400, "Please use a public website address");
  }
  if (value.length > 2048) throw new HttpError(400, "That URL is too long");
  return url.toString();
}

const SQL = {
  byCode: "SELECT * FROM links WHERE lower(code) = lower(?)",
  insert: "INSERT INTO links (code, url, owner, created_at) VALUES (?, ?, ?, ?) RETURNING *",
  remove: "DELETE FROM links WHERE id = ? AND owner = ?",
  listByOwner: `
    SELECT l.id, l.code, l.url, l.owner, l.created_at, COUNT(c.id) AS clicks, MAX(c.clicked_at) AS last_click
    FROM links l LEFT JOIN clicks c ON c.link_id = l.id
    WHERE l.owner = ? GROUP BY l.id, l.code, l.url, l.owner, l.created_at ORDER BY l.created_at DESC, l.id DESC`,
  addClick: "INSERT INTO clicks (link_id, clicked_at, referrer, browser, os, device, visitor) VALUES (?, ?, ?, ?, ?, ?, ?)",
  totals: "SELECT COUNT(*) AS clicks, COUNT(DISTINCT visitor) AS visitors FROM clicks WHERE link_id = ?",
  perDay: `
    SELECT substr(clicked_at, 1, 10) AS day, COUNT(*) AS clicks
    FROM clicks WHERE link_id = ? AND clicked_at >= ? GROUP BY substr(clicked_at, 1, 10) ORDER BY day`,
  // The column name comes from a fixed list below, never from user input
  groupBy: (column) =>
    `SELECT ${column} AS name, COUNT(*) AS clicks FROM clicks WHERE link_id = ? GROUP BY ${column} ORDER BY COUNT(*) DESC, ${column} LIMIT 8`,
  recent: "SELECT clicked_at, referrer, browser, os, device FROM clicks WHERE link_id = ? ORDER BY id DESC LIMIT 10",
};
const GROUPS = { referrers: "referrer", browsers: "browser", os: "os", devices: "device" };

// `database` may be a ready db or a promise of one (serverless cold starts connect lazily)
export function createApp({ database, salt = "snip" }) {
  const dbReady = Promise.resolve(database);
  dbReady.catch(() => {}); // reported per request below

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "20kb" }));
  app.use((_req, res, next) => {
    res.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "strict-origin-when-cross-origin" });
    next();
  });

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  const withDb = wrap(async (req, _res, next) => {
    try {
      req.db = await dbReady;
    } catch (err) {
      console.error("Database connection failed:", err);
      throw new HttpError(503, "The database is not available right now");
    }
    next();
  });
  app.use("/api", withDb);

  const origin = (req) => `${req.protocol}://${req.get("host")}`;
  const toLink = (row, req) => ({
    code: row.code,
    url: row.url,
    shortUrl: `${origin(req)}/${row.code}`,
    createdAt: row.created_at,
    clicks: Number(row.clicks ?? 0),
    lastClick: row.last_click ?? null,
  });
  const counts = (rows) => rows.map((r) => ({ name: r.name, clicks: Number(r.clicks) }));

  // Links are grouped by an anonymous "owner key" the browser generates, so no sign-up is needed
  const owner = (req, _res, next) => {
    const key = req.get("x-owner-key") ?? "";
    if (!OWNER_RE.test(key)) return next(new HttpError(401, "Missing owner key"));
    req.owner = key;
    next();
  };

  const findOwned = async (req) => {
    const row = await req.db.get(SQL.byCode, [req.params.code]);
    if (!row || row.owner !== req.owner) throw new HttpError(404, "Link not found");
    return row;
  };

  const newCode = async (db) => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
      if (!(await db.get(SQL.byCode, [code]))) return code;
    }
    throw new HttpError(500, "Could not generate a code");
  };

  // ----- API -----
  app.post("/api/links", owner, rateLimit({ windowMs: 60_000, max: 20 }), wrap(async (req, res) => {
    const url = normalizeUrl(req.body?.url);
    if (new URL(url).hostname === req.hostname) throw new HttpError(400, "You can't shorten a link to this site");

    let code = String(req.body?.alias ?? "").trim();
    if (code) {
      if (!CODE_RE.test(code)) throw new HttpError(400, "Alias can use letters, numbers, - and _ (3–32 characters)");
      if (RESERVED.has(code.toLowerCase())) throw new HttpError(400, "That alias is reserved");
      if (await req.db.get(SQL.byCode, [code])) throw new HttpError(409, "That alias is already taken");
    } else {
      code = await newCode(req.db);
    }
    const row = await req.db.get(SQL.insert, [code, url, req.owner, now()]);
    res.status(201).json({ link: toLink(row, req) });
  }));

  app.get("/api/links", owner, wrap(async (req, res) => {
    const rows = await req.db.all(SQL.listByOwner, [req.owner]);
    res.json({ links: rows.map((r) => toLink(r, req)) });
  }));

  app.get("/api/links/:code/stats", owner, wrap(async (req, res) => {
    const link = await findOwned(req);
    const days = Math.min(Math.max(Number(req.query.days) || 30, 7), 90);
    const since = new Date(Date.now() - (days - 1) * 86400000);
    since.setUTCHours(0, 0, 0, 0);

    const [perDay, totals, recent, ...grouped] = await Promise.all([
      req.db.all(SQL.perDay, [link.id, since.toISOString()]),
      req.db.get(SQL.totals, [link.id]),
      req.db.all(SQL.recent, [link.id]),
      ...Object.values(GROUPS).map((column) => req.db.all(SQL.groupBy(column), [link.id])),
    ]);

    const byDay = Object.fromEntries(perDay.map((r) => [r.day, Number(r.clicks)]));
    const timeline = Array.from({ length: days }, (_, i) => {
      const day = new Date(since.getTime() + i * 86400000).toISOString().slice(0, 10);
      return { day, clicks: byDay[day] ?? 0 };
    });
    const [referrers, browsers, os, devices] = grouped.map(counts);

    res.json({
      link: toLink({ ...link, clicks: totals.clicks }, req),
      totals: { clicks: Number(totals.clicks), visitors: Number(totals.visitors) },
      timeline,
      referrers,
      browsers,
      os,
      devices,
      recent,
    });
  }));

  app.get("/api/links/:code/qr.svg", wrap(async (req, res) => {
    const row = await req.db.get(SQL.byCode, [req.params.code]);
    if (!row) throw new HttpError(404, "Link not found");
    const svg = await QRCode.toString(`${origin(req)}/${row.code}`, { type: "svg", margin: 1, width: 240, color: { dark: "#111827", light: "#ffffff" } });
    res.type("image/svg+xml").set("Cache-Control", "public, max-age=86400").send(svg);
  }));

  app.delete("/api/links/:code", owner, wrap(async (req, res) => {
    const link = await findOwned(req);
    await req.db.all(SQL.remove, [link.id, req.owner]);
    res.status(204).end();
  }));

  app.use("/api", (_req, _res, next) => next(new HttpError(404, "Route not found")));

  app.use(express.static(PUBLIC_DIR));

  // ----- the redirect itself -----
  app.get("/:code", (req, res, next) => (CODE_RE.test(req.params.code) ? next() : next("route")), withDb, wrap(async (req, res) => {
    const link = await req.db.get(SQL.byCode, [req.params.code]);
    if (!link) return res.status(404).sendFile("404.html", { root: PUBLIC_DIR });

    const ua = req.get("user-agent") ?? "";
    const info = parseUserAgent(ua);
    if (!info.bot) {
      // Privacy-friendly unique visitors: a daily hash of IP + browser, never the raw IP
      const day = new Date().toISOString().slice(0, 10);
      const visitor = createHash("sha256").update(`${salt}|${day}|${req.ip}|${ua}`).digest("hex").slice(0, 16);
      await req.db.all(SQL.addClick, [link.id, now(), referrerName(req.get("referer"), req.hostname), info.browser, info.os, info.device, visitor]);
    }
    res.set("Cache-Control", "no-store").redirect(302, link.url);
  }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === "entity.parse.failed") err = new HttpError(400, "Request body must be valid JSON");
    const status = err.status ?? 500;
    if (status >= 500 && status !== 503) console.error(err);
    res.status(status).json({ error: status >= 500 && status !== 503 ? "Something went wrong" : err.message });
  });

  return app;
}
