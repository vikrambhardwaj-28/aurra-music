require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
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
    "lyricsHandler missing or broken  /lyrics disabled.",
    e.message
  );
}

// --------------------------------------------------
// CACHE (search 15 min)
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

// Keep-alive (Render sleep kam kare)
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    cache: searchCache.size,
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
      setTimeout(() => rej(new Error("timeout")), 14000)
    ),
  ]);
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
  const key = query.toLowerCase();
  const hit = getCache(key);
  if (hit) {
    res.setHeader("X-Cache", "HIT");
    return res.json(hit);
  }
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      console.log(`Search try ${i + 1}:`, query);
      const songs = await doSearch(query);
      setCache(key, songs);
      res.setHeader("X-Cache", "MISS");
      return res.json(songs);
    } catch (e) {
      lastErr = e;
      console.error("Search fail:", e.message);
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
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
              "You are a world-class music recommendation engine used by Spotify and Apple Music style apps. You deeply know Bollywood, Hollywood, Punjabi, Tamil, Telugu, Korean, Spanish and global hits. When given a song, you mentally play it in your head  hear the melody, bass, emotion, language and energy  then pick 5 DIFFERENT real songs that a listener would love next. Output ONLY a valid JSON array. No markdown, no explanation, no reasoning, no extra text.",
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
// High-quality audio format selector for yt-dlp
// Prefers m4a / high-bitrate audio for crystal-clear sound
// --------------------------------------------------
const HIGH_QUALITY_FORMAT =
  "bestaudio[abr>=160][ext=m4a]/bestaudio[abr>=128][ext=m4a]/bestaudio[ext=m4a]/bestaudio[abr>=160]/bestaudio/best";

// --------------------------------------------------
// DOWNLOAD (yt-dlp)  high quality
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
  if (!id || !/^[a-zA-Z0-9_-]{6,20}$/.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }
  const url = `https://www.youtube.com/watch?v=${id}`;
  console.log("Download (HQ):", id, title);
  const bin = process.env.YTDLP_PATH || "yt-dlp";
  const args = [
    "-f",
    HIGH_QUALITY_FORMAT,
    "-o",
    "-",
    "--no-playlist",
    "--no-warnings",
    "--geo-bypass",
    "--audio-quality",
    "0",
    "--prefer-free-formats",
    url,
  ];
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  let started = false;
  let err = "";
  child.stderr.on("data", (c) => (err += c.toString()));
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
  child.on("error", (e) => {
    console.error("spawn error:", e.message);
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
          error:
            "Download blocked on this server (YouTube 403). Works on localhost only.",
          detail: err.slice(0, 200),
        });
      }
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
// STREAM (background play on phone)  high quality
// --------------------------------------------------
app.get("/stream", handleStream);
app.get("/api/stream", handleStream);

function handleStream(req, res) {
  const id = String(req.query.id || "").trim();
  if (!id || !/^[a-zA-Z0-9_-]{6,20}$/.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }
  const url = `https://www.youtube.com/watch?v=${id}`;
  console.log("Stream (HQ):", id);
  const bin = process.env.YTDLP_PATH || "yt-dlp";
  const args = [
    "-f",
    HIGH_QUALITY_FORMAT,
    "-o",
    "-",
    "--no-playlist",
    "--no-warnings",
    "--geo-bypass",
    "--audio-quality",
    "0",
    "--prefer-free-formats",
    url,
  ];
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  let started = false;
  let err = "";
  child.stderr.on("data", (c) => (err += c.toString()));
  child.stdout.on("data", (chunk) => {
    if (!started) {
      started = true;
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("Cache-Control", "no-store");
    }
    res.write(chunk);
  });
  child.on("error", (e) => {
    console.error("stream spawn error:", e.message);
    if (!res.headersSent) {
      res.status(503).json({ error: "yt-dlp missing on server." });
    }
  });
  child.on("close", (code) => {
    if (!started) {
      console.error("stream exit", code, err.slice(0, 400));
      if (!res.headersSent) {
        res.status(502).json({
          error: "Stream failed",
          detail: err.slice(0, 200),
        });
      }
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
  console.log("Routes: /search /stream /download /lyrics /api/similar /health");
  console.log("Audio format: high-quality bestaudio (m4a preferred, abr>=160)");
});
