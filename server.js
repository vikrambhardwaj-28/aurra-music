require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const { spawn } = require("child_process");
const ytSearch = require("yt-search");
const app = express();
const PORT = process.env.PORT || 3000;

// Optional: YouTube captions
let lyricsHandler = null;
try {
  lyricsHandler = require("./lyricsHandler");
  console.log("Lyrics handler loaded (YouTube captions OK)");
} catch (e) {
  console.warn("lyricsHandler missing or broken — /lyrics disabled.", e.message);
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

const MAX_CONCURRENT_DOWNLOADS = Math.max(
  1,
  parseInt(process.env.MAX_DOWNLOADS || "2", 10) || 2
);
let activeDownloads = 0;
const downloadQueue = [];

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

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    cache: searchCache.size,
    lyrics: !!lyricsHandler,
    ytdlp: process.env.YTDLP_PATH || "yt-dlp",
    downloads: {
      active: activeDownloads,
      queued: downloadQueue.length,
      max: MAX_CONCURRENT_DOWNLOADS,
    },
    t: Date.now(),
  });
});

if (lyricsHandler) {
  app.get("/lyrics", lyricsHandler);
  app.get("/api/lyrics", lyricsHandler);
}

// --------------------------------------------------
// SEARCH — videos + channels + playlists
// --------------------------------------------------
const SEARCH_PAGE_SIZE = 24;

async function doSearch(query, page = 1) {
  page = Math.max(1, page | 0);
  // fetch enough pages for this slice (yt-search ~20 videos per page)
  const needPages = Math.min(page + 1, 5);
  const result = await Promise.race([
    ytSearch({ query, pages: needPages }),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("timeout")), 18000)
    ),
  ]);

  const allVideos = result.videos || [];
  const start = (page - 1) * SEARCH_PAGE_SIZE;
  const slice = allVideos.slice(start, start + SEARCH_PAGE_SIZE);

  const videos = slice.map((v) => ({
    type: "video",
    id: v.videoId,
    title: v.title,
    author: v.author?.name || "Unknown",
    thumbnail:
      v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
    timestamp: v.timestamp || "",
    seconds: v.seconds || 0,
  }));

  // channels + playlists only on first page
  let channels = [];
  let playlists = [];
  if (page === 1) {
    channels = (result.channels || []).slice(0, 4).map((c) => ({
      type: "channel",
      id: c.channelId || c.authorId || (c.url || "").split("/").pop() || "",
      title: c.name || c.title || "Channel",
      author: c.name || c.title || "Channel",
      thumbnail: c.image || c.thumbnail || "",
      videoCount: c.videoCount || c.videos || "",
      subscribers: c.subCountLabel || c.subscriberCount || c.subscribers || c.subCount || "",
      url: c.url || "",
    }));

    playlists = (result.playlists || [])
      .slice(0, 6)
      .map((p) => {
        let pid = p.listId || p.playlistId || p.id || "";
        if (!pid && p.url) {
          const m = String(p.url).match(/[?&]list=([a-zA-Z0-9_-]+)/);
          if (m) pid = m[1];
        }
        return {
          type: "playlist",
          id: pid,
          title: p.title || "Playlist",
          author: p.owner?.name || p.author?.name || "Unknown",
          thumbnail: p.image || p.thumbnail || "",
          videoCount: p.videoCount || p.videoCountLabel || "",
        };
      })
      .filter((p) => p.id && p.id.length >= 10);
  }

  const hasMore =
    allVideos.length > start + SEARCH_PAGE_SIZE ||
    (slice.length >= SEARCH_PAGE_SIZE && needPages < 5);

  const items = page === 1 ? [...channels, ...playlists, ...videos] : videos;
  return { items, page, hasMore, total: allVideos.length };
}

app.get("/search", async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (!query) return res.status(400).json({ error: "query required" });
  const page = Math.max(1, parseInt(req.query.page || "1", 10) || 1);

  const key = query.toLowerCase() + "::p" + page;
  const hit = getCache(key);
  if (hit) {
    res.setHeader("X-Cache", "HIT");
    return res.json(hit);
  }

  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      console.log(`Search try ${i + 1}:`, query, "page", page);
      const data = await doSearch(query, page);
      setCache(key, data);
      res.setHeader("X-Cache", "MISS");
      return res.json(data);
    } catch (e) {
      lastErr = e;
      console.error("Search fail:", e.message);
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  res.status(500).json({ error: "Search failed", detail: lastErr?.message });
});

// --------------------------------------------------
// PLAYLIST videos — yt-dlp primary (reliable), yt-search fallback
// --------------------------------------------------
const PLAYLIST_PAGE_SIZE = 40;

function fetchPlaylistViaYtDlp(listId, page = 1) {
  return new Promise((resolve, reject) => {
    const bin = process.env.YTDLP_PATH || "yt-dlp";
    const url = `https://www.youtube.com/playlist?list=${listId}`;
    page = Math.max(1, page | 0);
    const start = (page - 1) * PLAYLIST_PAGE_SIZE + 1;
    const end = page * PLAYLIST_PAGE_SIZE;
    const args = [
      "--flat-playlist",
      "--dump-json",
      "--no-warnings",
      "--no-download",
      "--playlist-start",
      String(start),
      "--playlist-end",
      String(end),
      "--geo-bypass",
      "--retries",
      "2",
    ];
    const cookies = (() => {
      try {
        const fs = require("fs");
        const pathMod = require("path");
        const p =
          process.env.COOKIES_FILE ||
          process.env.YTDLP_COOKIES ||
          (fs.existsSync(pathMod.join(__dirname, "cookies.txt"))
            ? pathMod.join(__dirname, "cookies.txt")
            : "");
        return p && fs.existsSync(p) ? p : "";
      } catch (_) {
        return "";
      }
    })();
    if (cookies) args.push("--cookies", cookies);
    args.push(url);

    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch (_) {}
      reject(new Error("yt-dlp playlist timeout"));
    }, 28000);

    child.stdout.on("data", (c) => {
      out += c.toString();
    });
    child.stderr.on("data", (c) => {
      err += c.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!out.trim()) {
        reject(new Error(err.slice(0, 200) || "yt-dlp empty output code=" + code));
        return;
      }
      // --dump-json with flat-playlist: one JSON object per line (each video)
      // sometimes also a playlist header object
      const lines = out.split("\n").filter((l) => l.trim().startsWith("{"));
      const videos = [];
      let title = "Playlist";
      for (const line of lines) {
        try {
          const j = JSON.parse(line);
          if (j._type === "playlist" || (j.entries && !j.id)) {
            title = j.title || j.playlist_title || title;
            continue;
          }
          let vid = String(j.id || j.url || "").replace(/^.*v=/, "").replace(/[^a-zA-Z0-9_-]/g, "");
          if (!vid || vid.length < 6 || vid.length > 20) continue;
          // skip deleted/private
          if (j.title && /\[Deleted|\[Private/i.test(j.title)) continue;
          // Always use high-quality YouTube thumb (flat-playlist thumbs are tiny/blurry)
          videos.push({
            type: "video",
            id: vid,
            title: j.title || j.fulltitle || "Unknown",
            author:
              j.uploader ||
              j.channel ||
              j.playlist_uploader ||
              title ||
              "Unknown",
            thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
            timestamp: j.duration_string || "",
            mood: "Playlist",
          });
          if (j.playlist_title) title = j.playlist_title;
          if (j.playlist && typeof j.playlist === "string") title = j.playlist;
        } catch (_) {}
      }
      // unique by id
      const seen = new Set();
      const unique = videos.filter((v) => {
        if (seen.has(v.id)) return false;
        seen.add(v.id);
        return true;
      });
      // hasMore only if we got a full page (real more items likely exist)
      const hasMore = unique.length >= PLAYLIST_PAGE_SIZE;
      resolve({ title, videos: unique, hasMore, page });
    });
  });
}

async function fetchPlaylistViaYtSearch(listId) {
  const result = await Promise.race([
    ytSearch({ listId }),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("yt-search timeout")), 18000)
    ),
  ]);
  const videos = (result.videos || [])
    .filter(
      (v) =>
        v &&
        v.videoId &&
        !String(v.title || "").includes("[Deleted") &&
        !String(v.title || "").includes("[Private")
    )
    .map((v) => ({
      type: "video",
      id: v.videoId,
      title: v.title,
      author: (v.author && v.author.name) || result.title || "Unknown",
      thumbnail: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
      timestamp: v.timestamp || "",
      mood: "Playlist",
    }));
  return { title: result.title || "Playlist", videos };
}

async function handlePlaylist(req, res) {
  let listId = String(req.query.list || req.query.id || "").trim();
  const page = Math.max(1, parseInt(req.query.page || "1", 10) || 1);
  // strip full URL if pasted
  if (listId.includes("list=")) {
    try {
      listId = new URL(listId).searchParams.get("list") || listId;
    } catch (_) {
      const m = listId.match(/[?&]list=([^&]+)/);
      if (m) listId = m[1];
    }
  }
  // only keep valid playlist id chars
  listId = listId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!listId || listId.length < 10) {
    return res.status(400).json({ error: "list id required", got: listId });
  }

  console.log("Playlist load:", listId, "page", page);
  let lastErr = "";

  // 1) yt-dlp first (more reliable on Render)
  try {
    const data = await fetchPlaylistViaYtDlp(listId, page);
    if (data.videos && data.videos.length) {
      console.log("Playlist yt-dlp OK:", data.videos.length, data.title, "hasMore", data.hasMore);
      return res.json({
        title: data.title,
        videos: data.videos,
        listId,
        page,
        hasMore: !!data.hasMore,
        source: "yt-dlp",
      });
    }
    // empty page = no more results (not an error on page > 1)
    if (page > 1) {
      return res.json({ title: "Playlist", videos: [], listId, page, hasMore: false, source: "yt-dlp" });
    }
    lastErr = "yt-dlp returned 0 videos";
  } catch (e) {
    lastErr = "yt-dlp: " + e.message;
    console.warn("Playlist yt-dlp fail:", e.message);
  }

  // 2) yt-search fallback (only page 1 — no real pagination)
  if (page === 1) {
    try {
      const data = await fetchPlaylistViaYtSearch(listId);
      if (data.videos && data.videos.length) {
        console.log("Playlist yt-search OK:", data.videos.length, data.title);
        return res.json({
          title: data.title,
          videos: data.videos,
          listId,
          page: 1,
          hasMore: false,
          source: "yt-search",
        });
      }
      lastErr = (lastErr ? lastErr + " | " : "") + "yt-search returned 0 videos";
    } catch (e) {
      lastErr = (lastErr ? lastErr + " | " : "") + "yt-search: " + e.message;
      console.warn("Playlist yt-search fail:", e.message);
    }
  }

  console.error("Playlist fail:", listId, lastErr);
  res.status(502).json({
    error: "Playlist failed",
    detail: lastErr.slice(0, 300),
    listId,
  });
}

app.get("/playlist", handlePlaylist);
app.get("/api/playlist", handlePlaylist);

// --------------------------------------------------
// CHANNEL videos (Shorts filter: duration < 60s skip)
// --------------------------------------------------
async function handleChannel(req, res) {
  const channelId = String(req.query.id || "").trim();
  const channelName = String(req.query.q || req.query.name || "").trim();
  const page = Math.max(1, parseInt(req.query.page || "1", 10) || 1);
  const pages = page === 1 ? 2 : Math.min(page + 1, 4);

  if (!channelId && !channelName) {
    return res.status(400).json({ error: "channel id or name required" });
  }

  try {
    const query = channelName || channelId;
    console.log("Channel load:", query, "page", page);
    const result = await Promise.race([
      ytSearch({ query: query, pages }),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("timeout")), 22000)
      ),
    ]);

    const all = (result.videos || []).filter((v) => {
      // no Shorts
      if (v.seconds && v.seconds > 0 && v.seconds < 60) return false;
      return true;
    });

    // page slice: page1 = 0-24, page2 = 24-48, etc
    const start = (page - 1) * 24;
    const slice = all.slice(start, start + 24);

    const videos = slice.map((v) => ({
      type: "video",
      id: v.videoId,
      title: v.title,
      author: v.author?.name || channelName || "Unknown",
      thumbnail:
        v.thumbnail ||
        `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
      timestamp: v.timestamp || "",
      mood: "Channel",
    }));

    const hasMore = videos.length >= 24 && all.length > start + 24; // only if full page

    res.json({
      title: channelName || "Channel",
      videos,
      page,
      hasMore,
      total: all.length,
    });
  } catch (e) {
    console.error("Channel fail:", e.message);
    res.status(500).json({ error: "Channel failed", detail: e.message });
  }
}

app.get("/channel", handleChannel);
app.get("/api/channel", handleChannel);

// --------------------------------------------------
// DOWNLOAD / STREAM
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

function buildStreamArgs(url, client) {
  const args = [
    "-f", "bestaudio/best", "-o", "-",
    "--no-playlist", "--no-warnings", "--geo-bypass",
    "--no-check-certificates", "--retries", "3",
    "--fragment-retries", "3",
    "--extractor-args", `youtube:player_client=${client}`,
  ];
  const cookies = getCookiesPath();
  if (cookies) args.push("--cookies", cookies);
  args.push(url);
  return args;
}

function buildMp3FileArgs(url, client, outTemplate) {
  const args = [
    "-f", "bestaudio/best", "-x", "--audio-format", "mp3",
    "--audio-quality", "0", "-o", outTemplate,
    "--no-playlist", "--no-warnings", "--geo-bypass",
    "--no-check-certificates", "--retries", "3",
    "--fragment-retries", "3",
    "--extractor-args", `youtube:player_client=${client}`,
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
    .split(",").map((s) => s.trim()).filter(Boolean);

  console.log(inline ? "Stream:" : "Download(MP3-file):", id, safe, "clients=", clients.join("|"));

  let attempt = 0, started = false, lastErr = "", child = null, finished = false, tempMp3 = null;

  const cleanupChild = () => {
    if (child) { try { child.kill("SIGTERM"); } catch (_) {} child = null; }
  };
  const cleanupTemp = () => {
    if (tempMp3) { try { fs.unlinkSync(tempMp3); } catch (_) {} tempMp3 = null; }
  };

  const fail = (code) => {
    cleanupTemp();
    if (res.headersSent || finished) return;
    finished = true;
    const bot = /Sign in to confirm|not a bot|cookies/i.test(lastErr);
    const noFfmpeg = /ffmpeg is not installed|ffprobe|Postprocessing|ERROR:.*ffmpeg/i.test(lastErr);
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

  const tryStreamNext = () => {
    if (started || res.headersSent || finished) return;
    if (attempt >= clients.length) { fail(1); return; }
    const client = clients[attempt++];
    cleanupChild();
    lastErr = "";
    const args = buildStreamArgs(url, client);
    console.log("yt-dlp stream try", client);
    child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stderr.on("data", (c) => { lastErr += c.toString(); });
    child.stdout.on("data", (chunk) => {
      if (!started) {
        started = true;
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", `inline; filename="${safe}.m4a"`);
        res.setHeader("Cache-Control", "no-store");
      }
      res.write(chunk);
    });
    child.on("error", (e) => {
      lastErr += e.message;
      if (!started && !res.headersSent) {
        finished = true;
        res.status(503).json({ error: "yt-dlp missing on server", detail: e.message });
      }
    });
    child.on("close", (code) => {
      if (started) {
        if (!finished) { finished = true; res.end(); }
        return;
      }
      console.error("stream fail", client, code, lastErr.slice(0, 200));
      tryStreamNext();
    });
  };

  const tryMp3Next = () => {
    if (started || res.headersSent || finished) return;
    if (attempt >= clients.length) { fail(1); return; }
    const client = clients[attempt++];
    cleanupChild();
    cleanupTemp();
    lastErr = "";
    const base = pathMod.join(os.tmpdir(), `aura_${id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const outTemplate = base + ".%(ext)s";
    const expectedMp3 = base + ".mp3";
    const args = buildMp3FileArgs(url, client, outTemplate);
    console.log("yt-dlp mp3 try", client, "->", expectedMp3);
    child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", (c) => { lastErr += c.toString(); });
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
      if (finished || res.headersSent) { cleanupTemp(); return; }
      let filePath = null;
      if (fs.existsSync(expectedMp3)) filePath = expectedMp3;
      else {
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
        res.setHeader("Content-Disposition", `attachment; filename="${safe}.mp3"`);
        res.setHeader("Content-Length", stat.size);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
        const stream = fs.createReadStream(filePath);
        stream.on("error", (e) => {
          console.error("read mp3 error", e.message);
          cleanupTemp();
          if (!res.headersSent) fail(1);
          else if (!finished) { finished = true; res.end(); }
        });
        stream.on("end", () => { finished = true; cleanupTemp(); res.end(); });
        stream.pipe(res, { end: false });
        return;
      }
      console.error("mp3 fail client=", client, "code=", code, lastErr.slice(0, 300));
      cleanupTemp();
      tryMp3Next();
    });
  };

  activeDownloads++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeDownloads = Math.max(0, activeDownloads - 1);
    pumpQueue();
  };

  const origEnd = res.end.bind(res);
  res.end = function (...a) { release(); cleanupTemp(); return origEnd(...a); };
  const origJson = res.json.bind(res);
  res.json = function (...a) { release(); cleanupTemp(); return origJson(...a); };

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

app.get("/download", (req, res) => {
  runYtDlpAudio(req.query.id, res, { inline: false, title: req.query.title });
});
app.get("/api/download", (req, res) => {
  runYtDlpAudio(req.query.id, res, { inline: false, title: req.query.title });
});
app.get("/stream", (req, res) => {
  runYtDlpAudio(req.query.id, res, { inline: true, title: req.query.title });
});
app.get("/api/stream", (req, res) => {
  runYtDlpAudio(req.query.id, res, { inline: true, title: req.query.title });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Aura Music on", PORT);
  console.log("Routes: /search /playlist /channel /stream /download /lyrics /health");
  console.log("yt-dlp bin:", process.env.YTDLP_PATH || "yt-dlp");
});
