# Portfolio Website Design — Minimal Modern

**Date:** 2026-08-31
**Project:** `C:\Users\user\Desktop\dd`
**Task:** plan-1788173492871-1 — "please build me webiste"
**Type:** Architectural (new project, greenfield)

## 1. Summary
Build a minimal, modern personal portfolio website as a zero-dependency static site (HTML/CSS/JS). Target: fast load, fully responsive, accessible, easy to edit and host anywhere (GitHub Pages, Netlify, Vercel).

## 2. Requirements

### 2.1 User intent (from clarification)
- Type: Portfolio / Personal
- Scope: Minimal — Hero, About, Projects, Contact (+Footer)
- Style: Modern Minimal, HTML/CSS/JS (no build step)
- Target dir: `C:\Users\user\Desktop\dd` (empty)

### 2.2 Functional
- Single-page smooth-scroll navigation with active-section highlight
- Responsive nav (hamburger on <768px)
- Hero with name, role, tagline, CTA (View Projects / Contact)
- About: bio placeholder + skill chips (editable)
- Projects: 6 cards (title, description, tags, image placeholder, GitHub + Live links)
- Contact: form with frontend validation, success toast, social links
- Footer: copyright + back-to-top

### 2.3 Non-functional
- No build tools, no npm required
- Mobile-first, 320px–1440px, Lighthouse-friendly
- Semantic HTML5, accessible (landmarks, labels, keyboard nav, contrast)
- Performance: <50KB CSS+JS gzipped target, system/Inter fonts
- Works by opening `index.html` or via `npx serve`

## 3. Approaches Considered

| # | Approach | Pros | Cons | Verdict |
|---|----------|------|------|---------|
| 1 | Pure HTML/CSS/JS single-page | Zero deps, instant, portable, trivial edit | Manual CSS, no HMR | **RECOMMENDED** |
| 2 | Tailwind CSS (CDN or build) | Utility speed, consistent | CDN purge or Node build complexity | Rejected — overkill for minimal |
| 3 | React + Vite SPA | Component reuse, HMR | Bundle size, build step, overkill for 4 sections | Rejected — YAGNI |

Recommendation rationale: For minimal scope, Approach 1 maximizes portability and minimizes friction; can migrate to 2/3 later without rewrite.

## 4. Architecture

```
C:\Users\user\Desktop\dd\
  index.html
  css/
    style.css   — variables, reset, layout, components, responsive, animations
  js/
    main.js     — nav toggle, smooth scroll, scroll spy, reveal, form
  assets/
    (optional placeholders — using CSS gradients + inline SVG, no binaries required)
```

No server, no bundler. Pure static.

## 5. Component Design

### 5.1 HTML (index.html)
- `<header>` sticky nav: logo `JD` + links (About, Projects, Contact) + CTA button
- `<main>` sections: `#hero`, `#about`, `#projects`, `#contact`
- Hero: `h1` + `p` tagline + 2 CTAs + availability badge
- About: 2-col (bio + stats / skill grid)
- Projects: `grid 3-col -> 1-col` cards
- Contact: `form` (name, email, message) + socials column
- Footer + toast container
- Fonts: Inter via Google Fonts, fallback system

### 5.2 CSS (css/style.css)
- `:root` tokens: colors (slate + blue accent), radius, shadow, max-width 1100px
- Reset + base + utilities
- Header sticky with backdrop-filter
- Sections: padding 96px vertical, scroll-margin
- Cards: border, radius 16px, hover lift
- Animations: `reveal` (opacity + translateY, IntersectionObserver triggers `.visible`)
- Media queries: 900px, 768px, 480px

### 5.3 JS (js/main.js)
- `navToggle()` — hamburger open/close, aria-expanded, close on link click / outside / Esc
- `smoothScroll` — CSS `scroll-behavior:smooth` + JS offset for header height fallback
- `scrollSpy()` — IntersectionObserver to set `.active` on nav links
- `revealOnScroll()` — Observer adds `.visible` to `.reveal` elements
- `handleForm()` — preventDefault, trim/validate (required, email regex, min length), show field errors, show toast, reset
- `toast(msg, type)` — transient top-right notification
- Header shadow on scroll, footer year injection

## 6. Data Flow
- No external data. Projects hardcoded as HTML cards for easy edit (no JSON needed for minimal scope). Comments mark where to duplicate a card.
- Form does not POST; displays success toast. Comment notes integration point for Formspree/Netlify.

## 7. Error Handling & Edge Cases
- JS fails? Site remains navigable (CSS smooth scroll + hash links work without JS)
- Invalid form: inline field errors, focus first invalid
- No JS: mobile menu fallback — nav visible as horizontal scroll (CSS only)
- Images: CSS gradient + SVG placeholders, no broken img

## 8. Testing & Verification
- Manual: open index.html, check responsive (320, 768, 1024, 1440)
- Validate HTML (W3C), contrast audit
- Keyboard: Tab through nav, form, Esc closes menu
- No automated tests for static site (add Playwright later if needed)

## 9. Future Extensions (out of scope, not YAGNI now)
- Dark mode toggle (prefers-color-scheme already respected via tokens)
- CMS/JSON for projects
- Blog section
- i18n

## 10. Self-Review
- Placeholders: No TBD/TODO beyond intentional edit comments; all sections specified.
- Consistency: HTML ids match nav hrefs; file paths relative; no contradictions.
- Scope: Single plan task, 3 files, clear bound.
- Ambiguity: Colors, fonts, copy explicitly chosen with sensible defaults; user can edit text directly.

## 11. Approval
Approved via in-app question 2026-08-31: "Yes, Build It" for Approach 1 (Modern Minimal + HTML/CSS/JS).
