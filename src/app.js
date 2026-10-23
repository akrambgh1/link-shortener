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

function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, _res, next) => {
    const now = Date.now();
    const list = (hits.get(req.ip) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= max) return next(new HttpError(429, "You're creating links too fast. Try again in a minute."));
    list.push(now);
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

export function createApp({ db, salt = "snip" }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "20kb" }));
  app.use((_req, res, next) => {
    res.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "strict-origin-when-cross-origin" });
    next();
  });

  const q = {
    byCode: db.prepare("SELECT * FROM links WHERE code = ?"),
    insert: db.prepare("INSERT INTO links (code, url, owner) VALUES (?, ?, ?)"),
    remove: db.prepare("DELETE FROM links WHERE code = ? AND owner = ?"),
    listByOwner: db.prepare(`
      SELECT l.*, COUNT(c.id) AS clicks, MAX(c.clicked_at) AS last_click
      FROM links l LEFT JOIN clicks c ON c.link_id = l.id
      WHERE l.owner = ? GROUP BY l.id ORDER BY l.created_at DESC, l.id DESC`),
    addClick: db.prepare("INSERT INTO clicks (link_id, referrer, browser, os, device, visitor) VALUES (?, ?, ?, ?, ?, ?)"),
    totals: db.prepare("SELECT COUNT(*) AS clicks, COUNT(DISTINCT visitor) AS visitors FROM clicks WHERE link_id = ?"),
    perDay: db.prepare(`
      SELECT substr(clicked_at, 1, 10) AS day, COUNT(*) AS clicks
      FROM clicks WHERE link_id = ? AND clicked_at >= ? GROUP BY day ORDER BY day`),
    groupBy: (column) =>
      db.prepare(`SELECT ${column} AS name, COUNT(*) AS clicks FROM clicks WHERE link_id = ? GROUP BY ${column} ORDER BY clicks DESC LIMIT 8`),
    recent: db.prepare("SELECT clicked_at, referrer, browser, os, device FROM clicks WHERE link_id = ? ORDER BY id DESC LIMIT 10"),
  };
  const groups = { referrers: q.groupBy("referrer"), browsers: q.groupBy("browser"), os: q.groupBy("os"), devices: q.groupBy("device") };

  const origin = (req) => `${req.protocol}://${req.get("host")}`;
  const toLink = (row, req) => ({
    code: row.code,
    url: row.url,
    shortUrl: `${origin(req)}/${row.code}`,
    createdAt: row.created_at,
    clicks: row.clicks ?? 0,
    lastClick: row.last_click ?? null,
  });

  // Links are grouped by an anonymous "owner key" the browser generates, so no sign-up is needed
  const owner = (req, _res, next) => {
    const key = req.get("x-owner-key") ?? "";
    if (!OWNER_RE.test(key)) return next(new HttpError(401, "Missing owner key"));
    req.owner = key;
    next();
  };

  const findOwned = (req) => {
    const row = q.byCode.get(req.params.code);
    if (!row || row.owner !== req.owner) throw new HttpError(404, "Link not found");
    return row;
  };

  const newCode = () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
      if (!q.byCode.get(code)) return code;
    }
    throw new HttpError(500, "Could not generate a code");
  };

  // ----- API -----
  app.post("/api/links", owner, rateLimit({ windowMs: 60_000, max: 20 }), wrap(async (req, res) => {
    const url = normalizeUrl(req.body?.url);
    const selfHost = req.hostname;
    if (new URL(url).hostname === selfHost) throw new HttpError(400, "You can't shorten a link to this site");

    let code = String(req.body?.alias ?? "").trim();
    if (code) {
      if (!CODE_RE.test(code)) throw new HttpError(400, "Alias can use letters, numbers, - and _ (3–32 characters)");
      if (RESERVED.has(code.toLowerCase())) throw new HttpError(400, "That alias is reserved");
      if (q.byCode.get(code)) throw new HttpError(409, "That alias is already taken");
    } else {
      code = newCode();
    }
    q.insert.run(code, url, req.owner);
    res.status(201).json({ link: toLink(q.byCode.get(code), req) });
  }));

  app.get("/api/links", owner, (req, res) => {
    res.json({ links: q.listByOwner.all(req.owner).map((r) => toLink(r, req)) });
  });

  app.get("/api/links/:code/stats", owner, wrap(async (req, res) => {
    const link = findOwned(req);
    const days = Math.min(Math.max(Number(req.query.days) || 30, 7), 90);
    const since = new Date(Date.now() - (days - 1) * 86400000);
    since.setUTCHours(0, 0, 0, 0);

    const counts = Object.fromEntries(q.perDay.all(link.id, since.toISOString()).map((r) => [r.day, r.clicks]));
    const timeline = Array.from({ length: days }, (_, i) => {
      const day = new Date(since.getTime() + i * 86400000).toISOString().slice(0, 10);
      return { day, clicks: counts[day] ?? 0 };
    });

    const totals = q.totals.get(link.id);
    res.json({
      link: toLink({ ...link, clicks: totals.clicks }, req),
      totals: { clicks: totals.clicks, visitors: totals.visitors },
      timeline,
      referrers: groups.referrers.all(link.id),
      browsers: groups.browsers.all(link.id),
      os: groups.os.all(link.id),
      devices: groups.devices.all(link.id),
      recent: q.recent.all(link.id),
    });
  }));

  app.get("/api/links/:code/qr.svg", wrap(async (req, res) => {
    const row = q.byCode.get(req.params.code);
    if (!row) throw new HttpError(404, "Link not found");
    const svg = await QRCode.toString(`${origin(req)}/${row.code}`, { type: "svg", margin: 1, width: 240, color: { dark: "#111827", light: "#ffffff" } });
    res.type("image/svg+xml").set("Cache-Control", "public, max-age=86400").send(svg);
  }));

  app.delete("/api/links/:code", owner, wrap(async (req, res) => {
    findOwned(req);
    q.remove.run(req.params.code, req.owner);
    res.status(204).end();
  }));

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.use("/api", (_req, _res, next) => next(new HttpError(404, "Route not found")));

  app.use(express.static(PUBLIC_DIR));

  // ----- the redirect itself -----
  app.get("/:code", (req, res, next) => {
    const { code } = req.params;
    if (!CODE_RE.test(code)) return next();
    const link = q.byCode.get(code);
    if (!link) return res.status(404).sendFile("404.html", { root: PUBLIC_DIR });

    const ua = req.get("user-agent") ?? "";
    const info = parseUserAgent(ua);
    if (!info.bot) {
      // Privacy-friendly unique visitors: a daily hash of IP + browser, never the raw IP
      const day = new Date().toISOString().slice(0, 10);
      const visitor = createHash("sha256").update(`${salt}|${day}|${req.ip}|${ua}`).digest("hex").slice(0, 16);
      q.addClick.run(link.id, referrerName(req.get("referer"), req.hostname), info.browser, info.os, info.device, visitor);
    }
    res.set("Cache-Control", "no-store").redirect(302, link.url);
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === "entity.parse.failed") err = new HttpError(400, "Request body must be valid JSON");
    const status = err.status ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? "Something went wrong" : err.message });
  });

  return app;
}
