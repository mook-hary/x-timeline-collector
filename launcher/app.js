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

  function toast(message, error) {
    if (window.DashboardTheme && DashboardTheme.showToast) {
      DashboardTheme.showToast(message, { error: !!error });
    }
  }

  function pipelineSentence(pipe) {
    const last = pipe && pipe.lastRun ? pipe.lastRun : null;
    if (!last) return "Pipeline has not run yet.";
    if (pipe.running) return "Pipeline is running…";
    const collected = Number(last.collected || 0);
    const candidates = Number(last.candidates || 0);
    if (last.status === "Failed" || last.success === false) {
      return "Last pipeline run failed. Check history and try again.";
    }
    if (last.status === "Dry Run" || last.dryRun) {
      return "Last run was a dry run. No sources or candidates were saved.";
    }
    if (candidates > 0) {
      return `${candidates} new Candidate${candidates === 1 ? "" : "s"} created.`;
    }
    if (collected > 0) {
      return `${collected} source${collected === 1 ? "" : "s"} collected. No new candidates.`;
    }
    return "No new sources were collected.";
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
    if (links.review) $("link-review").href = links.review;
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
    $("pipe-summary").textContent = pipelineSentence(pipe);

    const running = $("pipe-running");
    if (state.pipelineRunning || pipe.running) {
      running.innerHTML = "";
      const spin = document.createElement("span");
      spin.className = "spinner";
      running.appendChild(spin);
      running.appendChild(
        document.createTextNode(
          ` Running... ${pipe.currentStep ? pipe.currentStep + "..." : ""}`
        )
      );
      running.classList.remove("hidden");
      $("btn-run-pipeline").disabled = true;
    } else {
      running.classList.add("hidden");
      $("btn-run-pipeline").disabled = false;
    }
  }

  function renderWork() {
    const s = state.stats || (state.home && state.home.stats) || {};
    setText("work-pending", s.pendingCandidates != null ? s.pendingCandidates : 0);
    setText("work-drafts", s.editorialDrafts != null ? s.editorialDrafts : 0);
    setText("work-published", s.published != null ? s.published : 0);
  }

  function renderCollectorHealth() {
    const ch =
      (state.home && state.home.collectorHealth) ||
      state.collectorHealth ||
      {};
    const loginEl = $("ch-login");
    const statusEl = $("ch-status");
    setText("ch-login", ch.xLogin != null ? ch.xLogin : "—");
    setText("ch-last", ch.lastCollect || "—");
    setText(
      "ch-new",
      ch.newPosts != null && ch.newPosts !== "" ? ch.newPosts : "—"
    );
    setText("ch-latest", ch.latestPost || "—");
    const statusLabel =
      ch.status === "healthy"
        ? "Healthy"
        : ch.status === "warning"
          ? "Warning"
          : ch.status === "failed"
            ? "Failed"
            : ch.status || "—";
    setText("ch-status", statusLabel);
    if (loginEl) {
      loginEl.classList.remove("ok", "failed", "warning");
      if (ch.xLogin === "OK") loginEl.classList.add("ok");
      else if (ch.xLogin === "Failed") loginEl.classList.add("failed");
    }
    if (statusEl) {
      statusEl.classList.remove("ok", "failed", "warning");
      if (ch.status === "healthy") statusEl.classList.add("ok");
      else if (ch.status === "warning") statusEl.classList.add("warning");
      else if (ch.status === "failed") statusEl.classList.add("failed");
    }
  }

  function renderMorningPublish() {
    const mp = (state.home && state.home.morningPublish) || {};
    setText("mp-deadline", mp.deadline || "07:00");
    setText("mp-last", mp.lastPublished || "—");
    const metEl = $("mp-met");
    let metLabel = "—";
    if (mp.deadlineMet === true || mp.deadlineStatus === "met") metLabel = "Met";
    else if (mp.deadlineMet === false || mp.deadlineStatus === "missed") {
      metLabel = "Missed";
    }
    setText("mp-met", metLabel);
    if (metEl) {
      metEl.classList.remove("ok", "failed", "warning");
      if (metLabel === "Met") metEl.classList.add("ok");
      else if (metLabel === "Missed") metEl.classList.add("warning");
    }
    setText("mp-next", mp.nextRun || "03:00");
    setText("mp-total", mp.totalDuration || "—");

    const stagesRoot = $("mp-stages");
    if (stagesRoot) {
      stagesRoot.innerHTML = "";
      const stages = Array.isArray(mp.stages) ? mp.stages : [];
      for (const stage of stages) {
        const li = document.createElement("li");
        li.textContent = `${stage.label}: ${stage.durationLabel || "—"}`;
        stagesRoot.appendChild(li);
      }
    }

    const warn = $("mp-warning");
    if (warn) {
      const warnings = Array.isArray(mp.warnings) ? mp.warnings : [];
      if (warnings.length) {
        warn.textContent = `Warning: ${warnings.join(", ")}`;
        warn.classList.remove("hidden");
      } else {
        warn.textContent = "";
        warn.classList.add("hidden");
      }
    }
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
      root.innerHTML =
        '<div class="empty-state"><strong>まだアクティビティはありません。</strong>Morning Pipeline を実行するか、Review / Editorial で作業を始めてください。</div>';
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
    try {
      state.collectorHealth = await api("/api/collector-health");
      state.home.collectorHealth = state.collectorHealth;
    } catch (_error) {
      // optional
    }
    try {
      state.home.morningPublish = await api("/api/morning-publish");
    } catch (_error) {
      // optional
    }
    renderWork();
    renderActivity();
    renderHealth();
    renderPipeline();
    renderCollectorHealth();
    renderMorningPublish();
  }

  async function refreshAll() {
    showError("");
    const home = await api("/api/home");
    state.home = home;
    state.stats = home.stats;
    state.activity = home.activity || [];
    state.collectorHealth = home.collectorHealth || null;
    renderLinks();
    renderWork();
    renderActivity();
    renderPipeline();
    renderCollectorHealth();
    renderMorningPublish();
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
      toast("Pipeline finished.");
      await refreshSoft();
    } catch (error) {
      state.pipelineRunning = false;
      const msg =
        error.code === "PIPELINE_ALREADY_RUNNING"
          ? "Morning Pipeline is already running."
          : error.message || "Pipeline failed.";
      showError(msg);
      toast(msg, true);
      renderPipeline();
      await refreshSoft().catch(() => {});
    }
  }

  function bind() {
    if (window.DashboardTheme) DashboardTheme.initThemeToggle();
    $("btn-refresh").addEventListener("click", () => {
      refreshAll()
        .then(() => toast("Refreshed."))
        .catch((error) => showError(error.message));
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
