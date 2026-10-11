const express = require("express");
const cors = require("cors");
const path = require("path");
const { spawn } = require("child_process");
const ytSearch = require("yt-search");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3000;

// Groq API Key — ONLY on server (set via environment variable)
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// Optional: YouTube captions fallback
let lyricsHandler = null;
try {
  lyricsHandler = require("./lyricsHandler");
  console.log("Lyrics handler loaded");
} catch (e) {
  console.warn("lyricsHandler missing — /lyrics disabled.", e.message);
}

// --------------------------------------------------
// CACHE
// --------------------------------------------------
const searchCache = new Map();
const CACHE_TTL = 15 * 60 * 1000;
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

// --------------------------------------------------
// Middleware
// --------------------------------------------------
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

// Health
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    cache: searchCache.size,
    lyrics: !!lyricsHandler,
    ai: !!GROQ_API_KEY,
    t: Date.now(),
  });
});

// --------------------------------------------------
// LYRICS
// --------------------------------------------------
if (lyricsHandler) {
  app.get("/lyrics", lyricsHandler);
  app.get("/api/lyrics", lyricsHandler);
}

// --------------------------------------------------
// SEARCH  (response never mentions YouTube)
// --------------------------------------------------
async function doSearch(query) {
  const result = await Promise.race([
    ytSearch({ query, pages: 1 }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 14000)),
  ]);
  return (result.videos || []).slice(0, 12).map((v) => ({
    id: v.videoId,
    title: v.title,
    artist: v.author?.name || "Unknown",
    thumb: `/thumb/${v.videoId}`,
  }));
}

app.get("/search", async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (!query) return res.status(400).json({ error: "query required" });

  const key = query.toLowerCase();
  const hit = getCache(key);
  if (hit) {
    res.setHeader("X-Cache", "HIT");
    return res.json(hit);
  }

  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const songs = await doSearch(query);
      setCache(key, songs);
      res.setHeader("X-Cache", "MISS");
      return res.json(songs);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  res.status(500).json({ error: "Search failed" });
});

// --------------------------------------------------
// THUMBNAIL PROXY  (client never sees ytimg.com)
// --------------------------------------------------
app.get("/thumb/:id", (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id || !/^[a-zA-Z0-9_-]{6,20}$/.test(id)) {
    return res.status(400).end();
  }
  const url = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  https
    .get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (upstream) => {
      if (upstream.statusCode !== 200) {
        res.status(404).end();
        return;
      }
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=86400");
      upstream.pipe(res);
    })
    .on("error", () => res.status(404).end());
});

// --------------------------------------------------
// AI SIMILAR SONGS (Groq) — key stays on server only
// --------------------------------------------------
app.post("/api/similar", async (req, res) => {
  if (!GROQ_API_KEY) {
    return res.status(503).json({ error: "AI not configured" });
  }

  const title = String(req.body?.title || "").trim().slice(0, 120);
  const artist = String(req.body?.artist || "").trim().slice(0, 80);
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
              "You are a world-class music recommendation engine. Output ONLY a valid JSON array of 5 similar real songs. No markdown, no explanation.",
          },
          {
            role: "user",
            content: `Recommend 5 similar songs for:
Title: ${title}
Artist: ${artist || "Unknown"}

Same language, same mood, same energy. Different artists. Real famous songs only.
JSON only:
[{"title":"Exact Song Name","artist":"Artist Name"},{"title":"Exact Song Name","artist":"Artist Name"},{"title":"Exact Song Name","artist":"Artist Name"},{"title":"Exact Song Name","artist":"Artist Name"},{"title":"Exact Song Name","artist":"Artist Name"}]`,
          },
        ],
        temperature: 0.3,
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(18000),
    });

    if (!response.ok) {
      return res.status(502).json({ error: "AI error" });
    }

    const data = await response.json();
    const msg = data.choices?.[0]?.message;
    let text = (msg?.content || msg?.reasoning || "").replace(/```json|```/g, "").trim();

    let list = [];
    try {
      const match = text.match(/\[[\s\S]*\]/);
      list = match ? JSON.parse(match[0]) : JSON.parse(text);
    } catch {
      const objs = [...text.matchAll(/\{[^{}]*"title"\s*:\s*"[^"]+"[^{}]*\}/g)];
      list = objs
        .map((m) => {
          try {
            return JSON.parse(m[0]);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    }

    res.json(Array.isArray(list) ? list.filter((x) => x?.title).slice(0, 5) : []);
  } catch (e) {
    res.status(500).json({ error: "AI failed" });
  }
});

// --------------------------------------------------
// STREAM (HTML5 Audio plays from this endpoint)
// --------------------------------------------------
app.get("/stream", handleStream);
app.get("/api/stream", handleStream);

function handleStream(req, res) {
  const id = String(req.query.id || "").trim();
  if (!id || !/^[a-zA-Z0-9_-]{6,20}$/.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const url = `https://www.youtube.com/watch?v=${id}`;
  const bin = process.env.YTDLP_PATH || "yt-dlp";
  const args = [
    "-f", "ba/bestaudio/best",
    "-o", "-",
    "--no-playlist",
    "--no-warnings",
    "--geo-bypass",
    url,
  ];

  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  let started = false;

  child.stdout.on("data", (chunk) => {
    if (!started) {
      started = true;
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Accept-Ranges", "bytes");
    }
    res.write(chunk);
  });

  child.on("error", () => {
    if (!res.headersSent) res.status(503).json({ error: "Stream unavailable" });
  });

  child.on("close", () => {
    if (!started) {
      if (!res.headersSent) res.status(502).json({ error: "Stream failed" });
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

// --------------------------------------------------
// DOWNLOAD (optional)
// --------------------------------------------------
app.get("/download", handleDownload);
app.get("/api/download", handleDownload);

function handleDownload(req, res) {
  const id = String(req.query.id || "").trim();
  let title =
    String(req.query.title || "track")
      .replace(/[^\w\s\u0900-\u097F-]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "track";

  if (!id || !/^[a-zA-Z0-9_-]{6,20}$/.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const url = `https://www.youtube.com/watch?v=${id}`;
  const bin = process.env.YTDLP_PATH || "yt-dlp";
  const args = [
    "-f", "ba/bestaudio/best",
    "-o", "-",
    "--no-playlist",
    "--no-warnings",
    "--geo-bypass",
    url,
  ];

  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  let started = false;

  child.stdout.on("data", (chunk) => {
    if (!started) {
      started = true;
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${title}.mp3"`
      );
      res.setHeader("Cache-Control", "no-store");
    }
    res.write(chunk);
  });

  child.on("error", () => {
    if (!res.headersSent) res.status(503).json({ error: "Download unavailable" });
  });

  child.on("close", () => {
    if (!started && !res.headersSent) {
      res.status(502).json({ error: "Download failed" });
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

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Aura Music on", PORT);
  if (!GROQ_API_KEY) console.warn("GROQ_API_KEY not set — AI disabled");
});
