/* Null Space — account page logic.
   Talks to the NullSpace-api Worker, stores the login token in localStorage,
   and renders login / register / dashboard views. Dependency-free. */

(function account() {
  // API base: local Worker during dev, custom domain in production.
  // Must match the site's CSP connect-src (_headers) and the macOS app's base URL.
  const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
  const API_BASE = isLocal ? "http://127.0.0.1:8787" : "https://api.nullspace.codes";
  const TOKEN_KEY = "ns_token";
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const $ = (id) => document.getElementById(id);
  const views = {
    loading: $("view-loading"),
    auth: $("view-auth"),
    forgot: $("view-forgot"),
    dash: $("view-dash"),
  };

  function show(name) {
    for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
  }

  function token() { return localStorage.getItem(TOKEN_KEY) || ""; }
  function setToken(t) { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); }

  async function api(path, { method = "GET", body, auth = false } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (auth) headers.Authorization = `Bearer ${token()}`;
    let res, data;
    try {
      res = await fetch(API_BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
      data = await res.json().catch(() => ({}));
    } catch {
      throw new Error("Network unavailable. Please check your connection.");
    }
    if (!res.ok) throw new Error(data.message || data.error || "Something went wrong.");
    return data;
  }

  // ───────────────────────── auth view ─────────────────────────

  let mode = "login"; // 'login' | 'register'
  const tabLogin = $("tab-login");
  const tabReg = $("tab-register");
  const authForm = $("auth-form");
  const emailInput = $("f-email");
  const passInput = $("f-password");
  const authMsg = $("auth-msg");
  const authSubmit = $("auth-submit");
  const authSubmitLabel = $("auth-submit-label");

  function setMode(next) {
    mode = next;
    const login = mode === "login";
    tabLogin.classList.toggle("is-active", login);
    tabReg.classList.toggle("is-active", !login);
    tabLogin.setAttribute("aria-selected", String(login));
    tabReg.setAttribute("aria-selected", String(!login));
    $("auth-title").textContent = login ? "Welcome back" : "Create your account";
    $("auth-sub").textContent = login
      ? "Sign in to your Null Space account."
      : "Null Space is in free public beta. Create an account and download the macOS app right away — free while the beta lasts.";
    authSubmitLabel.textContent = login ? "Sign In" : "Create Account";
    passInput.autocomplete = login ? "current-password" : "new-password";
    $("auth-switch-hint").innerHTML = login
      ? 'Don\'t have an account? <button class="link-btn" id="go-register" type="button">Create Account</button>'
      : 'Already have an account? <button class="link-btn" id="go-login" type="button">Sign In</button>';
    wireSwitchHint();
    syncForgotHint();
    setMsg(authMsg, "");
  }

  function wireSwitchHint() {
    const reg = $("go-register");
    const log = $("go-login");
    if (reg) reg.addEventListener("click", () => setMode("register"));
    if (log) log.addEventListener("click", () => setMode("login"));
  }

  tabLogin.addEventListener("click", () => setMode("login"));
  tabReg.addEventListener("click", () => setMode("register"));

  // forgot-password link is only meaningful when logging in
  function syncForgotHint() { $("forgot-hint").hidden = mode !== "login"; }

  function setMsg(el, text, kind) {
    el.textContent = text || "";
    el.className = "notify-msg" + (kind ? " is-" + kind : "");
  }

  authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = emailInput.value.trim();
    const password = passInput.value;
    if (!EMAIL_RE.test(email)) { setMsg(authMsg, "Please enter a valid email address.", "err"); emailInput.focus(); return; }
    if (password.length < 8) { setMsg(authMsg, "Password must be at least 8 characters long.", "err"); passInput.focus(); return; }

    authSubmit.disabled = true;
    setMsg(authMsg, "");
    try {
      const path = mode === "login" ? "/v1/auth/login" : "/v1/auth/register";
      const data = await api(path, { method: "POST", body: { email, password } });
      setToken(data.token);
      renderDash(data.user);
      show("dash");
    } catch (err) {
      setMsg(authMsg, err.message, "err");
    } finally {
      authSubmit.disabled = false;
    }
  });

  // ───────────────────────── forgot-password view ─────────────────────────

  const forgotForm = $("forgot-form");
  const fpEmail = $("fp-email");
  const forgotMsg = $("forgot-msg");
  const forgotSubmit = $("forgot-submit");

  $("go-forgot").addEventListener("click", () => {
    setMsg(forgotMsg, "");
    fpEmail.value = emailInput.value.trim(); // carry over what they typed
    show("forgot");
    fpEmail.focus();
  });
  $("back-to-login").addEventListener("click", () => { setMode("login"); show("auth"); });

  forgotForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = fpEmail.value.trim();
    if (!EMAIL_RE.test(email)) { setMsg(forgotMsg, "Please enter a valid email address.", "err"); fpEmail.focus(); return; }

    forgotSubmit.disabled = true;
    setMsg(forgotMsg, "Sending…");
    try {
      // The API always returns ok (no account enumeration) — so does our message.
      await api("/v1/auth/forgot", { method: "POST", body: { email } });
      setMsg(forgotMsg, "If an account with this email exists, we have sent a reset link. Please check your inbox.", "ok");
    } catch (err) {
      setMsg(forgotMsg, err.message, "err");
    } finally {
      forgotSubmit.disabled = false;
    }
  });

  // ───────────────────────── dashboard view ─────────────────────────

  function fmtDate(ms) {
    try {
      return new Date(ms).toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });
    } catch { return "—"; }
  }

  function renderDash(user) {
    // `tier` is the entitlement: "plus" when the account may download / sign in
    // to the app (a real Plus, or Basic while the operator has access open).
    // `plan` is the visible subscription level ("basic" by default).
    const plus = user.tier === "plus";
    const plan = user.plan === "plus" ? "plus" : "basic";
    // Email must be confirmed before the app can be downloaded / used.
    const verified = user.email_verified !== false;
    // Human plan label from the server: "Developer" / "Plus" / "Basic With Access"
    // / "Basic". Falls back gracefully if an older API hasn't sent it yet.
    const planLabel = user.plan_label || (plan === "plus" ? "Plus" : "Basic");
    // Two-column layout (account info + download) needs the entitled state.
    views.dash.classList.toggle("is-plus", plus);
    const badge = $("dash-tier");
    badge.textContent = planLabel;
    badge.classList.toggle("is-plus", plus);
    $("dash-email").textContent = user.email;
    $("sub-tier-line").textContent = plus ? ("Active — " + planLabel) : "Basic — access not open yet";

    const untilRow = $("sub-until-row");
    if (plus && user.plus_until) {
      untilRow.hidden = false;
      $("sub-until").textContent = fmtDate(user.plus_until);
    } else {
      untilRow.hidden = true;
    }

    const createdRow = $("sub-created-row");
    if (user.created_at) {
      createdRow.hidden = false;
      $("sub-created").textContent = fmtDate(user.created_at);
    } else {
      createdRow.hidden = true;
    }

    $("sub-note").textContent = !plus
      ? "Download access for Basic accounts isn't open yet. We'll email you the moment it unlocks — no action needed."
      : !verified
      ? "Please confirm your email address to download Null Space. Open the verification link we emailed you, then refresh this page."
      : "Your account has full access. Download the Null Space macOS app below and sign in with this email and password.";

    // Phone-notifications CTA only for entitled, confirmed users.
    $("notify-cta").hidden = !plus || !verified;

    // Desktop-app download for every entitled account (everyone during the beta) —
    // but only once the email is confirmed.
    const dlPanel = $("download-panel");
    dlPanel.hidden = !plus || !verified;
    if (plus && verified) loadDownload();

    // Verification banner until the email is confirmed.
    $("verify-banner").hidden = verified;
    setMsg($("verify-msg"), "");
  }

  // ───────────────────────── desktop download (Plus) ─────────────────────────
  // Fetches a personal, short-lived install command from the API. We deliver via
  // curl on purpose: command-line downloads set no macOS quarantine flag, so the
  // app opens without a Gatekeeper block — and the build stays behind auth.

  async function loadDownload() {
    const cmdEl = $("dl-cmd");
    const copyBtn = $("dl-copy");
    copyBtn.disabled = true;
    copyBtn.classList.remove("is-done");
    $("dl-copy-label").textContent = "Copy install command";
    cmdEl.textContent = "Preparing your download…";
    try {
      const data = await api("/v1/download/macos", { auth: true });
      $("dl-version").textContent = data.version ? "v" + data.version : "";
      cmdEl.textContent = data.command;
      copyBtn.disabled = false;
    } catch (err) {
      // Surface a specific reason when the server gives one (e.g. email not
      // confirmed yet), otherwise a generic retry hint.
      cmdEl.textContent = (err && err.message)
        ? err.message
        : "Could not prepare a download link. Please refresh the page and try again.";
    }
  }

  $("dl-copy").addEventListener("click", async () => {
    const text = $("dl-cmd").textContent || "";
    const btn = $("dl-copy");
    const label = $("dl-copy-label");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for browsers without the async clipboard API.
      const r = document.createRange();
      r.selectNodeContents($("dl-cmd"));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      try { document.execCommand("copy"); } catch {}
      sel.removeAllRanges();
    }
    btn.classList.add("is-done");
    label.textContent = "Copied to clipboard";
    setTimeout(() => { btn.classList.remove("is-done"); label.textContent = "Copy install command"; }, 1800);
  });

  // resend verification email
  const resendBtn = $("resend-verify");
  resendBtn.addEventListener("click", async () => {
    resendBtn.disabled = true;
    setMsg($("verify-msg"), "Sending…");
    try {
      const data = await api("/v1/auth/resend", { method: "POST", auth: true });
      setMsg($("verify-msg"),
        data.already ? "Email is already verified." :
        data.emailed === false ? "Failed to send email. Please try again later." :
        "Verification email sent — please check your inbox.",
        data.emailed === false ? "err" : "ok");
    } catch (err) {
      setMsg($("verify-msg"), err.message, "err");
    } finally {
      resendBtn.disabled = false;
    }
  });

  $("logout-btn").addEventListener("click", () => {
    setToken("");
    setMode("login");
    emailInput.value = "";
    passInput.value = "";
    show("auth");
  });

  // change password
  const passForm = $("pass-form");
  const passMsg = $("pass-msg");
  $("change-pass").addEventListener("click", () => { passForm.hidden = !passForm.hidden; });
  passForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const current = $("p-current").value;
    const next = $("p-next").value;
    if (next.length < 8) { setMsg(passMsg, "New password must be at least 8 characters long.", "err"); return; }
    try {
      await api("/v1/auth/password", { method: "POST", auth: true, body: { current, next } });
      setMsg(passMsg, "Password updated.", "ok");
      $("p-current").value = ""; $("p-next").value = "";
    } catch (err) {
      setMsg(passMsg, err.message, "err");
    }
  });

  // ───────────────────────── boot ─────────────────────────

  async function boot() {
    const defaultMode = location.hash === "#register" ? "register" : "login";
    setMode(defaultMode);
    if (!token()) { show("auth"); return; }
    try {
      const data = await api("/v1/auth/me", { auth: true });
      renderDash(data.user);
      show("dash");
    } catch {
      setToken(""); // stale/invalid token
      show("auth");
    }
  }

  boot();
})();
