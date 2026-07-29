const SESSION_PREFIX = "ionos:session:";
const SESSION_TTL_SEC = 2 * 60 * 60;

const memory = new Map();
let redis = null;
let storeMode = "memory";

function initStore() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return;

  try {
    const { Redis } = require("@upstash/redis");
    redis = new Redis({ url, token });
    storeMode = "redis";
  } catch (err) {
    console.error("[ionos-store] Redis init failed:", err.message);
  }
}

initStore();

function sessionKey(id) {
  return SESSION_PREFIX + id;
}

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

async function saveSession(session) {
  if (redis) {
    await redis.set(sessionKey(session.id), JSON.stringify(session), { ex: SESSION_TTL_SEC });
    return;
  }
  memory.set(session.id, session);
}

async function getSession(id) {
  if (redis) {
    const raw = await redis.get(sessionKey(id));
    return parseSession(raw);
  }
  return memory.get(id) || null;
}

async function deleteSession(id) {
  if (redis) {
    await redis.del(sessionKey(id));
    return;
  }
  memory.delete(id);
}

async function listSessions() {
  if (redis) {
    const keys = await redis.keys(SESSION_PREFIX + "*");
    if (!keys || !keys.length) return [];

    const rows = await Promise.all(
      keys.map(async (key) => parseSession(await redis.get(key)))
    );
    return rows.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  return Array.from(memory.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}

async function pruneSessions() {
  const now = Date.now();
  const ttlMs = SESSION_TTL_SEC * 1000;

  if (redis) {
    const keys = await redis.keys(SESSION_PREFIX + "*");
    for (const key of keys) {
      const session = parseSession(await redis.get(key));
      if (session && now - session.updatedAt > ttlMs) {
        await redis.del(key);
      }
    }
    return;
  }

  for (const [id, session] of memory) {
    if (now - session.updatedAt > ttlMs) {
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
