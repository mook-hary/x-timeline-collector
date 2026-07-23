/**
 * EP-022/023/024 — Digest Reader CSS.
 * Information hierarchy for morning skim. No external fonts/JS.
 */

const DIGEST_READER_CSS = `/* Timeline Digest Reader — EP-024 */
:root {
  --ink: #1a2228;
  --ink-soft: #5a6670;
  --paper: #f2f4f1;
  --surface: #fbfcfb;
  --line: #d3dbd5;
  --accent: #0c6b66;
  --accent-soft: rgba(12, 107, 102, 0.12);
  --chip: #e8eeea;
  --star: #7a7264;
  --shadow: 0 10px 28px rgba(26, 34, 40, 0.06);
  --radius: 16px;
  --font-display: "Iowan Old Style", "Palatino Linotype", Palatino, "Hiragino Mincho ProN", "Yu Mincho", Georgia, serif;
  --font-body: "Hiragino Mincho ProN", "Yu Mincho", "Source Han Serif JP", Georgia, serif;
  --font-ui: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Segoe UI", "Noto Sans JP", sans-serif;
  --max: 44rem;
  --gutter: 1rem;
  --tap: 44px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --ink: #e8eeea;
    --ink-soft: #9aa6ae;
    --paper: #12171a;
    --surface: #1a2126;
    --line: #2c363c;
    --accent: #6ec4be;
    --accent-soft: rgba(110, 196, 190, 0.16);
    --chip: #243036;
    --star: #a39a8c;
    --shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
  }
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

html {
  -webkit-text-size-adjust: 100%;
  overflow-x: hidden;
  scroll-behavior: smooth;
}

body {
  margin: 0;
  color: var(--ink);
  background:
    radial-gradient(900px 420px at 8% -8%, rgba(12, 107, 102, 0.08), transparent 55%),
    radial-gradient(700px 360px at 100% 0%, rgba(26, 34, 40, 0.04), transparent 50%),
    var(--paper);
  font-family: var(--font-body);
  font-size: 1.05rem;
  line-height: 1.75;
  overflow-x: hidden;
}

a {
  color: var(--accent);
  text-underline-offset: 0.14em;
}

.wrap {
  width: min(100% - (var(--gutter) * 2), var(--max));
  margin-inline: auto;
}

.site-header {
  padding: 1.75rem 0 1.15rem;
  border-bottom: 2px solid var(--ink);
  margin-bottom: 1.1rem;
}

.kicker {
  margin: 0 0 0.35rem;
  font-family: var(--font-ui);
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-soft);
}

.site-header h1 {
  margin: 0;
  font-family: var(--font-display);
  font-size: clamp(1.75rem, 5vw, 2.35rem);
  font-weight: 700;
  line-height: 1.12;
  letter-spacing: -0.02em;
}

.metrics {
  margin: 1rem 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 0.55rem 1rem;
  font-family: var(--font-ui);
}

.metrics li {
  display: inline-flex;
  align-items: center;
}

.metrics__value {
  display: inline-block;
  padding: 0.35rem 0.75rem;
  border-radius: 999px;
  background: var(--surface);
  border: 1px solid var(--line);
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--ink);
}

.meta {
  margin: 0.75rem 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 0.85rem;
  font-family: var(--font-ui);
  font-size: 0.8rem;
  color: var(--ink-soft);
}

.meta--secondary {
  opacity: 0.92;
}

.meta li {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}

.badge {
  display: inline-block;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 0.7rem;
  font-weight: 700;
}

.cat-nav {
  margin: 0 0 1.25rem;
  padding: 0.65rem 0 0;
}

.cat-nav__label {
  margin: 0 0 0.45rem;
  font-family: var(--font-ui);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-soft);
}

.cat-nav__list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin: 0;
  padding: 0;
  list-style: none;
  max-width: 100%;
}

.cat-nav__list a {
  display: inline-flex;
  align-items: center;
  min-height: 2rem;
  padding: 0.3rem 0.65rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  font-family: var(--font-ui);
  font-size: 0.78rem;
  color: var(--ink);
  text-decoration: none;
  max-width: 100%;
}

.cat-nav__list a:hover,
.cat-nav__list a:focus-visible {
  border-color: var(--accent);
  color: var(--accent);
  outline: none;
}

.cat-nav__more {
  border-style: dashed !important;
}

.section {
  margin: 0 0 1.85rem;
}

.section__label {
  margin: 0 0 0.75rem;
  font-family: var(--font-ui);
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-soft);
}

.section--top .section__label {
  color: var(--accent);
  font-size: 0.82rem;
}

.overview,
.brief {
  padding: 0.95rem 1.05rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow);
}

.overview__stats {
  margin: 0 0 0.75rem;
  padding: 0;
  list-style: none;
  font-family: var(--font-ui);
  font-size: 0.92rem;
}

.overview__stats li {
  margin: 0 0 0.28rem;
}

.overview__stats li::before {
  content: "・";
  color: var(--accent);
  margin-right: 0.1rem;
}

.overview__sublabel {
  margin: 0 0 0.4rem;
  font-family: var(--font-ui);
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--ink-soft);
}

.highlights,
.brief__lines {
  margin: 0;
  padding: 0;
  list-style: none;
  font-family: var(--font-ui);
  font-size: 0.92rem;
  line-height: 1.55;
}

.highlights li,
.brief__lines li {
  margin: 0 0 0.35rem;
  padding-left: 0.05rem;
}

.highlights li::before,
.brief__lines li::before {
  content: "・";
  color: var(--accent);
  margin-right: 0.1rem;
}

.card {
  margin: 0 0 0.95rem;
  padding: 1.1rem 1.15rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow);
  overflow-wrap: anywhere;
  word-break: break-word;
}

.card:last-child {
  margin-bottom: 0;
}

.card--top {
  padding: 1.3rem 1.3rem 1.2rem;
  border-color: rgba(12, 107, 102, 0.28);
  box-shadow: 0 14px 34px rgba(26, 34, 40, 0.08);
}

.card__category {
  margin: 0 0 0.55rem;
  font-family: var(--font-ui);
  font-size: 0.78rem;
  font-weight: 700;
  color: var(--accent);
}

.card__summary {
  margin: 0 0 0.7rem;
  font-size: 1.06rem;
  line-height: 1.8;
  white-space: pre-wrap;
}

.card__body {
  margin: 0 0 0.7rem;
  font-size: 0.98rem;
  line-height: 1.75;
  color: var(--ink-soft);
  white-space: pre-wrap;
}

.card__reason {
  margin: 0 0 0.7rem;
  font-family: var(--font-ui);
  font-size: 0.82rem;
  line-height: 1.55;
  color: var(--ink-soft);
}

.card--top .card__summary {
  font-size: 1.16rem;
  line-height: 1.85;
}

.card__importance {
  margin: 0 0 0.85rem;
  font-family: var(--font-ui);
  font-size: 0.72rem;
  color: var(--ink-soft);
}

.card__importance-label {
  font-weight: 600;
}

.card__stars {
  color: var(--star);
  letter-spacing: 0.1em;
  font-size: 0.7rem;
  opacity: 0.85;
}

.card__actions {
  margin: 0;
  font-family: var(--font-ui);
}

.btn-source {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: var(--tap);
  padding: 0.45rem 1rem;
  border-radius: 999px;
  background: var(--accent);
  color: #fff !important;
  font-weight: 700;
  font-size: 0.88rem;
  text-decoration: none !important;
}

.btn-source:hover,
.btn-source:focus-visible {
  filter: brightness(1.05);
  outline: none;
}

.btn-source--missing {
  display: inline-flex;
  align-items: center;
  min-height: var(--tap);
  padding: 0.45rem 0.95rem;
  border-radius: 999px;
  border: 1px dashed var(--line);
  color: var(--ink-soft);
  font-size: 0.84rem;
}

.empty {
  margin: 0;
  padding: 0.9rem 1rem;
  border: 1px dashed var(--line);
  border-radius: var(--radius);
  color: var(--ink-soft);
  font-family: var(--font-ui);
}

.site-footer {
  margin: 2.5rem 0 2rem;
  padding-top: 1rem;
  border-top: 1px solid var(--line);
  font-family: var(--font-ui);
  font-size: 0.8rem;
  color: var(--ink-soft);
}

.site-footer p {
  margin: 0.15rem 0;
}

@media (max-width: 400px) {
  :root {
    --gutter: 0.8rem;
  }

  body {
    font-size: 1rem;
  }

  .site-header {
    padding-top: 1.25rem;
  }

  .metrics {
    gap: 0.4rem;
  }

  .metrics__value {
    font-size: 0.88rem;
    padding: 0.32rem 0.65rem;
  }

  .overview,
  .brief {
    padding: 0.85rem 0.9rem;
  }

  .card,
  .card--top {
    padding: 1rem;
  }

  .card--top .card__summary,
  .card__summary {
    font-size: 1.05rem;
  }
}
`;

module.exports = {
  DIGEST_READER_CSS,
};
