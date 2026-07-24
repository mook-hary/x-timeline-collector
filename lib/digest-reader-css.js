/**
 * EP-022–036 — Digest Reader CSS.
 * Visual hierarchy + aligned columns. Body font-size unchanged.
 */

const DIGEST_READER_CSS = `/* Timeline Digest Reader — EP-036 */
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
  --shadow: 0 6px 18px rgba(26, 34, 40, 0.05);
  --radius: 12px;
  --font-display: "Iowan Old Style", "Palatino Linotype", Palatino, "Hiragino Mincho ProN", "Yu Mincho", Georgia, serif;
  --font-body: "Hiragino Mincho ProN", "Yu Mincho", "Source Han Serif JP", Georgia, serif;
  --font-ui: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Segoe UI", "Noto Sans JP", sans-serif;
  --max: 46rem;
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
    --shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
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
  line-height: 1.65;
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
  padding: 1.25rem 0 0.75rem;
  border-bottom: 2px solid var(--ink);
  margin-bottom: 1rem;
}

.kicker {
  margin: 0 0 0.25rem;
  font-family: var(--font-ui);
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-soft);
}

.site-header h1 {
  margin: 0;
  font-family: var(--font-display);
  font-size: clamp(1.65rem, 4.5vw, 2.15rem);
  font-weight: 700;
  line-height: 1.12;
  letter-spacing: -0.02em;
}

.metrics {
  margin: 0.75rem 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem 0.85rem;
  font-family: var(--font-ui);
}

.metrics li {
  display: inline-flex;
  align-items: center;
}

.metrics__value {
  display: inline-block;
  padding: 0.28rem 0.65rem;
  border-radius: 999px;
  background: var(--surface);
  border: 1px solid var(--line);
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--ink);
}

.meta {
  margin: 0.55rem 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 0.75rem;
  font-family: var(--font-ui);
  font-size: 0.78rem;
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
  padding: 0.12rem 0.45rem;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 0.68rem;
  font-weight: 700;
}

.cat-nav {
  margin: 0 0 1.15rem;
  padding: 0.15rem 0 0;
}

.cat-nav__label {
  margin: 0 0 0.35rem;
  font-family: var(--font-ui);
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-soft);
}

.cat-nav__list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin: 0;
  padding: 0;
  list-style: none;
  max-width: 100%;
}

.cat-nav__list a {
  display: inline-flex;
  align-items: center;
  min-height: var(--tap);
  padding: 0.28rem 0.65rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  font-family: var(--font-ui);
  font-size: 0.76rem;
  color: var(--ink);
  text-decoration: none;
  max-width: 100%;
}

.cat-nav__list a:hover,
.cat-nav__list a:focus-visible {
  border-color: var(--accent);
  color: var(--accent);
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.cat-nav__list a:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.cat-nav__more {
  border-style: dashed !important;
}

.section {
  margin: 0 0 1.15rem;
}

.section__label {
  margin: 0 0 0.45rem;
  font-family: var(--font-ui);
  font-size: 0.76rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-soft);
}

.section--top .section__label {
  color: var(--accent);
  font-size: 0.88rem;
  letter-spacing: 0.04em;
}

/* Morning Brief — aligned to wrap, compact card */
.section--brief {
  width: 100%;
  max-width: none;
  margin-inline: 0;
}

.section--brief .section__label {
  font-size: 0.8rem;
  color: var(--ink);
}

.overview,
.brief {
  padding: 0.55rem 0.85rem;
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
  line-height: 1.45;
}

.highlights li,
.brief__lines li {
  display: flex;
  gap: 0.35rem;
  margin: 0 0 0.18rem;
  padding: 0;
  align-items: flex-start;
}

.highlights li:last-child,
.brief__lines li:last-child {
  margin-bottom: 0;
}

.highlights li::before,
.brief__lines li::before {
  content: "・";
  color: var(--accent);
  flex: 0 0 auto;
  line-height: 1.45;
}

/* Today's Picks — title / summary / why hierarchy */
.picks-list {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.card {
  margin: 0 0 0.55rem;
  padding: 0.7rem 0.85rem;
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

.card--top,
.card--pick {
  margin: 0;
  padding: 0.7rem 0.85rem 0.65rem;
  border-color: rgba(12, 107, 102, 0.32);
  box-shadow: 0 8px 22px rgba(26, 34, 40, 0.07);
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.card__category {
  margin: 0;
  font-family: var(--font-ui);
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--accent);
  letter-spacing: 0.02em;
}

.card__title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 1.16rem;
  font-weight: 700;
  line-height: 1.35;
  letter-spacing: -0.01em;
  color: var(--ink);
}

.card__summary {
  margin: 0;
  font-size: 0.98rem;
  line-height: 1.5;
  color: var(--ink);
  white-space: pre-wrap;
}

.card--pick .card__summary {
  font-family: var(--font-body);
  font-size: 0.95rem;
  font-weight: 400;
  line-height: 1.5;
  color: var(--ink-soft);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  overflow: hidden;
  white-space: normal;
}

.card__why {
  margin: 0.15rem 0 0;
  padding-top: 0.45rem;
  border-top: 1px solid var(--line);
}

.card__why-label {
  margin: 0 0 0.15rem;
  font-family: var(--font-ui);
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--ink-soft);
}

.card__why-text {
  margin: 0;
  font-family: var(--font-ui);
  font-size: 0.82rem;
  line-height: 1.4;
  color: var(--ink);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
}

.card__importance {
  margin: 0;
  font-family: var(--font-ui);
  font-size: 0.68rem;
  line-height: 1.3;
  color: var(--ink-soft);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem;
}

.card__importance-label {
  font-weight: 600;
}

.card__stars {
  color: var(--star);
  letter-spacing: 0.1em;
  font-size: 0.66rem;
  opacity: 0.9;
}

.card__actions {
  margin: 0.2rem 0 0;
  font-family: var(--font-ui);
}

.card--pick .card__actions {
  margin-top: 0.35rem;
  padding-top: 0.4rem;
  border-top: 1px solid var(--line);
}

.btn-source {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: var(--tap);
  padding: 0.3rem 0.8rem;
  border-radius: 999px;
  background: var(--accent);
  color: #fff !important;
  font-weight: 700;
  font-size: 0.8rem;
  text-decoration: none !important;
}

.btn-source:hover,
.btn-source:focus-visible {
  filter: brightness(1.05);
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.btn-source--missing {
  display: inline-flex;
  align-items: center;
  min-height: var(--tap);
  padding: 0.3rem 0.75rem;
  border-radius: 999px;
  border: 1px dashed var(--line);
  color: var(--ink-soft);
  font-size: 0.78rem;
}

/* Category Digest */
.section--digest .section__label {
  font-size: 0.8rem;
  color: var(--ink);
}

.digest-index {
  margin: 0;
  padding: 0.55rem 0.7rem;
  list-style: none;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(11.5rem, 1fr));
  gap: 0.35rem 0.75rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}

.digest-index a {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.2rem 0.1rem;
  font-family: var(--font-ui);
  font-size: 0.86rem;
  font-weight: 650;
  color: var(--ink);
  text-decoration: none;
  border-bottom: 1px dotted transparent;
}

.digest-index a:hover,
.digest-index a:focus-visible {
  color: var(--accent);
  border-bottom-color: var(--accent);
  outline: none;
}

.digest-index__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.digest-index__count {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
  color: var(--ink-soft);
  font-weight: 600;
}

/* More News — compact */
.section--more .section__label {
  font-size: 0.8rem;
  color: var(--ink);
}

.more-cat {
  margin: 0 0 0.95rem;
  padding: 0;
}

.more-cat:last-child {
  margin-bottom: 0;
}

.category-heading {
  margin: 0 0 0.45rem;
  padding-bottom: 0.25rem;
  border-bottom: 2px solid var(--ink);
  font-family: var(--font-ui);
  font-size: 1.05rem;
  font-weight: 750;
  line-height: 1.25;
  letter-spacing: 0.01em;
  color: var(--ink);
}

.category-heading__count {
  font-weight: 600;
  color: var(--ink-soft);
  font-size: 0.92em;
}

.more-cat__list {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.card--more {
  margin: 0;
  padding: 0.55rem 0.7rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  box-shadow: none;
}

.card--more .card__summary {
  font-family: var(--font-ui);
  font-size: 0.98rem;
  font-weight: 650;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  overflow: hidden;
  white-space: normal;
}

.card--more .card__importance {
  order: 3;
  opacity: 0.85;
}

.card--more .card__actions {
  order: 4;
  margin-top: 0.15rem;
}

.card--more .btn-source,
.card--more .btn-source--missing {
  min-height: var(--tap);
  padding: 0.28rem 0.7rem;
  font-size: 0.78rem;
}

.more-read-wrap {
  margin: 0.15rem 0 0;
}

.more-read {
  display: inline-flex;
  align-items: center;
  min-height: var(--tap);
  padding: 0.28rem 0.7rem;
  border: 1px solid var(--accent);
  border-radius: 999px;
  background: var(--accent-soft);
  font-family: var(--font-ui);
  font-size: 0.82rem;
  font-weight: 700;
  color: var(--accent);
  text-decoration: none;
}

.more-read:hover,
.more-read:focus-visible {
  background: var(--accent);
  color: #fff;
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.empty {
  margin: 0;
  padding: 0.65rem 0.75rem;
  border: 1px dashed var(--line);
  border-radius: var(--radius);
  color: var(--ink-soft);
  font-family: var(--font-ui);
  font-size: 0.9rem;
}

.site-footer {
  margin: 1.75rem 0 1.5rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--line);
  font-family: var(--font-ui);
  font-size: 0.78rem;
  color: var(--ink-soft);
}

.site-footer p {
  margin: 0.1rem 0;
}

@media (max-width: 400px) {
  :root {
    --gutter: 0.8rem;
  }

  body {
    font-size: 1rem;
  }

  .site-header {
    padding-top: 1.1rem;
  }

  .metrics {
    gap: 0.35rem;
  }

  .metrics__value {
    font-size: 0.86rem;
    padding: 0.28rem 0.55rem;
  }

  .overview,
  .brief {
    padding: 0.5rem 0.7rem;
  }

  .section--brief {
    width: 100%;
    margin-inline: 0;
  }

  .card,
  .card--top,
  .card--pick,
  .card--more {
    padding: 0.55rem 0.65rem;
  }

  .card__title {
    font-size: 1.05rem;
  }

  .card--pick .card__summary {
    font-size: 0.92rem;
  }

  .digest-index {
    grid-template-columns: 1fr;
  }
}

/* EP-034/035 — AI Usage Dashboard (compact, aligned numbers) */
.usage-dash {
  margin-top: 1.35rem;
  margin-bottom: 0;
  padding-top: 0.95rem;
  border-top: 2px solid var(--ink);
}

.usage-dash__block {
  margin-top: 0.7rem;
  padding: 0.55rem 0 0.1rem;
  border-top: 1px solid var(--line);
}

.usage-dash__block:first-of-type {
  border-top: none;
  padding-top: 0.15rem;
  margin-top: 0.35rem;
}

.usage-dash__heading {
  margin: 0 0 0.4rem;
  font-family: var(--font-ui);
  font-size: 0.84rem;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.usage-dash__stats {
  margin: 0;
  display: grid;
  gap: 0.2rem 0.75rem;
}

.usage-dash__row {
  display: grid;
  grid-template-columns: 11.5rem minmax(0, 1fr);
  gap: 0.2rem 0.85rem;
  align-items: baseline;
  font-family: var(--font-ui);
  font-size: 0.88rem;
  line-height: 1.35;
}

.usage-dash__row dt {
  margin: 0;
  color: var(--ink-soft);
  font-weight: 500;
}

.usage-dash__row dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
  text-align: right;
  justify-self: end;
}

.cost-jpy {
  font-weight: 700;
  color: var(--ink);
}

.cost-usd {
  margin-left: 0.15em;
  font-weight: 500;
  font-size: 0.92em;
  color: var(--ink-soft);
}

.cost-unavailable {
  font-weight: 600;
  color: var(--ink-soft);
}

.usage-dash__rate-note {
  margin: 0.65rem 0 0;
  font-family: var(--font-ui);
  font-size: 0.72rem;
  line-height: 1.4;
  color: var(--ink-soft);
}

@media (max-width: 520px) {
  .usage-dash__row {
    grid-template-columns: 1fr auto;
    gap: 0.15rem 0.75rem;
  }

  .usage-dash__row dd {
    text-align: right;
  }

  .cost-usd {
    display: inline;
  }
}
`;

module.exports = {
  DIGEST_READER_CSS,
};
