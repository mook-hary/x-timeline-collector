/**
 * UX-001 — theme toggle + toast helpers (browser).
 */
(function (global) {
  const THEME_KEY = "aikido-dashboard-theme";

  function resolveTheme() {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === "light" || saved === "dark") return saved;
    } catch (_error) {
      // ignore
    }
    if (
      global.matchMedia &&
      global.matchMedia("(prefers-color-scheme: light)").matches
    ) {
      return "light";
    }
    return "dark";
  }

  function applyTheme(theme) {
    const next = theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (_error) {
      // ignore
    }
    const btn = document.getElementById("btn-theme-toggle");
    if (btn) {
      btn.textContent = next === "dark" ? "☀" : "🌙";
      btn.setAttribute(
        "aria-label",
        next === "dark" ? "Switch to light theme" : "Switch to dark theme"
      );
      btn.title = btn.getAttribute("aria-label");
    }
    return next;
  }

  function toggleTheme() {
    const current =
      document.documentElement.getAttribute("data-theme") || resolveTheme();
    return applyTheme(current === "dark" ? "light" : "dark");
  }

  function initThemeToggle() {
    applyTheme(resolveTheme());
    const btn = document.getElementById("btn-theme-toggle");
    if (btn) {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        toggleTheme();
      });
    }
  }

  function ensureToastHost() {
    let host = document.getElementById("toast-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "toast-host";
      host.className = "toast-host";
      host.setAttribute("aria-live", "polite");
      document.body.appendChild(host);
    }
    return host;
  }

  function showToast(message, options = {}) {
    const host = ensureToastHost();
    const el = document.createElement("div");
    el.className = "toast" + (options.error ? " toast-error" : "");
    el.textContent = String(message || "");
    host.appendChild(el);
    const ms = options.durationMs != null ? Number(options.durationMs) : 4000;
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translateY(4px)";
      el.style.transition = "opacity 150ms ease, transform 150ms ease";
      setTimeout(() => el.remove(), 160);
    }, Math.min(5000, Math.max(1000, ms)));
  }

  /**
   * Minimal line diff for Original vs suggestion (GitHub-like add/del).
   */
  function buildLineDiff(original, next) {
    const a = String(original || "").split("\n");
    const b = String(next || "").split("\n");
    const out = [];
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) {
      const left = a[i];
      const right = b[i];
      if (left === right) {
        if (left != null) out.push({ type: "same", text: left });
      } else {
        if (left != null && left !== "") out.push({ type: "del", text: left });
        if (right != null && right !== "") out.push({ type: "add", text: right });
        if (left === "" && right == null) out.push({ type: "del", text: "" });
        if (right === "" && left == null) out.push({ type: "add", text: "" });
        if (left != null && right != null && left === "" && right === "") {
          out.push({ type: "same", text: "" });
        }
      }
    }
    return out;
  }

  function renderDiffHtml(original, next) {
    const parts = buildLineDiff(original, next);
    return parts
      .map((row) => {
        const safe = String(row.text)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        if (row.type === "add") {
          return `<div class="diff-add">+ ${safe}</div>`;
        }
        if (row.type === "del") {
          return `<div class="diff-del">- ${safe}</div>`;
        }
        return `<div>  ${safe}</div>`;
      })
      .join("");
  }

  global.DashboardTheme = {
    THEME_KEY,
    resolveTheme,
    applyTheme,
    toggleTheme,
    initThemeToggle,
    showToast,
    buildLineDiff,
    renderDiffHtml,
  };

  // Apply ASAP to avoid flash (script in head may call this).
  if (document.documentElement) {
    applyTheme(resolveTheme());
  }
})(window);
