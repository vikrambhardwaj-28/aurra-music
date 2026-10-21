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

// Limit concurrent yt-dlp jobs so free Render doesn't OOM / crash
const MAX_CONCURRENT_DOWNLOADS = Math.max(
  1,
  parseInt(process.env.MAX_DOWNLOADS || "2", 10) || 2
);
let activeDownloads = 0;
const downloadQueue = [];

function runQueued(fn) {
  return new Promise((resolve, reject) => {
    const job = () => {
      activeDownloads++;
      Promise.resolve()
        .then(fn)
        .then((v) => {
          activeDownloads--;
          pumpQueue();
          resolve(v);
        })
        .catch((e) => {
          activeDownloads--;
          pumpQueue();
          reject(e);
        });
    };
    downloadQueue.push(job);
    pumpQueue();
  });
}

function pumpQueue() {
  while (activeDownloads < MAX_CONCURRENT_DOWNLOADS && downloadQueue.length) {
    const next = downloadQueue.shift();
    if (next) next();
  }
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
    ytdlp: process.env.YTDLP_PATH || "yt-dlp",
    downloads: { active: activeDownloads, queued: downloadQueue.length, max: MAX_CONCURRENT_DOWNLOADS },
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

function getCookiesPath() {
  const fs = require("fs");
  const pathMod = require("path");
  const cookies =
    process.env.COOKIES_FILE ||
    process.env.YTDLP_COOKIES ||
    (fs.existsSync(pathMod.join(__dirname, "cookies.txt"))
      ? pathMod.join(__dirname, "cookies.txt")
      : "");
  return cookies && fs.existsSync(cookies) ? cookies : "";
}

/** Stream route: prefer m4a/AAC so iOS + Android HTML5 audio can play (background OK). */
function buildStreamArgs(url, client) {
  const args = [
    "-f",
    // m4a first (Safari/iOS + Chrome), then webm/opus, then any audio
    "bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio[ext=webm]/bestaudio/best",
    "-o",
    "-",
    "--no-playlist",
    "--no-warnings",
    "--geo-bypass",
    "--no-check-certificates",
    "--retries",
    "3",
    "--fragment-retries",
    "3",
    "--extractor-args",
    `youtube:player_client=${client}`,
  ];
  const cookies = getCookiesPath();
  if (cookies) args.push("--cookies", cookies);
  args.push(url);
  return args;
}

/**
 * Download route: write REAL mp3 to temp file then stream.
 * Note: yt-dlp cannot convert to mp3 when using -o - (stdout).
 * Must use a real file path + -x --audio-format mp3 (needs ffmpeg).
 */
function buildMp3FileArgs(url, client, outTemplate) {
  const args = [
    "-f",
    "bestaudio/best",
    "-x",
    "--audio-format",
    "mp3",
    "--audio-quality",
    "0",
    "-o",
    outTemplate,
    "--no-playlist",
    "--no-warnings",
    "--geo-bypass",
    "--no-check-certificates",
    "--retries",
    "3",
    "--fragment-retries",
    "3",
    "--extractor-args",
    `youtube:player_client=${client}`,
  ];
  const cookies = getCookiesPath();
  if (cookies) args.push("--cookies", cookies);
  args.push(url);
  return args;
}

function runYtDlpAudio(videoId, res, { inline = false, title = "aura-song" } = {}) {
  const fs = require("fs");
  const os = require("os");
  const pathMod = require("path");

  const id = String(videoId || "").trim();
  if (!id || !/^[a-zA-Z0-9_-]{6,20}$/.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS && downloadQueue.length >= 8) {
    return res.status(429).json({
      error: "Too many downloads — try again in a few seconds",
      active: activeDownloads,
      queued: downloadQueue.length,
    });
  }

  const url = `https://www.youtube.com/watch?v=${id}`;
  const bin = process.env.YTDLP_PATH || "yt-dlp";
  const safe = safeTitle(title);
  const asMp3 = !inline;
  const clients = String(process.env.YT_CLIENTS || "android,ios,tv_embedded,web")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  console.log(
    inline ? "Stream:" : "Download(MP3-file):",
    id,
    safe,
    "clients=",
    clients.join("|")
  );

  let attempt = 0;
  let started = false;
  let lastErr = "";
  let child = null;
  let finished = false;
  let tempMp3 = null;

  const cleanupChild = () => {
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch (_) {}
      child = null;
    }
  };

  const cleanupTemp = () => {
    if (tempMp3) {
      try {
        fs.unlinkSync(tempMp3);
      } catch (_) {}
      tempMp3 = null;
    }
  };

  const fail = (code) => {
    cleanupTemp();
    if (res.headersSent || finished) return;
    finished = true;
    const bot = /Sign in to confirm|not a bot|cookies/i.test(lastErr);
    const noFfmpeg = /ffmpeg is not installed|ffprobe|Postprocessing|ERROR:.*ffmpeg/i.test(
      lastErr
    );
    const blocked = bot || /403|429|Forbidden|not available/i.test(lastErr);
    res.status(502).json({
      error: noFfmpeg
        ? "ffmpeg missing — MP3 convert needs ffmpeg on server"
        : bot
          ? "YouTube bot-check: need cookies.txt on server"
          : blocked
            ? "YouTube blocked this server IP."
            : "Download failed (502)",
      detail: (lastErr || "no output from yt-dlp").slice(0, 280),
      code: code ?? null,
      hint: noFfmpeg
        ? "Build: apt-get install -y ffmpeg && pip install -U yt-dlp"
        : bot
          ? "Export YouTube cookies → cookies.txt → COOKIES_FILE env"
          : "pip install -U yt-dlp | try localhost",
    });
  };

  // ---- STREAM (inline): pipe raw audio ----
  const tryStreamNext = () => {
    if (started || res.headersSent || finished) return;
    if (attempt >= clients.length) {
      fail(1);
      return;
    }
    const client = clients[attempt++];
    cleanupChild();
    lastErr = "";
    const args = buildStreamArgs(url, client);
    console.log("yt-dlp stream try", client);

    child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stderr.on("data", (c) => {
      lastErr += c.toString();
    });
    child.stdout.on("data", (chunk) => {
      if (!started) {
        started = true;
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader(
          "Content-Disposition",
          `inline; filename="${safe}.m4a"`
        );
        res.setHeader("Cache-Control", "no-store");
      }
      res.write(chunk);
    });
    child.on("error", (e) => {
      lastErr += e.message;
      if (!started && !res.headersSent) {
        finished = true;
        res.status(503).json({
          error: "yt-dlp missing on server",
          detail: e.message,
        });
      }
    });
    child.on("close", (code) => {
      if (started) {
        if (!finished) {
          finished = true;
          res.end();
        }
        return;
      }
      console.error("stream fail", client, code, lastErr.slice(0, 200));
      tryStreamNext();
    });
  };

  // ---- DOWNLOAD: real MP3 via temp file ----
  const tryMp3Next = () => {
    if (started || res.headersSent || finished) return;
    if (attempt >= clients.length) {
      fail(1);
      return;
    }
    const client = clients[attempt++];
    cleanupChild();
    cleanupTemp();
    lastErr = "";

    // Unique temp path without extension; yt-dlp adds .mp3 after convert
    const base = pathMod.join(
      os.tmpdir(),
      `aura_${id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    );
    const outTemplate = base + ".%(ext)s";
    // After -x --audio-format mp3, file will be base.mp3
    const expectedMp3 = base + ".mp3";

    const args = buildMp3FileArgs(url, client, outTemplate);
    console.log("yt-dlp mp3 try", client, "->", expectedMp3);

    child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", (c) => {
      lastErr += c.toString();
    });
    child.on("error", (e) => {
      lastErr += e.message;
      if (!started && !res.headersSent) {
        finished = true;
        res.status(503).json({
          error: "yt-dlp missing on server",
          detail: e.message,
          hint: "Build: pip install -U yt-dlp && apt-get install -y ffmpeg",
        });
      }
    });
    child.on("close", (code) => {
      if (finished || res.headersSent) {
        cleanupTemp();
        return;
      }
      // Find the mp3 file (sometimes extension varies)
      let filePath = null;
      if (fs.existsSync(expectedMp3)) {
        filePath = expectedMp3;
      } else {
        try {
          const dir = pathMod.dirname(base);
          const prefix = pathMod.basename(base);
          const found = fs.readdirSync(dir).find((f) => f.startsWith(prefix));
          if (found) filePath = pathMod.join(dir, found);
        } catch (_) {}
      }

      if (code === 0 && filePath && fs.existsSync(filePath)) {
        tempMp3 = filePath;
        started = true;
        const stat = fs.statSync(filePath);
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${safe}.mp3"`
        );
        res.setHeader("Content-Length", stat.size);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");

        const stream = fs.createReadStream(filePath);
        stream.on("error", (e) => {
          console.error("read mp3 error", e.message);
          cleanupTemp();
          if (!res.headersSent) fail(1);
          else if (!finished) {
            finished = true;
            res.end();
          }
        });
        stream.on("end", () => {
          finished = true;
          cleanupTemp();
          res.end();
        });
        stream.pipe(res, { end: false });
        return;
      }

      console.error(
        "mp3 fail client=",
        client,
        "code=",
        code,
        lastErr.slice(0, 300)
      );
      cleanupTemp();
      tryMp3Next();
    });
  };

  // Concurrency slot
  activeDownloads++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeDownloads = Math.max(0, activeDownloads - 1);
    pumpQueue();
  };
  const origEnd = res.end.bind(res);
  res.end = function (...a) {
    release();
    cleanupTemp();
    return origEnd(...a);
  };
  const origJson = res.json.bind(res);
  res.json = function (...a) {
    release();
    cleanupTemp();
    return origJson(...a);
  };

  const req = res.req;
  if (req) {
    req.on("close", () => {
      cleanupChild();
      cleanupTemp();
      finished = true;
      release();
    });
  }

  if (asMp3) tryMp3Next();
  else tryStreamNext();
}

// --------------------------------------------------
// DOWNLOAD — always MP3
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
// STREAM (background play on phone) — raw audio, no MP3 convert
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
