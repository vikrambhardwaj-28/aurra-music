require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const ytSearch = require("yt-search");

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.AURA_SECRET || crypto.randomBytes(32).toString("hex");
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const SIGN_WINDOW_MS = 90_000;
const PLAY_TICKET_TTL_MS = 120_000;

// ---- fingerprint stripping ----
app.disable("x-powered-by");
app.set("etag", false);

app.use((req, res, next) => {
  res.removeHeader("X-Powered-By");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Permissions-Policy", "interest-cohort=()");
  // Don't leak tech stack in errors
  res.setHeader("Cache-Control", "no-store");
  next();
});

let lyricsHandler = null;
try {
  lyricsHandler = require("./lyricsHandler");
} catch (_) {}

// ---- crypto helpers ----
function deriveKey() {
  return crypto.createHash("sha256").update(String(SECRET)).digest();
}
function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}
function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest("base64url");
}
function makeTid(mediaId) {
  const iv = crypto.randomBytes(12);
  const exp = Date.now() + TOKEN_TTL_MS;
  const plain = Buffer.from(`${mediaId}|${exp}`, "utf8");
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(), iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64url");
}
function parseTid(tid) {
  try {
    const buf = Buffer.from(String(tid || ""), "base64url");
    if (buf.length < 29) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
    const [mediaId, expStr] = plain.split("|");
    if (!mediaId || !/^[a-zA-Z0-9_-]{6,20}$/.test(mediaId)) return null;
    if (Date.now() > Number(expStr)) return null;
    return mediaId;
  } catch {
    return null;
  }
}
function mapTrack(v) {
  const mediaId = v.videoId || v.id;
  if (!mediaId) return null;
  const tid = makeTid(mediaId);
  return {
    tid,
    title: String(v.title || "Unknown").slice(0, 200),
    artist: String(v.author?.name || v.author || v.artist || "Unknown").slice(0, 120),
    thumb: `/api/art?t=${encodeURIComponent(tid)}`,
    duration: v.timestamp || v.duration || "",
  };
}

// ---- rate limit ----
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) {
    b = { count: 0, reset: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;
  if (buckets.size > 8000) {
    for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
  }
  return b.count <= max;
}
function clientIp(req) {
  return (
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}
function limitMiddleware(max, windowMs, label) {
  return (req, res, next) => {
    if (!rateLimit(`${label}:${clientIp(req)}`, max, windowMs)) {
      return res.status(429).json({ error: "Too many requests" });
    }
    next();
  };
}

// ---- sessions + HMAC signing ----
const sessions = new Map(); // token -> { signKey, exp, nonces:Set }
const playTickets = new Map(); // ticket -> { mediaId, exp, uses }
const usedNonces = new Map(); // nonce -> exp

function issueSession() {
  const token = crypto.randomBytes(24).toString("base64url");
  const signKey = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, {
    signKey,
    exp: Date.now() + 6 * 60 * 60 * 1000,
    nonces: new Set(),
  });
  if (sessions.size > 12000) {
    const now = Date.now();
    for (const [k, v] of sessions) if (now > v.exp) sessions.delete(k);
  }
  return { token, signKey };
}

function getSession(req) {
  const t = (req.headers["x-aura-token"] || req.query._tok || "").toString();
  if (!t) return null;
  const s = sessions.get(t);
  if (!s || Date.now() > s.exp) {
    sessions.delete(t);
    return null;
  }
  s.exp = Date.now() + 6 * 60 * 60 * 1000;
  return { token: t, ...s };
}

function sanitizeQuery(q, max = 80) {
  return String(q || "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, max);
}

function bodyHash(req) {
  if (!req.body || (typeof req.body === "object" && !Object.keys(req.body).length)) return "";
  const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  return crypto.createHash("sha256").update(raw).digest("base64url");
}

/** HMAC request integrity — rejects standalone curl without valid session sign */
function requireSigned(req, res, next) {
  const sess = getSession(req);
  if (!sess) return res.status(401).json({ error: "Unauthorized" });

  const ts = Number(req.headers["x-aura-ts"] || 0);
  const sign = (req.headers["x-aura-sign"] || "").toString();
  const nonce = (req.headers["x-aura-nonce"] || "").toString();

  if (!ts || !sign || !nonce) {
    return res.status(401).json({ error: "Missing integrity headers" });
  }
  if (Math.abs(Date.now() - ts) > SIGN_WINDOW_MS) {
    return res.status(401).json({ error: "Clock skew / expired request" });
  }
  if (nonce.length < 8 || nonce.length > 64) {
    return res.status(401).json({ error: "Invalid nonce" });
  }
  // replay protection
  const nk = sess.token + ":" + nonce;
  if (usedNonces.has(nk) || sess.nonces.has(nonce)) {
    return res.status(401).json({ error: "Replay denied" });
  }

  const pathOnly = req.originalUrl.split("?")[0];
  const payload = [String(ts), req.method.toUpperCase(), pathOnly, bodyHash(req), nonce].join(".");
  const expected = hmac(sess.signKey, payload);
  const a = Buffer.from(expected);
  const b = Buffer.from(sign);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Bad signature" });
  }

  sess.nonces.add(nonce);
  usedNonces.set(nk, Date.now() + SIGN_WINDOW_MS);
  if (sess.nonces.size > 200) {
    const arr = [...sess.nonces];
    arr.slice(0, 50).forEach((n) => sess.nonces.delete(n));
  }
  if (usedNonces.size > 20000) {
    const now = Date.now();
    for (const [k, exp] of usedNonces) if (now > exp) usedNonces.delete(k);
  }

  req.auraSession = sess;
  next();
}

// lighter auth for media binary (uses play ticket + optional session)
function requirePlayTicket(req, res, next) {
  const ticket = (req.query.pt || req.headers["x-aura-play"] || "").toString();
  const entry = playTickets.get(ticket);
  if (!entry || Date.now() > entry.exp) {
    playTickets.delete(ticket);
    return res.status(401).json({ error: "Play ticket expired" });
  }
  req.mediaId = entry.mediaId;
  entry.uses = (entry.uses || 0) + 1;
  // allow a few reconnects then burn
  if (entry.uses > 8) playTickets.delete(ticket);
  next();
}

// ---- caches ----
const searchCache = new Map();
const suggestCache = new Map();
function getCache(map, key) {
  const item = map.get(key);
  if (!item) return null;
  if (Date.now() > item.exp) {
    map.delete(key);
    return null;
  }
  return item.data;
}
function setCache(map, key, data, ttl = 15 * 60 * 1000) {
  if (map.size >= 300) map.delete(map.keys().next().value);
  map.set(key, { data, exp: Date.now() + ttl });
}

const SEED = [
  { id: "kJQP7kiw5Fk", title: "Despacito", artist: "Luis Fonsi", mood: "Party" },
  { id: "JGwWNGJdvx8", title: "Shape of You", artist: "Ed Sheeran", mood: "Party" },
  { id: "09R8_2nJtjg", title: "Sugar", artist: "Maroon 5", mood: "Party" },
  { id: "fRh_vgS2dFE", title: "Sorry", artist: "Justin Bieber", mood: "Party" },
  { id: "hT_nvWreIhg", title: "Counting Stars", artist: "OneRepublic", mood: "Focus" },
  { id: "YQHsXMglC9A", title: "Hello", artist: "Adele", mood: "Sad" },
  { id: "2Vv-BfVoq4g", title: "Perfect", artist: "Ed Sheeran", mood: "Romantic" },
  { id: "lp-EO5I60KA", title: "Thinking Out Loud", artist: "Ed Sheeran", mood: "Romantic" },
  { id: "RgKAFK5djSk", title: "See You Again", artist: "Wiz Khalifa ft. Charlie Puth", mood: "Sad" },
  { id: "OPf0YbXqDm0", title: "Uptown Funk", artist: "Mark Ronson ft. Bruno Mars", mood: "Party" },
  { id: "CevxZvSJLk8", title: "Roar", artist: "Katy Perry", mood: "Workout" },
  { id: "7wtfhZwyrcc", title: "Believer", artist: "Imagine Dragons", mood: "Workout" },
  { id: "0KSOMA3QBU0", title: "Dark Horse", artist: "Katy Perry", mood: "Party" },
  { id: "pRpeEdMmmQ0", title: "Waka Waka", artist: "Shakira", mood: "Party" },
  { id: "9bZkp7q19f0", title: "Gangnam Style", artist: "PSY", mood: "Party" },
  { id: "hLQl3WQQoQ0", title: "Someone Like You", artist: "Adele", mood: "Sad" },
  { id: "60ItHLz5WEA", title: "Faded", artist: "Alan Walker", mood: "Chill" },
  { id: "3AtDnEC4zak", title: "We Don't Talk Anymore", artist: "Charlie Puth", mood: "Romantic" },
  { id: "pt8VYOfr8FY", title: "Photograph", artist: "Ed Sheeran", mood: "Romantic" },
  { id: "IcrbM1l_BoI", title: "Wake Me Up", artist: "Avicii", mood: "Workout" },
  { id: "nfWlot6h_JM", title: "Shake It Off", artist: "Taylor Swift", mood: "Party" },
  { id: "aJOTlE1K90k", title: "Girls Like You", artist: "Maroon 5", mood: "Party" },
  { id: "L_jWHffIx5E", title: "All Star", artist: "Smash Mouth", mood: "Party" },
];

app.use(cors({ origin: true, exposedHeaders: [] }));
app.use(express.json({ limit: "32kb" }));

// static assets — no source maps served
app.use(
  express.static(path.join(__dirname, "public"), {
    maxAge: "1h",
    index: false,
    setHeaders(res, filePath) {
      if (/\.map$/i.test(filePath)) {
        res.statusCode = 404;
      }
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.removeHeader("X-Powered-By");
    },
  })
);

// block source map requests explicitly
app.get(/\.map$/i, (req, res) => res.status(404).end());

app.get("/health", (req, res) => {
  res.json({ ok: true, t: Date.now() });
});

app.get("/api/session", limitMiddleware(30, 60_000, "session"), (req, res) => {
  const { token, signKey } = issueSession();
  res.json({ token, signKey, exp: Date.now() + 6 * 60 * 60 * 1000 });
});

app.get("/api/feed", requireSigned, limitMiddleware(60, 60_000, "feed"), (req, res) => {
  const mood = sanitizeQuery(req.query.mood, 40);
  let list = SEED;
  if (mood && mood.toLowerCase() !== "more") {
    const filtered = SEED.filter((s) => (s.mood || "").toLowerCase() === mood.toLowerCase());
    if (filtered.length) list = filtered;
  }
  res.json(list.map((s) => mapTrack({ videoId: s.id, title: s.title, author: s.artist })));
});

async function doSearch(query) {
  const result = await Promise.race([
    ytSearch({ query, pages: 1 }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 14000)),
  ]);
  return (result.videos || []).slice(0, 12).map((v) => mapTrack(v)).filter(Boolean);
}

app.get("/api/search", requireSigned, limitMiddleware(40, 60_000, "search"), async (req, res) => {
  const query = sanitizeQuery(req.query.q, 80);
  if (!query) return res.status(400).json({ error: "query required" });
  const key = query.toLowerCase();
  const hit = getCache(searchCache, key);
  if (hit) return res.json(hit);
  try {
    const songs = await doSearch(query);
    setCache(searchCache, key, songs);
    return res.json(songs);
  } catch (e) {
    const ql = query.toLowerCase();
    const local = SEED.filter(
      (s) => s.title.toLowerCase().includes(ql) || s.artist.toLowerCase().includes(ql)
    ).map((s) => mapTrack({ videoId: s.id, title: s.title, author: s.artist }));
    if (local.length) return res.json(local);
    res.status(500).json({ error: "Search failed" });
  }
});

app.get("/api/suggest", requireSigned, limitMiddleware(80, 60_000, "suggest"), async (req, res) => {
  const q = sanitizeQuery(req.query.q, 80);
  if (!q) return res.json([]);
  const key = "sg:" + q.toLowerCase();
  const hit = getCache(suggestCache, key);
  if (hit) return res.json(hit);
  try {
    const r = await fetch(
      "https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=" + encodeURIComponent(q),
      {
        signal: AbortSignal.timeout(4000),
        headers: {
          "User-Agent": "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36",
          Accept: "application/json",
        },
      }
    );
    if (!r.ok) return res.json([]);
    const data = await r.json();
    let list = [];
    if (Array.isArray(data) && Array.isArray(data[1])) {
      list = data[1]
        .map((x) => (typeof x === "string" ? x : x?.[0]))
        .filter((x) => typeof x === "string" && x.trim())
        .slice(0, 10);
    }
    setCache(suggestCache, key, list, 30 * 60 * 1000);
    return res.json(list);
  } catch {
    return res.json([]);
  }
});

app.get("/api/art", requireSigned, limitMiddleware(200, 60_000, "art"), async (req, res) => {
  const mediaId = parseTid(req.query.t);
  if (!mediaId) return res.status(400).end();
  try {
    const r = await fetch(`https://i.ytimg.com/vi/${mediaId}/hqdefault.jpg`, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!r.ok) return res.status(502).end();
    res.setHeader("Content-Type", r.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.status(502).end();
  }
});

/** Issue short-lived play ticket — required before media bytes */
app.post("/api/play-ticket", requireSigned, limitMiddleware(40, 60_000, "ticket"), (req, res) => {
  const mediaId = parseTid(req.body?.t || req.body?.tid);
  if (!mediaId) return res.status(400).json({ error: "Invalid track" });
  const ticket = crypto.randomBytes(24).toString("base64url");
  playTickets.set(ticket, { mediaId, exp: Date.now() + PLAY_TICKET_TTL_MS, uses: 0 });
  if (playTickets.size > 5000) {
    const now = Date.now();
    for (const [k, v] of playTickets) if (now > v.exp) playTickets.delete(k);
  }
  res.json({ pt: ticket, exp: Date.now() + PLAY_TICKET_TTL_MS });
});

function ytdlpArgs(url) {
  return [
    "-f", "bestaudio/best", "-o", "-",
    "--no-playlist", "--no-warnings", "--geo-bypass", "--no-check-certificates",
    "--extractor-args", "youtube:player_client=android,web",
    "--user-agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "--add-header", "Accept-Language:en-US,en;q=0.9",
    url,
  ];
}

/**
 * Chunked media pipe — no permanent URL, requires play ticket.
 * Transfer-Encoding: chunked so clients cannot rely on Content-Length hotlinking.
 * Client should fetch → blob/MSE, not set audio.src to this URL long-term.
 */
app.get(
  "/api/media",
  limitMiddleware(30, 60_000, "media"),
  requirePlayTicket,
  (req, res) => {
    const mediaId = req.mediaId;
    const url = `https://www.youtube.com/watch?v=${mediaId}`;
    const bin = process.env.YTDLP_PATH || "yt-dlp";
    const child = spawn(bin, ytdlpArgs(url), { stdio: ["ignore", "pipe", "pipe"] });
    let started = false;
    let err = "";
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Cache-Control", "no-store, no-transform");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.removeHeader("X-Powered-By");

    child.stderr.on("data", (c) => (err += c.toString()));
    child.stdout.on("data", (chunk) => {
      started = true;
      res.write(chunk);
    });
    child.on("error", () => {
      if (!res.headersSent) res.status(503).json({ error: "Media engine unavailable" });
    });
    child.on("close", () => {
      if (!started && !res.headersSent) {
        res.status(502).json({ error: "Media unavailable" });
      } else {
        res.end();
      }
    });
    req.on("close", () => {
      try {
        child.kill("SIGTERM");
      } catch (_) {}
    });
  }
);

// download still ticket-based
app.get(
  "/api/download",
  limitMiddleware(15, 60_000, "download"),
  requirePlayTicket,
  (req, res) => {
    const mediaId = req.mediaId;
    const title =
      sanitizeQuery(req.query.title, 80).replace(/[^\w\s\u0900-\u097F-]/g, "") || "track";
    const url = `https://www.youtube.com/watch?v=${mediaId}`;
    const bin = process.env.YTDLP_PATH || "yt-dlp";
    const child = spawn(bin, ytdlpArgs(url), { stdio: ["ignore", "pipe", "pipe"] });
    let started = false;
    child.stdout.on("data", (chunk) => {
      if (!started) {
        started = true;
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Content-Disposition", `attachment; filename="${title}.mp3"`);
        res.setHeader("Cache-Control", "no-store");
      }
      res.write(chunk);
    });
    child.on("error", () => {
      if (!res.headersSent) res.status(503).json({ error: "Media engine unavailable" });
    });
    child.on("close", () => {
      if (!started && !res.headersSent) res.status(502).json({ error: "Download failed" });
      else res.end();
    });
    req.on("close", () => {
      try {
        child.kill("SIGTERM");
      } catch (_) {}
    });
  }
);

app.get("/api/lyrics", requireSigned, limitMiddleware(40, 60_000, "lyrics"), async (req, res) => {
  const mediaId = parseTid(req.query.t);
  const title = sanitizeQuery(req.query.title, 120);
  const artist = sanitizeQuery(req.query.artist, 80);
  if (!mediaId && !title) return res.status(400).json({ error: "track required" });
  try {
    const queries = [];
    if (title && artist) {
      queries.push(
        `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`
      );
    }
    if (title) queries.push(`https://lrclib.net/api/search?q=${encodeURIComponent(title)}`);
    for (const u of queries) {
      try {
        const r = await fetch(u, {
          signal: AbortSignal.timeout(7000),
          headers: { Accept: "application/json" },
        });
        if (!r.ok) continue;
        const d = await r.json();
        const item = Array.isArray(d) ? d[0] : d;
        if (item && (item.syncedLyrics || item.plainLyrics)) {
          return res.json({ synced: item.syncedLyrics || null, plain: item.plainLyrics || null });
        }
      } catch (_) {}
    }
  } catch (_) {}
  if (lyricsHandler && mediaId) {
    req.query.id = mediaId;
    return lyricsHandler(req, res);
  }
  res.json({ synced: null, plain: null });
});

app.post("/api/similar", requireSigned, limitMiddleware(20, 60_000, "similar"), async (req, res) => {
  if (!GROQ_API_KEY) return res.status(503).json({ error: "AI not configured" });
  const title = sanitizeQuery(req.body?.title, 120);
  const artist = sanitizeQuery(req.body?.artist, 80);
  if (!title) return res.status(400).json({ error: "title required" });
  try {
    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + GROQ_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "qwen/qwen3.8-27b",
        messages: [
          {
            role: "system",
            content:
              "You are a music recommendation engine. Output ONLY a valid JSON array of 5 objects with title and artist. No markdown.",
          },
          {
            role: "user",
            content: `Recommend 5 similar real songs for "${title}" by ${artist || "Unknown"}. JSON only: [{"title":"...","artist":"..."}]`,
          },
        ],
        temperature: 0.3,
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return res.status(502).json({ error: "AI unavailable" });
    const data = await response.json();
    let text = (data.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
    let list = [];
    try {
      const match = text.match(/\[[\s\S]*\]/);
      list = JSON.parse(match ? match[0] : text);
    } catch {
      list = [];
    }
    return res.json(Array.isArray(list) ? list.filter((x) => x && x.title).slice(0, 5) : []);
  } catch {
    return res.status(502).json({ error: "AI failed" });
  }
});

// generic error — no stack traces
app.use((err, req, res, next) => {
  res.status(500).json({ error: "Internal error" });
});

app.get("/", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Aura hardened server on", PORT);
});
