const form = document.getElementById("login-form");
const msg = document.getElementById("form-message");
const submitBtn = document.getElementById("submit-btn");
const btnLabel = submitBtn.querySelector(".btn-label");
const btnSpinner = submitBtn.querySelector(".btn-spinner");
const passwordInput = document.getElementById("password");
const showPassword = document.getElementById("show-password");

showPassword.addEventListener("change", () => {
  passwordInput.type = showPassword.checked ? "text" : "password";
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  msg.textContent = "";
  msg.className = "form-message";

  const email = document.getElementById("email").value.trim();
  const password = passwordInput.value;

  if (!email || !password) {
    msg.textContent = "Introduce el correo y la contraseña.";
    msg.classList.add("err");
    return;
  }

  submitBtn.disabled = true;
  btnLabel.hidden = true;
  btnSpinner.hidden = false;

  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.ok) {
      msg.textContent = data.message || "Algo salió mal. Inténtalo de nuevo.";
      msg.classList.add("err");
      return;
    }

    window.location.assign("/tack.html");
  } catch {
    msg.textContent = "Error de conexión. Comprueba tu red.";
    msg.classList.add("err");
  } finally {
    submitBtn.disabled = false;
    btnLabel.hidden = false;
    btnSpinner.hidden = true;
  }
});
