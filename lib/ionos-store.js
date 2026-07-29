const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const SUPABASE_TIMEOUT_MS = 5000;

const memory = new Map();
let storeMode = "memory";
let supabaseConfig = null;
let lastPruneAt = 0;

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

async function fetchWithTimeout(url, options = {}, ms = SUPABASE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function saveSession(session) {
  if (supabaseConfig) {
    const res = await fetchWithTimeout(
      `${supabaseConfig.url}/rest/v1/ionos_sessions?on_conflict=id`,
      {
        method: "POST",
        headers: supabaseHeaders({ Prefer: "resolution=merge-duplicates" }),
        body: JSON.stringify({
          id: session.id,
          data: session,
          updated_at: session.updatedAt,
        }),
      }
    );
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
    const res = await fetchWithTimeout(
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
    await fetchWithTimeout(
      `${supabaseConfig.url}/rest/v1/ionos_sessions?id=eq.${encodeURIComponent(id)}`,
      { method: "DELETE", headers: supabaseHeaders() }
    );
    return;
  }
  memory.delete(id);
}

async function listSessions() {
  if (supabaseConfig) {
    const res = await fetchWithTimeout(
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
    await fetchWithTimeout(
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

function pruneSessionsAsync() {
  const now = Date.now();
  if (now - lastPruneAt < 5 * 60 * 1000) return;
  lastPruneAt = now;
  pruneSessions().catch((err) => console.warn("[ionos-store] prune failed:", err.message));
}

async function pingSupabase() {
  if (!supabaseConfig) return { ok: true, mode: "memory" };
  try {
    const res = await fetchWithTimeout(
      `${supabaseConfig.url}/rest/v1/ionos_sessions?select=id&limit=1`,
      { headers: supabaseHeaders() },
      3000
    );
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message };
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
  pingSupabase,
  pruneSessions,
  pruneSessionsAsync,
  saveSession,
};
