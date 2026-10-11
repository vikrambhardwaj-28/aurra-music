require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const https = require("https");
const { spawn } = require("child_process");
const ytSearch = require("yt-search");

const app = express();
const PORT = process.env.PORT || 3000;

// Groq key ONLY on server (never sent to browser)
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// Optional: YouTube captions fallback (npm i youtube-transcript)
let lyricsHandler = null;
try {
  lyricsHandler = require("./lyricsHandler");
  console.log("Lyrics handler loaded (YouTube captions OK)");
} catch (e) {
  console.warn(
    "lyricsHandler missing or broken — /lyrics disabled.",
    e.message
  );
}

// --------------------------------------------------
// CACHE (search 15 min + stream URL 20 min)
// --------------------------------------------------
const searchCache = new Map();
const streamUrlCache = new Map();
const CACHE_TTL = 15 * 60 * 1000;
const STREAM_URL_TTL = 20 * 60 * 1000;
const CACHE_MAX = 300;

function getCache(key) {
  const item = searchCache.get(key);
  if (!item) return null;
  if (Date.now() > item.exp) {
    searchCache.delete(key);
    return null;
  }
  return item.data;
}

function setCache(key, data) {
  if (searchCache.size >= CACHE_MAX) {
    searchCache.delete(searchCache.keys().next().value);
  }
  searchCache.set(key, { data, exp: Date.now() + CACHE_TTL });
}

function getStreamUrlCache(id) {
  const item = streamUrlCache.get(id);
  if (!item) return null;
  if (Date.now() > item.exp) {
    streamUrlCache.delete(id);
    return null;
  }
  return item.url;
}

function setStreamUrlCache(id, url) {
  if (streamUrlCache.size >= CACHE_MAX) {
    streamUrlCache.delete(streamUrlCache.keys().next().value);
  }
  streamUrlCache.set(id, { url, exp: Date.now() + STREAM_URL_TTL });
}

function isValidVideoId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{6,20}$/.test(id);
}

function ytdlpBin() {
  return process.env.YTDLP_PATH || "yt-dlp";
}

/** Resolve a direct CDN audio URL via yt-dlp -g (best for mobile background). */
function resolveDirectAudioUrl(videoId) {
  return new Promise((resolve) => {
    const cached = getStreamUrlCache(videoId);
    if (cached) return resolve(cached);

    const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const args = [
      "-g",
      "-f",
      "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best",
      "--no-playlist",
      "--no-warnings",
      "--geo-bypass",
      pageUrl,
    ];
    const child = spawn(ytdlpBin(), args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch (_) {}
      resolve(null);
    }, 18000);

    child.stdout.on("data", (c) => (out += c.toString()));
    child.stderr.on("data", (c) => (err += c.toString()));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const lines = out
        .trim()
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.startsWith("http"));
      const direct = lines[0] || null;
      if (direct) {
        setStreamUrlCache(videoId, direct);
        resolve(direct);
      } else {
        if (err) console.warn("yt-dlp -g:", err.slice(0, 240));
        resolve(null);
      }
    });
  });
}

/**
 * Proxy a direct CDN audio URL through our server (same-origin).
 * Critical for mobile background: <audio src="/stream?..."> must stay same-origin.
 * Forwards Range so seeking works on phones.
 */
function proxyDirectUrl(directUrl, req, res, { asAttachment = false, title = "aura-song" } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    let parsed;
    try {
      parsed = new URL(directUrl);
    } catch (e) {
      return done(false);
    }

    const lib = parsed.protocol === "http:" ? http : https;
    const headers = {
      "User-Agent":
        req.headers["user-agent"] ||
        "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36",
      Accept: "*/*",
    };
    if (req.headers.range) headers.Range = req.headers.range;

    const upstream = lib.get(
      directUrl,
      { headers, timeout: 30000 },
      (up) => {
        // Follow one redirect if CDN sends it
        if (
          up.statusCode >= 300 &&
          up.statusCode < 400 &&
          up.headers.location
        ) {
          up.resume();
          proxyDirectUrl(up.headers.location, req, res, {
            asAttachment,
            title,
          }).then(done);
          return;
        }

        if (up.statusCode !== 200 && up.statusCode !== 206) {
          up.resume();
          done(false);
          return;
        }

        const ct =
          up.headers["content-type"] ||
          (directUrl.includes(".m4a") || directUrl.includes("mp4")
            ? "audio/mp4"
            : directUrl.includes("webm")
              ? "audio/webm"
              : "audio/mp4");

        res.statusCode = up.statusCode;
        res.setHeader("Content-Type", ct);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Access-Control-Allow-Origin", "*");
        if (up.headers["content-length"]) {
          res.setHeader("Content-Length", up.headers["content-length"]);
        }
        if (up.headers["content-range"]) {
          res.setHeader("Content-Range", up.headers["content-range"]);
        }
        if (up.headers["accept-ranges"]) {
          res.setHeader("Accept-Ranges", up.headers["accept-ranges"]);
        } else {
          res.setHeader("Accept-Ranges", "bytes");
        }
        if (asAttachment) {
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="${title}.m4a"`
          );
        } else {
          res.setHeader("Content-Disposition", "inline");
        }

        up.pipe(res);
        up.on("error", () => {
          try {
            res.end();
          } catch (_) {}
          done(true);
        });
        res.on("close", () => {
          try {
            up.destroy();
          } catch (_) {}
        });
        done(true);
      }
    );

    upstream.on("error", () => done(false));
    upstream.setTimeout(30000, () => {
      try {
        upstream.destroy();
      } catch (_) {}
      done(false);
    });
    req.on("close", () => {
      try {
        upstream.destroy();
      } catch (_) {}
    });
  });
}

/** Pipe audio through yt-dlp stdout (fallback when direct URL fails). */
function pipeAudio(videoId, res, { asAttachment = false, title = "aura-song" } = {}) {
  const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const args = [
    "-f",
    "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best",
    "-o",
    "-",
    "--no-playlist",
    "--no-warnings",
    "--geo-bypass",
    pageUrl,
  ];
  const child = spawn(ytdlpBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
  let started = false;
  let err = "";

  child.stderr.on("data", (c) => (err += c.toString()));
  child.stdout.on("data", (chunk) => {
    if (!started) {
      started = true;
      // m4a/mp4 is most reliable on iOS + Android for background audio
      res.setHeader("Content-Type", "audio/mp4");
      res.setHeader("Accept-Ranges", "none");
      res.setHeader("Cache-Control", "no-store");
      if (asAttachment) {
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${title}.m4a"`
        );
      } else {
        res.setHeader("Content-Disposition", "inline");
      }
    }
    res.write(chunk);
  });
  child.on("error", (e) => {
    console.error("yt-dlp spawn error:", e.message);
    if (!res.headersSent) {
      res.status(503).json({
        error: "yt-dlp missing on server. Check Render build command.",
      });
    }
  });
  child.on("close", (code) => {
    if (!started) {
      console.error("yt-dlp exit", code, err.slice(0, 400));
      if (!res.headersSent) {
        res.status(502).json({
          error: asAttachment
            ? "Download blocked on this server (YouTube 403). Works on localhost only."
            : "Stream failed",
          detail: err.slice(0, 200),
        });
      }
    } else {
      res.end();
    }
  });

  const kill = () => {
    try {
      child.kill("SIGTERM");
    } catch (_) {}
  };
  res.on("close", kill);
  res.req && res.req.on("close", kill);
}

// --------------------------------------------------
// Middleware
// --------------------------------------------------
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

// Keep-alive (Render sleep kam kare)
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    cache: searchCache.size,
    streamCache: streamUrlCache.size,
    lyrics: !!lyricsHandler,
    t: Date.now(),
  });
});

// --------------------------------------------------
// LYRICS (YouTube captions fallback)
// --------------------------------------------------
if (lyricsHandler) {
  app.get("/lyrics", lyricsHandler);
  app.get("/api/lyrics", lyricsHandler);
}

// --------------------------------------------------
// FAST SEARCH (retry + cache)
// --------------------------------------------------
async function doSearch(query) {
  const result = await Promise.race([
    ytSearch({ query, pages: 1 }),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("timeout")), 12000)
    ),
  ]);
  const limit = Math.min(24, Math.max(1, parseInt(String(query && ""), 10) || 12));
  // limit comes from route, default 12
  return (result.videos || []).slice(0, 12).map((v) => ({
    id: v.videoId,
    title: v.title,
    author: v.author?.name || "Unknown",
    thumbnail:
      v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
    timestamp: v.timestamp || "",
  }));
}

app.get("/search", async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (!query) return res.status(400).json({ error: "query required" });

  const limitRaw = parseInt(String(req.query.limit || "12"), 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(24, Math.max(1, limitRaw))
    : 12;

  const key = query.toLowerCase() + "::" + limit;
  const hit = getCache(key);
  if (hit) {
    res.setHeader("X-Cache", "HIT");
    return res.json(hit);
  }

  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      console.log(`Search try ${i + 1}:`, query);
      const result = await Promise.race([
        ytSearch({ query, pages: 1 }),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("timeout")), 12000)
        ),
      ]);
      const songs = (result.videos || []).slice(0, limit).map((v) => ({
        id: v.videoId,
        title: v.title,
        author: v.author?.name || "Unknown",
        thumbnail:
          v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
        timestamp: v.timestamp || "",
      }));
      setCache(key, songs);
      res.setHeader("X-Cache", "MISS");
      return res.json(songs);
    } catch (e) {
      lastErr = e;
      console.error("Search fail:", e.message);
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  res.status(500).json({ error: "Search failed", detail: lastErr?.message });
});

// --------------------------------------------------
// AI SIMILAR SONGS (Groq key stays on server only)
// --------------------------------------------------
app.post("/api/similar", async (req, res) => {
  if (!GROQ_API_KEY) {
    return res.status(503).json({ error: "AI not configured" });
  }
  const title = String(req.body?.title || "").trim().slice(0, 120);
  const artist = String(req.body?.artist || "").trim().slice(0, 80);
  if (!title) return res.status(400).json({ error: "title required" });
  const cleanArtist = artist
    .replace(/\s*-\s*Topic$/i, "")
    .replace(/\s*VEVO$/i, "")
    .trim();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
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
              "You are a world-class music recommendation engine used by Spotify and Apple Music style apps. You deeply know Bollywood, Hollywood, Punjabi, Tamil, Telugu, Korean, Spanish and global hits. When given a song, you mentally play it in your head — hear the melody, bass, emotion, language and energy — then pick 5 DIFFERENT real songs that a listener would love next. Output ONLY a valid JSON array. No markdown, no explanation, no reasoning, no extra text.",
          },
          {
            role: "user",
            content: `Recommend 5 similar songs for:
Title: ${title}
Artist: ${cleanArtist || "Unknown"}
Think step by step silently:
- Detect language (Hindi / English / Punjabi / Haryanvi / Spanish / etc.)
- Detect mood (romantic, sad, party, workout, chill, emotional, motivational)
- Detect energy (slow, mid, high BPM feel)
- Detect era / style (classic, modern, EDM, acoustic, filmi, indie)
Then return 5 real popular songs that match ALL of: same language + same mood + same energy + same style.
HARD RULES:
1. Same language as input song (mandatory)
2. Same mood and emotional feeling (mandatory)
3. Similar energy / tempo feel
4. NEVER the same song title, never a remix of the same song
5. Prefer different artists
6. Only real famous songs people actually search and play (no fake names)
7. Titles must be clean real song names (not YouTube junk)
8. Exactly 5 items
JSON only:
[{"title":"Exact Song Name","artist":"Artist Name"},{"title":"Exact Song Name","artist":"Artist Name"},{"title":"Exact Song Name","artist":"Artist Name"},{"title":"Exact Song Name","artist":"Artist Name"},{"title":"Exact Song Name","artist":"Artist Name"}]`,
          },
        ],
        temperature: 0.3,
        max_tokens: 500,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.warn("Groq HTTP", response.status, errText.slice(0, 200));
      return res.status(502).json({ error: "AI unavailable" });
    }
    const data = await response.json();
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    let text = (msg && msg.content) || "";
    if (!text.trim() && msg && msg.reasoning) {
      text = msg.reasoning;
    }
    text = text.replace(/```json|```/g, "").trim();
    let list = [];
    try {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) list = JSON.parse(match[0]);
      else list = JSON.parse(text);
    } catch (parseErr) {
      const objs = [
        ...text.matchAll(/\{[^{}]*"title"\s*:\s*"[^"]+"[^{}]*\}/g),
      ];
      list = objs
        .map((m) => {
          try {
            return JSON.parse(m[0]);
          } catch (e) {
            return null;
          }
        })
        .filter(Boolean);
    }
    const result = Array.isArray(list)
      ? list.filter((x) => x && x.title).slice(0, 5)
      : [];
    return res.json(result);
  } catch (e) {
    console.warn("Similar songs error:", e.message);
    return res.status(502).json({ error: "AI failed" });
  }
});

// --------------------------------------------------
// DOWNLOAD (yt-dlp) — attachment for save
// --------------------------------------------------
app.get("/download", handleDownload);
app.get("/api/download", handleDownload);

function handleDownload(req, res) {
  const id = String(req.query.id || "").trim();
  let title =
    String(req.query.title || "aura-song")
      .replace(/[^\w\s\u0900-\u097F-]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "aura-song";
  if (!isValidVideoId(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }
  console.log("Download:", id, title);
  // Prefer direct URL then client can save; if not, pipe as attachment
  resolveDirectAudioUrl(id).then((direct) => {
    if (direct) {
      // Pipe via redirect still works for download in many browsers;
      // use pipe with attachment for consistent filename.
      return pipeAudio(id, res, { asAttachment: true, title });
    }
    pipeAudio(id, res, { asAttachment: true, title });
  });
}

// --------------------------------------------------
// STREAM — mobile background play
// 1) Redirect to direct CDN audio URL (best for phone background)
// 2) Fallback: pipe through server
// --------------------------------------------------
app.get("/stream", handleStream);
app.get("/api/stream", handleStream);

async function handleStream(req, res) {
  const id = String(req.query.id || "").trim();
  if (!isValidVideoId(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }
  console.log("Stream:", id);

  // Fast path: cached direct URL → proxy immediately
  const cached = getStreamUrlCache(id);
  if (cached) {
    const ok = await proxyDirectUrl(cached, req, res, { asAttachment: false });
    if (ok) return;
  }

  // Resolve direct URL with short timeout; if slow, pipe yt-dlp without waiting
  let direct = null;
  try {
    direct = await Promise.race([
      resolveDirectAudioUrl(id),
      new Promise((r) => setTimeout(() => r(null), 4500)),
    ]);
  } catch (e) {
    console.warn("resolveDirectAudioUrl:", e.message);
  }

  if (direct) {
    const ok = await proxyDirectUrl(direct, req, res, { asAttachment: false });
    if (ok) return;
    console.warn("proxyDirectUrl failed, falling back to yt-dlp pipe");
  }

  // Fallback: server-side yt-dlp pipe (starts sending bytes ASAP)
  if (!res.headersSent) {
    pipeAudio(id, res, { asAttachment: false });
  }
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Aura Music on", PORT);
  console.log(
    "Routes: /search /stream /download /lyrics /api/similar /health"
  );
});
