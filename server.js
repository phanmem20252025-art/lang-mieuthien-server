// LÀNG MIEUTHIEN - Standalone Production Node Server with High-Performance Gzip & Caching
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { setupMultiplayerHub, getFarmState, saveFarmState } = require("./server/multiplayerHub");

const PORT = process.env.PORT || 3000;
const SAVE_FILE = path.join(__dirname, "farm_save.json");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".woff": "application/font-woff",
  ".woff2": "font/woff2",
  ".ttf": "application/font-ttf",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".webmanifest": "application/manifest+json",
};

// Memory cache for compressed static assets
const fileCache = new Map();

function getCachedFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const cached = fileCache.get(filePath);
    if (cached && cached.mtime === stat.mtimeMs) {
      return cached;
    }
    const raw = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const shouldGzip = [".html", ".js", ".mjs", ".css", ".json", ".svg", ".webmanifest"].includes(ext);
    const gzip = shouldGzip ? zlib.gzipSync(raw, { level: 6 }) : null;
    const entry = {
      raw,
      gzip,
      mtime: stat.mtimeMs,
      size: raw.length,
      gzipSize: gzip ? gzip.length : null,
    };
    // Cache if under 35MB
    if (raw.length < 35 * 1024 * 1024) {
      fileCache.set(filePath, entry);
    }
    return entry;
  } catch (e) {
    return null;
  }
}

const server = http.createServer((req, res) => {
  // CORS & Ngrok Headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("ngrok-skip-browser-warning", "true");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check endpoint cho Cloud (Koyeb / Render / Fly.io / UptimeRobot)
  if (req.url === "/health" || req.url === "/ping" || req.url === "/version") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", app: "Lang Mieuthien Multiplayer Server", uptime: process.uptime(), commit: "2ed84d2", version: "2.1.0" }));
    return;
  }

  // API SAVE / LOAD (hỗ trợ lưu/nạp theo farmId)
  if (req.url.startsWith("/api/farm")) {
    const cleanUrl = req.url.split("?")[0];
    const parts = cleanUrl.split("/").filter(Boolean); // ["api", "farm", id?]
    const farmId = parts[2] || null;

    if (req.method === "GET") {
      if (farmId) {
        const farmData = getFarmState ? getFarmState(farmId) : null;
        if (farmData) {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify(farmData));
        }
      }
      if (fs.existsSync(SAVE_FILE)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(fs.readFileSync(SAVE_FILE, "utf-8"));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Chưa có file lưu nông trại" }));
      }
    } else if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          if (farmId && saveFarmState) {
            try {
              const parsed = JSON.parse(body);
              if (parsed.username && !parsed.name) parsed.name = parsed.username;
              if (parsed.name && !parsed.username) parsed.username = parsed.name;
              saveFarmState(farmId, parsed);
            } catch (e) {}
          }
          fs.writeFileSync(SAVE_FILE, body, "utf-8");
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ success: true, message: "Đã lưu nông trại!" }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }
  }

  // Static File Serving (dist production)
  const distDir = path.join(__dirname, "dist");
  const staticDir = fs.existsSync(distDir) ? distDir : __dirname;

  let reqPath = req.url.split("?")[0];
  let filePath = path.join(staticDir, reqPath);
  if (reqPath === "/" || reqPath === "") {
    filePath = path.join(staticDir, "index.html");
  }

  let entry = getCachedFile(filePath);

  if (!entry) {
    // If missing and it's a SPA route (no extension), fallback to index.html
    const ext = path.extname(reqPath).toLowerCase();
    if (!ext || ext === ".html") {
      const fallbackPath = path.join(staticDir, "index.html");
      entry = getCachedFile(fallbackPath);
      filePath = fallbackPath;
    }
  }

  if (!entry) {
    if (reqPath === "/" || reqPath === "") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", app: "Lang Mieuthien Multiplayer Server", ws: "/ws/chat" }));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 Not Found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || "application/octet-stream";
  const acceptEncoding = req.headers["accept-encoding"] || "";

  // Cache headers
  if (ext === ".html") {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  } else if (filePath.includes("assets") || ext === ".woff2" || ext === ".png" || ext === ".jpg") {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    res.setHeader("Cache-Control", "no-cache");
  }

  res.setHeader("Content-Type", contentType);

  if (entry.gzip && acceptEncoding.includes("gzip")) {
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Content-Length", entry.gzip.length);
    res.writeHead(200);
    res.end(entry.gzip);
  } else {
    res.setHeader("Content-Length", entry.size);
    res.writeHead(200);
    res.end(entry.raw);
  }
});

// Setup Realtime Multiplayer & Chat Hub
setupMultiplayerHub(server);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`===================================================`);
  console.log(`🌾 LÀNG MIEUTHIEN PRODUCTION SERVER (GZIP OPTIMIZED) ĐANG CHẠY!`);
  console.log(`🚜 Local:   http://localhost:${PORT}`);
  console.log(`🌐 Network: http://0.0.0.0:${PORT}`);
  console.log(`💬 WebSocket Hub: ws://0.0.0.0:${PORT}/ws/chat`);
  console.log(`📦 Serving: ${fs.existsSync(path.join(__dirname, "dist")) ? "dist (Production Bundle)" : "src"}`);
  console.log(`⚡ Gzip Compression: ENABLED`);
  console.log(`===================================================`);
});
