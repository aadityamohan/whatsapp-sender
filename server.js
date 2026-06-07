const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Multer (CSV upload, memory only) ─────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === ".csv") cb(null, true);
    else cb(new Error("Only CSV files are allowed"));
  },
});

// ─── Multer (PDF upload, disk storage) ────────────────────────────────────────
const pdfDir = path.join(__dirname, ".tmp_uploads");
if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir);

const uploadPdf = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, pdfDir),
    filename: (req, file, cb) => cb(null, `pdf_${Date.now()}.pdf`),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF files are allowed"));
  },
});

// ─── State ─────────────────────────────────────────────────────────────────────
let waClient = null;
let waStatus = "disconnected"; // disconnected | initializing | qr | connected
let waPhone = null;
let isSending = false;
let sendAbort = false;

// ─── Chrome executable detection ──────────────────────────────────────────────
// Order of preference:
//   1. PUPPETEER_EXECUTABLE_PATH env var (Docker / Railway sets this)
//   2. First existing path from common system locations
//   3. undefined → puppeteer falls back to its bundled chromium
function resolveChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;

  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

const CHROME_PATH = resolveChromePath();
const AUTH_DIR = process.env.WA_AUTH_DIR || path.join(__dirname, ".wwebjs_auth");

// ─── WhatsApp client setup ─────────────────────────────────────────────────────
function createClient() {
  const puppeteerOptions = {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
    ],
  };
  if (CHROME_PATH) puppeteerOptions.executablePath = CHROME_PATH;

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
    puppeteer: puppeteerOptions,
  });

  client.on("qr", async (qr) => {
    waStatus = "qr";
    const qrImage = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
    io.emit("wa:status", { status: "qr", qrImage });
    console.log("📱 QR code ready — scan in browser");
  });

  client.on("loading_screen", (percent, message) => {
    waStatus = "initializing";
    io.emit("wa:status", { status: "initializing", percent, message });
    console.log(`⏳ Loading: ${percent}% — ${message}`);
  });

  client.on("authenticated", () => {
    waStatus = "initializing";
    io.emit("wa:status", { status: "initializing", percent: 100, message: "Authenticated" });
    console.log("🔐 Authenticated");
  });

  client.on("ready", () => {
    waStatus = "connected";
    waPhone = client.info?.wid?.user || "unknown";
    io.emit("wa:status", { status: "connected", phone: waPhone });
    console.log(`✅ WhatsApp ready — connected as ${waPhone}`);
  });

  client.on("disconnected", (reason) => {
    waStatus = "disconnected";
    waPhone = null;
    waClient = null;
    io.emit("wa:status", { status: "disconnected" });
    console.log("📴 Disconnected:", reason);
  });

  client.on("auth_failure", (msg) => {
    waStatus = "disconnected";
    waClient = null;
    io.emit("wa:status", { status: "disconnected" });
    console.log("❌ Auth failure:", msg);
  });

  return client;
}

async function connectWhatsApp() {
  if (waStatus === "connected" || waStatus === "initializing" || waStatus === "qr") return;

  waStatus = "initializing";
  io.emit("wa:status", { status: "initializing", percent: 0, message: "Starting..." });

  waClient = createClient();
  await waClient.initialize();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatPhone(raw) {
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 10) digits = "91" + digits; // India default
  return digits + "@c.us";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function personalise(template, row) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return row[key] ?? row[key.toLowerCase()] ?? `{{${key}}}`;
  });
}

// ─── API Routes ────────────────────────────────────────────────────────────────

app.post("/api/wa/connect", async (req, res) => {
  try {
    await connectWhatsApp();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/wa/disconnect", async (req, res) => {
  try {
    if (waClient) {
      await waClient.destroy();
      waClient = null;
    }
    waStatus = "disconnected";
    waPhone = null;
    io.emit("wa:status", { status: "disconnected" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/wa/status", (req, res) => {
  res.json({ status: waStatus, phone: waPhone });
});

// Parse CSV and return preview
app.post("/api/csv/parse", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const rows = [];
  const stream = require("stream");
  const readable = new stream.Readable();
  readable.push(req.file.buffer);
  readable.push(null);

  readable
    .pipe(csv())
    .on("data", (row) => rows.push(row))
    .on("end", () => res.json({ rows, columns: rows.length > 0 ? Object.keys(rows[0]) : [], count: rows.length }))
    .on("error", (e) => res.status(500).json({ error: e.message }));
});

app.post("/api/upload/pdf", (req, res) => {
  uploadPdf.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    res.json({ filename: req.file.filename, originalName: req.file.originalname });
  });
});

// Send bulk messages
app.post("/api/send", async (req, res) => {
  if (waStatus !== "connected") return res.status(400).json({ error: "WhatsApp is not connected" });
  if (isSending) return res.status(400).json({ error: "Already sending" });

  const { rows, phoneColumn, message, minDelay = 5, maxDelay = 10, pdfFilename, pdfOriginalName } = req.body;

  if (!rows?.length) return res.status(400).json({ error: "No contacts provided" });
  if (!phoneColumn) return res.status(400).json({ error: "Phone column not specified" });
  if (!message?.trim()) return res.status(400).json({ error: "Message is empty" });

  isSending = true;
  sendAbort = false;
  res.json({ ok: true, total: rows.length });

  (async () => {
    let sent = 0, failed = 0;
    io.emit("send:start", { total: rows.length });

    let media = null;
    if (pdfFilename) {
      const pdfPath = path.join(pdfDir, pdfFilename);
      if (fs.existsSync(pdfPath)) {
        media = MessageMedia.fromFilePath(pdfPath);
        if (pdfOriginalName) media.filename = pdfOriginalName;
      }
    }

    for (let i = 0; i < rows.length; i++) {
      if (sendAbort) { io.emit("send:aborted", { sent, failed }); break; }

      const row = rows[i];
      const rawPhone = row[phoneColumn];

      if (!rawPhone) {
        io.emit("send:result", { index: i, phone: rawPhone, status: "skip", reason: "Empty phone", sent, failed: ++failed, total: rows.length });
        continue;
      }

      const phone = formatPhone(rawPhone);
      const text = personalise(message, row);

      try {
        const isRegistered = await waClient.isRegisteredUser(phone);
        if (!isRegistered) {
          io.emit("send:result", { index: i, phone: rawPhone, status: "failed", reason: "Not on WhatsApp", sent, failed: ++failed, total: rows.length });
        } else {
          if (media) {
            await waClient.sendMessage(phone, media, { caption: text });
          } else {
            await waClient.sendMessage(phone, text);
          }
          sent++;
          io.emit("send:result", { index: i, phone: rawPhone, status: "sent", sent, failed, total: rows.length });
        }
      } catch (err) {
        io.emit("send:result", { index: i, phone: rawPhone, status: "failed", reason: err.message, sent, failed: ++failed, total: rows.length });
      }

      if (i < rows.length - 1 && !sendAbort) {
        const delay = (Math.random() * (maxDelay - minDelay) + minDelay) * 1000;
        io.emit("send:waiting", { delay: Math.round(delay / 1000), next: i + 1 });
        await sleep(delay);
      }
    }

    isSending = false;
    io.emit("send:done", { sent, failed, total: rows.length });

    if (pdfFilename) {
      const pdfPath = path.join(pdfDir, pdfFilename);
      if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
    }
  })();
});

app.post("/api/send/stop", (req, res) => {
  sendAbort = true;
  res.json({ ok: true });
});

// ─── Socket.io ─────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  socket.emit("wa:status", { status: waStatus, phone: waPhone });
});

// ─── Health check (used by Railway / load balancers) ──────────────────────────
app.get("/healthz", (req, res) => res.json({ ok: true, wa: waStatus }));

// ─── Auto-reconnect if auth exists ────────────────────────────────────────────
if (fs.existsSync(AUTH_DIR)) {
  console.log("🔁 Found saved session — reconnecting...");
  connectWhatsApp();
}

// ─── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
server.listen(PORT, HOST, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  WhatsApp Sender (Educational)        ║`);
  console.log(`║  http://${HOST}:${PORT}                ║`);
  console.log(`╚══════════════════════════════════════╝`);
  console.log(`Chrome path: ${CHROME_PATH || "(puppeteer bundled)"}`);
  console.log(`Auth dir:    ${AUTH_DIR}\n`);
});
