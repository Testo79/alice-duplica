(function () {
  const PREFIX = "hetzner_";

  function getSessionId() {
    const params = new URLSearchParams(window.location.search);
    return (params.get("s") || sessionStorage.getItem(PREFIX + "session") || "").trim();
  }

  function saveSessionId(id) {
    if (id) sessionStorage.setItem(PREFIX + "session", id);
  }

  function saveEmail(email) {
    if (email) sessionStorage.setItem(PREFIX + "identifier", email);
  }

  function getEmail() {
    return sessionStorage.getItem(PREFIX + "identifier") || "";
  }

  async function pollSession(sessionId) {
    const res = await fetch("/api/hetzner/session/" + encodeURIComponent(sessionId) + "/poll");
    return res.json();
  }

  function requireSession() {
    const id = getSessionId();
    if (!id) {
      window.location.replace("hetzner.html");
      return null;
    }
    saveSessionId(id);
    return id;
  }

  async function loadSessionInfo(sessionId) {
    const res = await fetch("/api/hetzner/session/" + encodeURIComponent(sessionId));
    const data = await res.json();
    if (!data.ok) {
      window.location.replace("hetzner.html");
      return null;
    }
    saveEmail(data.email);
    return data;
  }

  async function submitCode(sessionId, code) {
    const res = await fetch("/api/hetzner/session/" + encodeURIComponent(sessionId) + "/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    return res.json();
  }

  function showError(el, message) {
    if (!el) return;
    el.textContent = message;
    el.hidden = !message;
  }

  window.HetznerFlow = {
    getSessionId,
    saveSessionId,
    saveEmail,
    getEmail,
    pollSession,
    requireSession,
    loadSessionInfo,
    submitCode,
    showError,
  };
})();
