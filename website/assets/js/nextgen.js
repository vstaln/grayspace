/* ============================================================
   Null Space — nextGen homepage · engine
   Starfield + warp, scroll-scrubbed camera, live canvas demo,
   reveal-on-scroll, magnetic buttons, mobile nav.
   ============================================================ */
(function () {
  "use strict";

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  var lerp = function (a, b, t) { return a + (b - a) * t; };
  var easeIO = function (t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; };
  var seg = function (p, a, b) { return clamp((p - a) / (b - a), 0, 1); };

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- ambient intensity defaults (no tweaks panel in production) ----
  window.NS_TWEAKS = window.NS_TWEAKS || { motion: 1, stars: 1, orbits: 1 };

  /* ══════════════════ STARFIELD ══════════════════ */
  var canvas = $("#stars");
  var ctx = canvas.getContext("2d");
  var orbitsEl = $("#orbits"), lastOrbitOp = -1;
  var W = 0, H = 0, DPR = Math.min(window.devicePixelRatio || 1, 2);
  var stars = [];
  var warp = 0, warpT = 0;       // streak factor
  var dim = 0, dimT = 0;         // dim while reading the canvas scene
  var mx = 0, my = 0, mxT = 0, myT = 0; // cursor parallax

  function buildStars() {
    var count = Math.round(230 * (window.NS_TWEAKS.stars || 1) * Math.min(1, W / 900));
    stars = [];
    for (var i = 0; i < count; i++) {
      stars.push({
        x: Math.random() * W,
        y: Math.random() * H,
        z: 0.15 + Math.random() * 0.85,
        tw: Math.random() * Math.PI * 2
      });
    }
  }
  window.__nsRebuildStars = buildStars;

  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * DPR; canvas.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    buildStars();
  }
  window.addEventListener("resize", resize);
  resize();

  if (!("ontouchstart" in window)) {
    window.addEventListener("mousemove", function (e) {
      mxT = (e.clientX / W - 0.5) * 18;
      myT = (e.clientY / H - 0.5) * 18;
    });
  }

  function drawStars(dt, t) {
    ctx.clearRect(0, 0, W, H);
    var m = window.NS_TWEAKS.motion;
    warp = lerp(warp, warpT, 0.07);
    dim = lerp(dim, dimT, 0.06);
    // orbital rings share the dim — they step back while the scene plays
    var ov = clamp(0.5 * (window.NS_TWEAKS.orbits == null ? 1 : window.NS_TWEAKS.orbits) * (1 - dim * 0.94), 0, 1);
    if (Math.abs(ov - lastOrbitOp) > 0.004) { lastOrbitOp = ov; orbitsEl.style.opacity = String(ov); }
    mx = lerp(mx, mxT, 0.05); my = lerp(my, myT, 0.05);
    var drift = reduced ? 0 : (0.0055 + warp * 0.62) * dt * m;
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      s.y += drift * (0.4 + s.z);
      if (s.y > H + 24) { s.y = -14; s.x = Math.random() * W; }
      var twk = reduced ? 1 : (0.75 + 0.25 * Math.sin(t * 0.0014 + s.tw));
      var a = (0.25 + 0.65 * s.z) * twk * (1 - dim * 0.72);
      var x = s.x + mx * s.z, y = s.y + my * s.z;
      ctx.globalAlpha = a;
      if (warp > 0.04) {
        var len = warp * 70 * (0.3 + s.z);
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = s.z * 1.5;
        ctx.beginPath();
        ctx.moveTo(x, y - len);
        ctx.lineTo(x, y);
        ctx.stroke();
      } else {
        ctx.fillStyle = "#E5E7EB";
        ctx.beginPath();
        ctx.arc(x, y, 0.5 + s.z * 1.1, 0, 6.2832);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  /* ══════════════════ SCROLL PROGRESS ══════════════════ */
  var actHero = $("#act-hero"), actSpace = $("#act-space");

  function rawProg(el) {
    var r = el.getBoundingClientRect();
    var total = el.offsetHeight - window.innerHeight;
    if (total <= 0) return 0;
    return clamp(-r.top / total, 0, 1);
  }

  /* ══════════════════ ACT I · HERO ══════════════════ */
  var heroCore = $("#heroCore"), scrollHint = $("#scrollHint"), nav = $("#nav");
  var enterCue = $("#enterCue");
  var pHero = 0, pSpace = 0;

  function updateHero(p, rawSpace) {
    var k = easeIO(p);
    heroCore.style.transform = "translateY(" + (-k * 9) + "vh) scale(" + (1 + k * 1.1) + ")";
    heroCore.style.opacity = String(1 - clamp(p * 1.55, 0, 1));
    heroCore.style.filter = p > 0.02 ? "blur(" + (k * 10) + "px)" : "none";
    heroCore.style.pointerEvents = p > 0.3 ? "none" : "";
    if (scrollHint) scrollHint.style.opacity = p > 0.04 ? "0" : "1";
    // warp ramps with the dive, releases as the canvas scene arrives
    warpT = reduced ? 0 : clamp(p * 1.5, 0, 1) * (1 - clamp(rawSpace * 5, 0, 1)) * window.NS_TWEAKS.motion;
  }

  /* ══════════════════ ACT II · THE SPACE ══════════════════ */
  var plane = $("#plane");
  var PLANE_W = 2400, PLANE_H = 1500;

  var KF = [
    { p: 0.00, x: 1290, y: 700, z: 1.00 },
    { p: 0.06, x: 1290, y: 700, z: 1.05 },
    { p: 0.16, x: 580, y: 600, z: 2.10 },
    { p: 0.30, x: 580, y: 600, z: 2.10 },
    { p: 0.40, x: 1560, y: 480, z: 1.40 },
    { p: 0.50, x: 1560, y: 500, z: 1.40 },
    { p: 0.58, x: 1560, y: 1000, z: 1.50 },
    { p: 0.66, x: 1560, y: 1000, z: 1.50 },
    { p: 0.76, x: 1290, y: 700, z: 1.00 },
    { p: 1.00, x: 1290, y: 700, z: 0.93 }
  ];

  function camera(p) {
    var a = KF[0], b = KF[KF.length - 1];
    for (var i = 0; i < KF.length - 1; i++) {
      if (p >= KF[i].p && p <= KF[i + 1].p) { a = KF[i]; b = KF[i + 1]; break; }
    }
    var t = b.p === a.p ? 0 : easeIO((p - a.p) / (b.p - a.p));
    var x = lerp(a.x, b.x, t), y = lerp(a.y, b.y, t), z = lerp(a.z, b.z, t);
    var fit = Math.min(W / (PLANE_W - 140), H / (PLANE_H - 60));
    var s = z * fit;
    plane.style.transform = "translate3d(" + (W / 2 - x * s) + "px," + (H / 2 - y * s) + "px,0) scale(" + s + ")";
  }

  // -- terminal typing --
  var TERM_LINES = [
    { t: "❯ npm run dev", c: "" },
    { t: "  VITE v6.0  ready in 312 ms", c: "t-dim" },
    { t: "  ➜  Local:   http://localhost:5173/", c: "t-ok" },
    { t: "", c: "" },
    { t: "❯ git switch -c feat/cables", c: "" },
    { t: "  Switched to a new branch 'feat/cables'", c: "t-dim" },
    { t: "❯ ⌘K → cable: agent → diff", c: "t-acc" }
  ];
  var TERM_TOTAL = TERM_LINES.reduce(function (n, l) { return n + l.t.length + 1; }, 0);
  var termEl = $("#termText"), lastTermCount = -1;

  function renderTerm(k) {
    var count = Math.floor(k * TERM_TOTAL);
    if (count === lastTermCount) return;
    lastTermCount = count;
    var html = "", left = count;
    for (var i = 0; i < TERM_LINES.length; i++) {
      if (left <= 0) break;
      var line = TERM_LINES[i];
      var take = Math.min(line.t.length, left);
      var chunk = line.t.slice(0, take);
      chunk = chunk.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      html += line.c ? '<span class="' + line.c + '">' + chunk + "</span>" : chunk;
      left -= take + 1;
      if (left > 0 || take === line.t.length) html += "\n";
    }
    termEl.innerHTML = html.replace(/\n$/, "") + (k > 0 && k < 1 ? '<span class="caret-i"></span>' : (k >= 1 ? '<span class="caret-i"></span>' : ""));
  }

  // -- git graph draw --
  var lanes = $$(".gitsvg .lane").map(function (el) {
    var len = el.getTotalLength();
    el.style.strokeDasharray = String(len);
    el.style.strokeDashoffset = String(len);
    return { el: el, len: len };
  });
  var gitDots = $$(".gdots circle");
  var gitMsgs = $$(".gmsgs text");

  function updateGit(k) {
    for (var i = 0; i < lanes.length; i++) {
      var local = seg(k, i * 0.18, 0.6 + i * 0.18);
      lanes[i].el.style.strokeDashoffset = String(lanes[i].len * (1 - local));
    }
    gitDots.forEach(function (d, i) { d.classList.toggle("on", k > 0.12 + i * 0.13); });
    gitMsgs.forEach(function (m, i) { m.classList.toggle("on", k > 0.3 + i * 0.16); });
  }

  // -- diff rows --
  var diffRows = $$("#diffBody .dl");
  function updateDiff(k) {
    diffRows.forEach(function (r, i) { r.classList.toggle("on", k > i / diffRows.length); });
  }

  // -- planner + agent --
  var tasks = $$(".task");
  var assignBadge = $("#assignBadge");
  var agentLines = $$("#agentBody .al");
  var agentState = $("#agentState");

  function updatePlan(k) {
    tasks.forEach(function (t, i) {
      if (i < 3) t.classList.toggle("done", k > 0.25 + i * 0.22);
    });
    if (assignBadge) assignBadge.classList.toggle("on", k > 0.85);
  }
  function updateAgent(k) {
    agentLines.forEach(function (l, i) { l.classList.toggle("on", k > 0.1 + i * 0.15); });
    var done = k >= 0.99;
    if (agentState) {
      agentState.classList.toggle("done", done);
      agentState.textContent = done ? "done" : "working";
    }
  }

  // -- cables --
  var flows = ["#flow1", "#flow2", "#flow3"].map(function (id) {
    var el = $(id);
    var len = el.getTotalLength();
    el.style.strokeDasharray = String(len);
    el.style.strokeDashoffset = String(len);
    return { el: el, len: len };
  });
  var cablesSvg = $("#cables");

  function updateCables(k, live) {
    for (var i = 0; i < flows.length; i++) {
      var local = seg(k, i * 0.12, 0.7 + i * 0.12);
      flows[i].el.style.strokeDashoffset = String(flows[i].len * (1 - local));
    }
    cablesSvg.classList.toggle("live", live);
  }

  // -- window highlight + captions --
  var LIT = {
    winTerm: [0.09, 0.345], winGit: [0.355, 0.525], winDiff: [0.39, 0.525],
    winPlan: [0.525, 0.675], winAgent: [0.525, 0.675], winWeb: [0.80, 1.01]
  };
  var litEls = {};
  Object.keys(LIT).forEach(function (id) { litEls[id] = document.getElementById(id); });

  var CAPS = {
    a: [0.01, 0.085], b: [0.10, 0.325], c: [0.355, 0.515],
    d: [0.525, 0.655], e: [0.68, 0.775], f: [0.80, 0.995]
  };
  var capEls = {};
  $$(".cap").forEach(function (el) { capEls[el.getAttribute("data-cap")] = el; });

  function updateSpace(p) {
    camera(p);
    renderTerm(seg(p, 0.10, 0.28));
    updateGit(seg(p, 0.36, 0.50));
    updateDiff(seg(p, 0.40, 0.52));
    updatePlan(seg(p, 0.53, 0.64));
    updateAgent(seg(p, 0.53, 0.66));
    updateCables(seg(p, 0.72, 0.88), p > 0.84 && p < 1.01);
    Object.keys(LIT).forEach(function (id) {
      if (litEls[id]) litEls[id].classList.toggle("lit", p >= LIT[id][0] && p <= LIT[id][1]);
    });
    Object.keys(CAPS).forEach(function (k) {
      if (capEls[k]) capEls[k].classList.toggle("on", p >= CAPS[k][0] && p <= CAPS[k][1]);
    });
  }

  /* ══════════════════ REVEAL ON SCROLL ══════════════════ */
  var revealEls = $$(".reveal");
  if ("IntersectionObserver" in window && !reduced) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("on"); io.unobserve(en.target); }
      });
    }, { threshold: 0.15, rootMargin: "0px 0px -8% 0px" });
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add("on"); });
  }

  /* ══════════════════ MAIN LOOP ══════════════════ */
  function tick(dt, t) {
    var rHero = rawProg(actHero);
    var rSpace = rawProg(actSpace);

    // framerate-independent smoothing
    var sm = reduced ? 1 : 1 - Math.exp(-dt / 110);
    pHero = Math.abs(rHero - pHero) < 0.0004 ? rHero : lerp(pHero, rHero, sm);
    pSpace = Math.abs(rSpace - pSpace) < 0.0004 ? rSpace : lerp(pSpace, rSpace, sm);

    updateHero(pHero, rSpace);
    updateSpace(pSpace);

    // Handoff guidance: once the hero has dissolved but the canvas scene hasn't
    // started narrating (no caption up yet, including the slide-in where pSpace
    // is still pinned at 0), surface the "keep scrolling" cue so the empty void
    // never reads as the end of the page.
    if (enterCue) enterCue.classList.toggle("show", pHero > 0.5 && pSpace < 0.01);

    // dim stars while reading the canvas scene
    dimT = (rSpace > 0.001 && rSpace < 0.999) ? 0.85 : 0;

    nav.classList.toggle("scrolled", window.scrollY > 40);

    drawStars(dt, t);
  }

  var last = performance.now();
  function frame(t) {
    var dt = Math.min(t - last, 120); last = t;
    tick(dt, t);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /* ══════════════════ HERO LOAD-IN (GSAP) ══════════════════ */
  // One orchestrated timeline owns the first impression; the camera/scroll
  // engine (updateHero) only touches #heroCore, so animating its children here
  // never collides. `.pre-anim` (set in CSS, gated on no-preference) keeps the
  // cast hidden until GSAP takes over — no flash, no double animation.
  (function () {
    var gsap = window.gsap;
    var unpin = function () { document.body.classList.remove("pre-anim"); };
    // No GSAP, reduced motion, or a reload landing past the hero → just reveal.
    if (!gsap || reduced || window.scrollY > 40) { unpin(); return; }

    var heroWords = $$(".ht-w");
    var ctaBtns = $$(".hero-cta > *");
    var tl = gsap.timeline({
      defaults: { ease: "power3.out" },
      onComplete: function () {
        unpin();
        gsap.set(ctaBtns, { clearProps: "transform" }); // hand transform back to the magnet
      }
    });
    tl.fromTo("#nav", { autoAlpha: 0, y: -14 }, { autoAlpha: 1, y: 0, duration: 0.7 })
      .fromTo(".brand-mark", { autoAlpha: 0, scale: 0.55 }, { autoAlpha: 1, scale: 1, duration: 0.6, ease: "back.out(2.2)" }, "<0.05")
      .fromTo(".eyebrow", { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0, duration: 0.6 }, "-=0.3")
      .fromTo(heroWords, { autoAlpha: 0, yPercent: 110 }, { autoAlpha: 1, yPercent: 0, duration: 0.95, ease: "power4.out", stagger: 0.065 }, "-=0.2")
      .fromTo(".hero-sub", { autoAlpha: 0, y: 16 }, { autoAlpha: 1, y: 0, duration: 0.7 }, "-=0.6")
      .fromTo(ctaBtns, { autoAlpha: 0, y: 18, scale: 0.96 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.6, ease: "back.out(1.5)", stagger: 0.1 }, "-=0.4")
      .fromTo(".hero-note", { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.5 }, "-=0.3");
  })();

  /* ══════════════════ MAGNETIC BUTTONS ══════════════════ */
  if (!("ontouchstart" in window) && !reduced) {
    var gsapM = window.gsap;
    $$(".magnetic").forEach(function (btn) {
      if (gsapM) {
        // GSAP smooths the pull (quickTo) so the button trails the cursor with weight.
        var xTo = gsapM.quickTo(btn, "x", { duration: 0.4, ease: "power3" });
        var yTo = gsapM.quickTo(btn, "y", { duration: 0.4, ease: "power3" });
        btn.addEventListener("mousemove", function (e) {
          var r = btn.getBoundingClientRect();
          xTo(((e.clientX - r.left) / r.width - 0.5) * 14);
          yTo(((e.clientY - r.top) / r.height - 0.5) * 12);
        });
        btn.addEventListener("mouseleave", function () { xTo(0); yTo(0); });
      } else {
        btn.addEventListener("mousemove", function (e) {
          var r = btn.getBoundingClientRect();
          var dx = (e.clientX - r.left - r.width / 2) / r.width;
          var dy = (e.clientY - r.top - r.height / 2) / r.height;
          btn.style.transform = "translate(" + dx * 7 + "px," + dy * 6 + "px)";
        });
        btn.addEventListener("mouseleave", function () { btn.style.transform = ""; });
      }
    });
  }

  /* ══════════════════ MOBILE NAV ══════════════════ */
  var navToggle = $("#nav-toggle"), navLinks = $("#nav-links");
  if (navToggle && nav) {
    var setNav = function (open) {
      nav.setAttribute("data-open", open ? "1" : "0");
      navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    };
    navToggle.addEventListener("click", function () {
      setNav(nav.getAttribute("data-open") !== "1");
    });
    if (navLinks) {
      navLinks.addEventListener("click", function (e) {
        if (e.target.closest("a")) setNav(false);
      });
    }
  }

  /* ══════════════════ SURFACE SWITCHBOARD (Act III) ══════════════════ */
  (function () {
    var root = $("#sx");
    if (!root) return;
    var items = $$("#sx .sx-item");
    var prevs = $$("#sx .sx-prev");
    var title = $("#sxTitle"), count = $("#sxCount");
    var descK = $("#sxDescK"), descT = $("#sxDescT");
    var prog = $("#sxProg");
    if (items.length !== prevs.length) return;

    var CYCLE = 4600;
    var idx = 0, timer = null, inView = false, hover = false;
    var GROUPS = [[0, "Core surfaces"], [9, "Source control"], [13, "AI agents"]];

    function pad(n) { return (n < 10 ? "0" : "") + n; }
    function groupOf(i) {
      var g = GROUPS[0][1];
      GROUPS.forEach(function (p) { if (i >= p[0]) g = p[1]; });
      return g;
    }
    function restartProg() {
      if (!prog) return;
      prog.style.animation = "none";
      void prog.offsetWidth;
      prog.style.animation = "";
    }
    function show(i) {
      idx = (i + items.length) % items.length;
      items.forEach(function (b, j) {
        b.classList.toggle("act", j === idx);
        b.setAttribute("aria-pressed", j === idx ? "true" : "false");
      });
      prevs.forEach(function (p, j) {
        p.classList.toggle("act", j === idx);
        p.setAttribute("aria-hidden", j === idx ? "false" : "true");
      });
      var b = items[idx];
      title.textContent = b.getAttribute("data-title");
      count.textContent = pad(idx + 1) + " / " + pad(items.length);
      descK.textContent = groupOf(idx) + " · " + pad(idx + 1);
      descT.textContent = b.getAttribute("data-desc");
      restartProg();
    }
    function schedule() {
      clearInterval(timer); timer = null;
      if (!reduced && inView && !hover && !document.hidden) {
        timer = setInterval(function () { show(idx + 1); }, CYCLE);
        restartProg();
      }
      root.classList.toggle("live", !!timer);
    }

    items.forEach(function (b, j) {
      b.addEventListener("click", function () { show(j); });
      b.addEventListener("mouseenter", function () { show(j); });
      b.addEventListener("focus", function () { show(j); });
    });
    // autoplay pauses while the pointer explores the switchboard
    root.addEventListener("mouseenter", function () { hover = true; schedule(); });
    root.addEventListener("mouseleave", function () { hover = false; schedule(); });
    document.addEventListener("visibilitychange", schedule);

    if ("IntersectionObserver" in window) {
      var sio = new IntersectionObserver(function (ents) {
        inView = ents[0].isIntersecting; schedule();
      }, { threshold: 0.25 });
      sio.observe(root);
    } else { inView = true; schedule(); }

    show(0);
  })();

  /* ══════════════════ MISC ══════════════════ */
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  // smooth-scroll same-page anchors
  $$('a[href^="#"]').forEach(function (a) {
    a.addEventListener("click", function (e) {
      var href = a.getAttribute("href");
      if (href === "#" || href.length < 2) return;
      var target = document.querySelector(href);
      if (!target) return;
      e.preventDefault();
      window.scrollTo({ top: target.offsetTop, behavior: reduced ? "auto" : "smooth" });
    });
  });
})();
