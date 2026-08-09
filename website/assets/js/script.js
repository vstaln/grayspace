/* Null Space — site interactions
   Kept tiny and dependency-free: nav state, scroll reveals, a drifting star field. */

// current year in footer
const yearEl = document.getElementById("year");
if (yearEl) yearEl.textContent = new Date().getFullYear();

// nav background after scroll
const nav = document.getElementById("nav");
const onScroll = () => nav && nav.classList.toggle("scrolled", window.scrollY > 12);
onScroll();
window.addEventListener("scroll", onScroll, { passive: true });

// mobile nav — hamburger toggles the dropdown card (same data-open contract as the homepage)
(function mobileNav() {
  const toggle = document.getElementById("nav-toggle");
  const links = document.getElementById("nav-links");
  if (!toggle || !nav || !links) return;

  const setOpen = (open) => {
    nav.setAttribute("data-open", open ? "1" : "0");
    toggle.setAttribute("aria-expanded", String(open));
  };

  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(nav.getAttribute("data-open") !== "1");
  });
  // close after picking a destination
  links.addEventListener("click", (e) => { if (e.target.closest("a")) setOpen(false); });
  // close when tapping elsewhere or pressing Escape
  document.addEventListener("click", (e) => {
    if (nav.getAttribute("data-open") === "1" && !nav.contains(e.target)) setOpen(false);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); });
})();

// scroll-reveal
const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
if (!reduce && "IntersectionObserver" in window) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
  );
  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
} else {
  document.querySelectorAll(".reveal").forEach((el) => el.classList.add("in"));
}

// count-up animation for [data-count] (e.g. the "17 surfaces" figure)
(function counters() {
  const els = [...document.querySelectorAll("[data-count]")];
  if (!els.length) return;
  if (reduce || !("IntersectionObserver" in window)) {
    els.forEach((el) => { el.textContent = el.getAttribute("data-count"); });
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target, target = parseInt(el.getAttribute("data-count"), 10);
      let t0 = null;
      const step = (ts) => {
        if (t0 === null) t0 = ts;
        const p = Math.min((ts - t0) / 1100, 1), eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(eased * target);
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      io.unobserve(el);
    }
  }, { threshold: 0.6 });
  els.forEach((el) => io.observe(el));
})();

// hero product shot — gentle 3D tilt that flattens as it scrolls into view,
// with the floating spec chips drifting at their own depth.
(function heroParallax() {
  const shot = document.getElementById("heroShot");
  if (!shot || reduce) return;
  const chips = [...document.querySelectorAll(".shot-chip")];
  let ticking = false;
  const frame = () => {
    const rect = shot.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, 1 - (rect.top + rect.height * 0.35) / window.innerHeight));
    const tilt = (1 - p) * 12, lift = (1 - p) * 40, scale = 0.97 + p * 0.03;
    shot.style.transform = `translateY(${-lift}px) rotateX(${tilt.toFixed(2)}deg) scale(${scale.toFixed(3)})`;
    chips.forEach((c, i) => {
      c.style.transform = `translateY(${((p - 0.5) * (i + 1) * 10).toFixed(1)}px)`;
    });
    ticking = false;
  };
  const req = () => { if (!ticking) { ticking = true; requestAnimationFrame(frame); } };
  window.addEventListener("scroll", req, { passive: true });
  window.addEventListener("resize", req, { passive: true });
  frame();
})();

// notify / early-access signup → inline form + POST /api/subscribe (Cloudflare Pages Function)
(function notifyForm() {
  const form = document.getElementById("notify");
  if (!form) return;

  const nameInput = document.getElementById("notify-name");
  const emailInput = document.getElementById("notify-email");
  const submit = document.getElementById("notify-submit");
  const msg = document.getElementById("notify-msg");
  const success = document.getElementById("notify-success");
  const successMsg = document.getElementById("notify-success-msg");
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  let busy = false;

  const setMsg = (text, kind) => {
    msg.textContent = text || "";
    msg.className = "notify-msg" + (kind ? " is-" + kind : "");
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;

    const name = nameInput.value.trim();
    const email = emailInput.value.trim();
    if (!name) { setMsg("Please enter your name.", "err"); nameInput.focus(); return; }
    if (!EMAIL_RE.test(email)) { setMsg("Please enter a valid email address.", "err"); emailInput.focus(); return; }

    busy = true;
    submit.disabled = true;
    form.classList.add("is-busy");
    setMsg("");

    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, company: form.company.value, ref: "beta" }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.ok) {
        const first = name.split(/\s+/)[0];
        // Only promise an inbox check when the backend actually sent the email.
        successMsg.textContent = data.already
          ? "You're already on the list — we'll be in touch the moment public access opens."
          : data.emailed
            ? `Thanks, ${first}. Check your inbox for a note from us — we'll email you the moment public access opens.`
            : `Thanks, ${first}. You're on the list — we'll email you the moment public access opens.`;
        form.hidden = true;
        success.hidden = false;
      } else {
        setMsg(data.error || "Something went wrong. Please try again.", "err");
      }
    } catch {
      setMsg("Network error — please try again.", "err");
    } finally {
      busy = false;
      submit.disabled = false;
      form.classList.remove("is-busy");
    }
  });
})();

// magnetic buttons — same micro-interaction as the homepage CTAs
(function magnetic() {
  if (reduce || "ontouchstart" in window) return;
  document.querySelectorAll(".magnetic").forEach((btn) => {
    btn.addEventListener("mousemove", (e) => {
      const r = btn.getBoundingClientRect();
      const dx = (e.clientX - r.left - r.width / 2) / r.width;
      const dy = (e.clientY - r.top - r.height / 2) / r.height;
      btn.style.transform = `translate(${dx * 7}px,${dy * 6}px)`;
    });
    btn.addEventListener("mouseleave", () => { btn.style.transform = ""; });
  });
})();

// drifting star field — same sky as the homepage (nextgen.js). Under
// prefers-reduced-motion the stars still render, just static: every page keeps
// the cosmos, only the drift and twinkle stop.
(function stars() {
  const canvas = document.getElementById("stars");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, pts = [];
  const DPR = Math.min(window.devicePixelRatio || 1, 2);

  function resize() {
    W = innerWidth; H = innerHeight;
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const count = Math.round(230 * Math.min(1, W / 900));
    pts = Array.from({ length: count }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      z: 0.15 + Math.random() * 0.85,
      tw: Math.random() * Math.PI * 2,
    }));
    if (reduce) draw(0); // static sky: paint once per layout
  }

  function draw(t) {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#E5E7EB";
    for (const p of pts) {
      const twk = reduce ? 1 : 0.75 + 0.25 * Math.sin(t * 0.0014 + p.tw);
      ctx.globalAlpha = (0.25 + 0.65 * p.z) * twk;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 0.5 + p.z * 1.1, 0, 6.2832);
      ctx.fill();
      if (!reduce) {
        p.y += 0.09 * (0.4 + p.z);
        if (p.y > H + 24) { p.y = -14; p.x = Math.random() * W; }
      }
    }
    ctx.globalAlpha = 1;
    if (!reduce) requestAnimationFrame(draw);
  }

  addEventListener("resize", resize, { passive: true });
  resize();
  if (!reduce) requestAnimationFrame(draw);
})();
