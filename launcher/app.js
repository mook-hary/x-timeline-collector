(() => {
  const REFRESH_MS = 30000;
  const state = {
    home: null,
    health: null,
    stats: null,
    activity: [],
    pipelineRunning: false,
  };

  const $ = (id) => document.getElementById(id);

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value == null || value === "" ? "—" : String(value);
  }

  function showError(message) {
    const box = $("global-error");
    box.textContent = message || "";
    box.classList.toggle("hidden", !message);
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    let json;
    try {
      json = await res.json();
    } catch (_error) {
      throw new Error(`Invalid API response (${res.status})`);
    }
    if (!json || json.ok !== true) {
      const err = new Error(
        (json && json.error && json.error.message) ||
          `Request failed (${res.status})`
      );
      err.code = json && json.error && json.error.code;
      throw err;
    }
    return json.data;
  }

  function renderLinks() {
    const links = (state.home && state.home.links) || {};
    if (links.review) {
      $("link-review").href = links.review;
    }
    if (links.editorial) {
      $("link-editorial").href = links.editorial;
      $("link-publish").href = links.editorial;
    }
  }

  function renderPipeline() {
    const pipe = (state.home && state.home.pipeline) || {};
    const last = pipe.lastRun || null;
    setText("pipe-status", pipe.status || "Idle");
    setText("pipe-last", last && last.startedAt ? last.startedAt : "—");
    setText(
      "pipe-duration",
      last && last.durationMs != null ? `${last.durationMs} ms` : "—"
    );
    const running = $("pipe-running");
    if (state.pipelineRunning || pipe.running) {
      running.textContent = pipe.currentStep
        ? `Running...\n${pipe.currentStep}...`
        : "Running...";
      running.classList.remove("hidden");
      $("btn-run-pipeline").disabled = true;
    } else {
      running.classList.add("hidden");
      $("btn-run-pipeline").disabled = false;
    }
  }

  function renderStats() {
    const s = state.stats || (state.home && state.home.stats) || {};
    setText("stat-pending", s.pendingCandidates);
    setText("stat-approved", s.approvedCandidates);
    setText("stat-knowledge", s.knowledge);
    setText("stat-drafts", s.editorialDrafts);
    setText("stat-published", s.published);
    setText("stat-pipeline", s.todaysPipeline);
  }

  function renderHealth() {
    const h = state.health || {};
    const root = $("system-status");
    for (const key of ["review", "editorial", "pipeline"]) {
      const span = root.querySelector(`[data-key="${key}"]`);
      if (!span) continue;
      const row = h[key];
      const label = row && row.status ? row.status : "—";
      span.textContent = label;
      span.classList.toggle("available", label === "Available");
      span.classList.toggle("unavailable", label === "Unavailable");
    }
  }

  function renderActivity() {
    const root = $("activity-list");
    root.innerHTML = "";
    const rows = state.activity || [];
    if (!rows.length) {
      root.innerHTML = '<p class="muted">No recent activity.</p>';
      return;
    }
    for (const row of rows) {
      const el = document.createElement("div");
      el.className = "activity-item";
      const type = document.createElement("span");
      type.className = "type";
      type.textContent = row.type || "Event";
      const summary = document.createElement("span");
      summary.textContent = row.summary || "";
      const at = document.createElement("div");
      at.className = "at";
      at.textContent = row.at || "";
      el.appendChild(type);
      el.appendChild(summary);
      el.appendChild(at);
      root.appendChild(el);
    }
  }

  async function refreshSoft() {
    showError("");
    const [stats, activity, health, status] = await Promise.all([
      api("/api/stats"),
      api("/api/activity?limit=20"),
      api("/api/health"),
      api("/api/pipeline/morning/status"),
    ]);
    state.stats = stats;
    state.activity = activity.activity || [];
    state.health = health;
    if (!state.home) state.home = {};
    state.home.pipeline = status;
    state.home.stats = stats;
    renderStats();
    renderActivity();
    renderHealth();
    renderPipeline();
  }

  async function refreshAll() {
    showError("");
    const home = await api("/api/home");
    state.home = home;
    state.stats = home.stats;
    state.activity = home.activity || [];
    renderLinks();
    renderStats();
    renderActivity();
    renderPipeline();
    const health = await api("/api/health");
    state.health = health;
    renderHealth();
  }

  async function runPipeline() {
    if (state.pipelineRunning) return;
    state.pipelineRunning = true;
    renderPipeline();
    showError("");
    try {
      const data = await api("/api/pipeline/morning/run", {
        method: "POST",
        body: JSON.stringify({}),
      });
      state.pipelineRunning = false;
      if (!state.home) state.home = {};
      state.home.pipeline = data.status || state.home.pipeline;
      await refreshSoft();
    } catch (error) {
      state.pipelineRunning = false;
      showError(error.message || "Pipeline failed.");
      renderPipeline();
      await refreshSoft().catch(() => {});
    }
  }

  function bind() {
    $("btn-refresh").addEventListener("click", () => {
      refreshAll().catch((error) => showError(error.message));
    });
    $("btn-run-pipeline").addEventListener("click", (e) => {
      e.preventDefault();
      runPipeline();
    });
  }

  async function boot() {
    bind();
    try {
      await refreshAll();
    } catch (error) {
      showError(error.message);
    }
    setInterval(() => {
      refreshSoft().catch(() => {});
    }, REFRESH_MS);
  }

  boot();
})();
