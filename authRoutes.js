const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "aura-dev-secret-change-me";

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

const playlistSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
  name: String,
  songs: [{ id: String, title: String, artist: String, thumb: String }],
  updatedAt: { type: Date, default: Date.now },
});

const historySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
  songId: String,
  title: String,
  artist: String,
  thumb: String,
  playedAt: { type: Date, default: Date.now },
});

const User = mongoose.models.User || mongoose.model("User", userSchema);
const Playlist = mongoose.models.Playlist || mongoose.model("Playlist", playlistSchema);
const History = mongoose.models.History || mongoose.model("History", historySchema);

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return res.status(401).json({ error: "login required" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "invalid token" });
  }
}

router.post("/signup", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const username = String(req.body.username || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (!name || !username || password.length < 4) {
      return res.status(400).json({ error: "name, username, password (min 4) required" });
    }
    if (await User.findOne({ username })) {
      return res.status(409).json({ error: "username taken" });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ name, username, passwordHash });
    const token = jwt.sign({ id: user._id, username, name }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { name, username } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const user = await User.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: "invalid username or password" });
    }
    const token = jwt.sign(
      { id: user._id, username: user.username, name: user.name },
      JWT_SECRET,
      { expiresIn: "30d" }
    );
    res.json({ token, user: { name: user.name, username: user.username } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/me", auth, async (req, res) => {
  const user = await User.findById(req.user.id).select("name username createdAt");
  if (!user) return res.status(404).json({ error: "not found" });
  res.json({ user });
});

router.get("/playlists", auth, async (req, res) => {
  const list = await Playlist.find({ userId: req.user.id }).sort({ updatedAt: -1 });
  res.json({ playlists: list });
});

router.post("/playlists", auth, async (req, res) => {
  const name = String(req.body.name || "My Playlist").trim();
  const songs = Array.isArray(req.body.songs) ? req.body.songs : [];
  const pl = await Playlist.create({ userId: req.user.id, name, songs, updatedAt: new Date() });
  res.json({ playlist: pl });
});

router.post("/history", auth, async (req, res) => {
  const { songId, title, artist, thumb } = req.body || {};
  if (!songId) return res.status(400).json({ error: "songId required" });
  await History.create({
    userId: req.user.id,
    songId,
    title: title || "",
    artist: artist || "",
    thumb: thumb || "",
  });
  res.json({ ok: true });
});

router.get("/history", auth, async (req, res) => {
  const items = await History.find({ userId: req.user.id }).sort({ playedAt: -1 }).limit(50);
  res.json({ history: items });
});

module.exports = router;
