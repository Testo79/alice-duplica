const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

const memory = new Map();
let storeMode = "memory";
let supabaseConfig = null;

function initStore() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    supabaseConfig = { url: url.replace(/\/$/, ""), key };
    storeMode = "supabase";
  }
}

initStore();

function parseSession(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

function supabaseHeaders(extra) {
  return {
    apikey: supabaseConfig.key,
    Authorization: `Bearer ${supabaseConfig.key}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function saveSession(session) {
  if (supabaseConfig) {
    const res = await fetch(`${supabaseConfig.url}/rest/v1/ionos_sessions`, {
      method: "POST",
      headers: supabaseHeaders({ Prefer: "resolution=merge-duplicates" }),
      body: JSON.stringify({
        id: session.id,
        data: session,
        updated_at: session.updatedAt,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Supabase save failed: ${err}`);
    }
    return;
  }
  memory.set(session.id, session);
}

async function getSession(id) {
  if (supabaseConfig) {
    const res = await fetch(
      `${supabaseConfig.url}/rest/v1/ionos_sessions?id=eq.${encodeURIComponent(id)}&select=data`,
      { headers: supabaseHeaders() }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    if (!rows.length) return null;
    return parseSession(rows[0].data);
  }
  return memory.get(id) || null;
}

async function deleteSession(id) {
  if (supabaseConfig) {
    await fetch(
      `${supabaseConfig.url}/rest/v1/ionos_sessions?id=eq.${encodeURIComponent(id)}`,
      { method: "DELETE", headers: supabaseHeaders() }
    );
    return;
  }
  memory.delete(id);
}

async function listSessions() {
  if (supabaseConfig) {
    const res = await fetch(
      `${supabaseConfig.url}/rest/v1/ionos_sessions?select=data&order=updated_at.desc`,
      { headers: supabaseHeaders() }
    );
    if (!res.ok) return [];
    const rows = await res.json();
    return rows.map((row) => parseSession(row.data)).filter(Boolean);
  }
  return Array.from(memory.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}

async function pruneSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;

  if (supabaseConfig) {
    await fetch(
      `${supabaseConfig.url}/rest/v1/ionos_sessions?updated_at=lt.${cutoff}`,
      { method: "DELETE", headers: supabaseHeaders() }
    );
    return;
  }

  for (const [id, session] of memory) {
    if (session.updatedAt < cutoff) {
      memory.delete(id);
    }
  }
}

function getStoreMode() {
  return storeMode;
}

module.exports = {
  deleteSession,
  getSession,
  getStoreMode,
  listSessions,
  pruneSessions,
  saveSession,
};
