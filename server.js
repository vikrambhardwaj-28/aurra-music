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
    "lyricsHandler missing or broken — /lyrics disabled.",
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

// Prefer high quality audio; fallback chain for yt-dlp
const HIGH_AUDIO_FORMAT =
  "bestaudio[abr>=160]/bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best";

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
    ytdlp: process.env.YTDLP_PATH || "yt-dlp",
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
// DOWNLOAD / STREAM helpers (yt-dlp)
// --------------------------------------------------
function safeTitle(raw) {
  return (
    String(raw || "aura-song")
      .replace(/[^\w\s\u0900-\u097F\-]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "aura-song"
  );
}

function runYtDlpAudio(videoId, res, { inline = false, title = "aura-song" } = {}) {
  const id = String(videoId || "").trim();
  if (!id || !/^[a-zA-Z0-9_-]{6,20}$/.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const url = `https://www.youtube.com/watch?v=${id}`;
  const bin = process.env.YTDLP_PATH || "yt-dlp";
  const safe = safeTitle(title);

  console.log(inline ? "Stream:" : "Download:", id, safe);

  // Stream best audio to stdout. (MP3 convert needs ffmpeg; without it we send original audio)
  const args = [
    "-f",
    HIGH_AUDIO_FORMAT,
    "-o",
    "-",
    "--no-playlist",
    "--no-warnings",
    "--geo-bypass",
    "--newline",
    url,
  ];

  // If ffmpeg exists, try real mp3 extract (optional — set FORCE_MP3=1)
  if (process.env.FORCE_MP3 === "1") {
    args.splice(0, 2, "-f", "bestaudio/best", "-x", "--audio-format", "mp3", "--audio-quality", "0");
  }

  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  let started = false;
  let err = "";

  child.stderr.on("data", (c) => {
    err += c.toString();
  });

  child.stdout.on("data", (chunk) => {
    if (!started) {
      started = true;
      // Without ffmpeg convert, container may be webm/m4a — still playable/downloadable
      const ctype =
        process.env.FORCE_MP3 === "1" ? "audio/mpeg" : "application/octet-stream";
      const ext = process.env.FORCE_MP3 === "1" ? "mp3" : "m4a";
      res.setHeader("Content-Type", ctype);
      res.setHeader(
        "Content-Disposition",
        `${inline ? "inline" : "attachment"}; filename="${safe}.${ext}"`
      );
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    }
    res.write(chunk);
  });

  child.on("error", (e) => {
    console.error("yt-dlp spawn error:", e.message);
    if (!res.headersSent) {
      res.status(503).json({
        error: "yt-dlp missing on server",
        detail: e.message,
        hint: "Install yt-dlp in build (see README) or set YTDLP_PATH",
      });
    }
  });

  child.on("close", (code) => {
    if (!started) {
      console.error("yt-dlp exit", code, err.slice(0, 500));
      if (!res.headersSent) {
        const blocked =
          /403|429|Sign in|bot|confirm.*not a bot/i.test(err) || code === 1;
        res.status(502).json({
          error: blocked
            ? "YouTube blocked this server IP (common on free Render). Try localhost or a VPS."
            : "Download failed",
          detail: err.slice(0, 240),
          code,
        });
      }
    } else {
      res.end();
    }
  });

  reqOnClose(res, child);
}

function reqOnClose(res, child) {
  // Express: use res.req
  const req = res.req;
  if (!req) return;
  req.on("close", () => {
    try {
      child.kill("SIGTERM");
    } catch (_) {}
  });
}

// --------------------------------------------------
// DOWNLOAD
// --------------------------------------------------
app.get("/download", (req, res) => {
  runYtDlpAudio(req.query.id, res, {
    inline: false,
    title: req.query.title,
  });
});
app.get("/api/download", (req, res) => {
  runYtDlpAudio(req.query.id, res, {
    inline: false,
    title: req.query.title,
  });
});

// --------------------------------------------------
// STREAM (background play on phone)
// --------------------------------------------------
app.get("/stream", (req, res) => {
  runYtDlpAudio(req.query.id, res, { inline: true, title: req.query.title });
});
app.get("/api/stream", (req, res) => {
  runYtDlpAudio(req.query.id, res, { inline: true, title: req.query.title });
});

// --------------------------------------------------
// Static index
// --------------------------------------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Aura Music on", PORT);
  console.log("Routes: /search /stream /download /lyrics /api/similar /health");
  console.log("yt-dlp bin:", process.env.YTDLP_PATH || "yt-dlp");
});
