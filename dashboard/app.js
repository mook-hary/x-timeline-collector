(() => {
  const state = {
    editorials: [],
    selectedId: null,
    detail: null,
    preview: null,
    confirmOpen: false,
    aiSuggestions: [],
    aiGenerating: false,
    aiApplyPending: null,
    morningRunning: false,
    morningStatus: null,
    morningHistory: [],
    candidateCount: null,
  };

  const $ = (id) => document.getElementById(id);

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value == null || value === "" ? "—" : String(value);
  }

  function toast(message, error) {
    if (window.DashboardTheme && DashboardTheme.showToast) {
      DashboardTheme.showToast(message, { error: !!error });
    }
  }

  function track(name, payload) {
    if (window.DashboardAnalytics && DashboardAnalytics.track) {
      DashboardAnalytics.track(name, payload || {});
    }
  }

  function statusChipClass(status) {
    const s = String(status || "").toLowerCase();
    if (s === "published") return "chip chip-published";
    if (s === "draft" || s === "unpublished") return "chip chip-draft";
    if (s === "pending" || s === "reviewing") return "chip chip-pending";
    if (s === "approved" || s === "converted") return "chip chip-approved";
    if (s === "rejected") return "chip chip-rejected";
    return "chip chip-draft";
  }

  function showError(message) {
    const box = $("action-error");
    box.textContent = message || "";
    box.classList.toggle("hidden", !message);
  }

  function showStatus(message) {
    $("action-status").textContent = message || "";
  }

  function showAiError(message) {
    const box = $("ai-draft-error");
    box.textContent = message || "";
    box.classList.toggle("hidden", !message);
  }

  function showAiStatus(message, withSpinner) {
    const el = $("ai-draft-status");
    el.innerHTML = "";
    if (!message) return;
    if (withSpinner) {
      const spin = document.createElement("span");
      spin.className = "spinner";
      spin.setAttribute("aria-hidden", "true");
      el.appendChild(spin);
    }
    el.appendChild(document.createTextNode(message));
  }

  function showMpError(message) {
    const box = $("mp-error");
    box.textContent = message || "";
    box.classList.toggle("hidden", !message);
  }

  function pipelineSentence(st, last) {
    if (!last) return "Pipeline has not run yet.";
    if (st && st.running) return "Pipeline is running…";
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

  function renderMorningPipeline() {
    const st = state.morningStatus || {};
    const last = st.lastRun || null;
    setText("mp-status", st.status || "Idle");
    setText("mp-last-run", last && last.startedAt ? last.startedAt : "—");
    setText(
      "mp-duration",
      last && last.durationMs != null ? `${last.durationMs} ms` : "—"
    );
    $("mp-summary").textContent = pipelineSentence(st, last);

    const detail = $("mp-running-detail");
    if (state.morningRunning) {
      detail.innerHTML = "";
      const spin = document.createElement("span");
      spin.className = "spinner";
      detail.appendChild(spin);
      const step = st.currentStep ? `${st.currentStep}...` : "Running...";
      detail.appendChild(document.createTextNode(` Running... ${step}`));
      detail.classList.remove("hidden");
    } else {
      detail.textContent = "";
      detail.classList.add("hidden");
    }

    $("btn-morning-run").disabled = !!state.morningRunning;

    const histRoot = $("mp-history");
    histRoot.innerHTML = "";
    const rows = state.morningHistory || [];
    if (!rows.length) {
      histRoot.innerHTML = '<p class="muted">No pipeline history yet.</p>';
      return;
    }
    for (const row of rows) {
      const el = document.createElement("div");
      el.className = "mp-history-item";
      const date = document.createElement("div");
      date.textContent = `Date: ${row.startedAt || "—"}`;
      const dur = document.createElement("div");
      dur.textContent = `Duration: ${
        row.durationMs != null ? `${row.durationMs} ms` : "—"
      }`;
      const status = document.createElement("div");
      status.textContent = `Status: ${row.status || "—"}`;
      const summary = document.createElement("div");
      summary.textContent = pipelineSentence({ running: false }, row);
      el.appendChild(date);
      el.appendChild(dur);
      el.appendChild(status);
      el.appendChild(summary);
      histRoot.appendChild(el);
    }
  }

  async function refreshMorningPipeline() {
    try {
      const status = await api("/api/pipeline/morning/status");
      state.morningStatus = status;
      state.morningRunning = !!status.running;
      if (status.candidateCount != null) {
        state.candidateCount = status.candidateCount;
      }
      const hist = await api("/api/pipeline/morning/history?limit=20");
      state.morningHistory = hist.history || [];
      renderMorningPipeline();
    } catch (error) {
      showMpError(error.message);
    }
  }

  async function runMorningPipeline() {
    if (state.morningRunning) return;
    state.morningRunning = true;
    showMpError("");
    $("btn-morning-run").disabled = true;
    state.morningStatus = {
      ...(state.morningStatus || {}),
      status: "Running",
      running: true,
      currentStep: "Collect",
    };
    renderMorningPipeline();
    try {
      const data = await api("/api/pipeline/morning/run", {
        method: "POST",
        body: JSON.stringify({}),
      });
      state.morningStatus = data.status || state.morningStatus;
      state.morningHistory = data.history || state.morningHistory;
      if (data.candidateCount != null) {
        state.candidateCount = data.candidateCount;
      }
      state.morningRunning = false;
      renderMorningPipeline();
      toast("Pipeline finished.");
    } catch (error) {
      state.morningRunning = false;
      if (error.code === "PIPELINE_ALREADY_RUNNING") {
        showMpError("Morning Pipeline is already running.");
        toast("Morning Pipeline is already running.", true);
      } else {
        showMpError(error.message || "Morning Pipeline failed.");
        toast(error.message || "Morning Pipeline failed.", true);
      }
      await refreshMorningPipeline();
    }
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
      err.status = res.status;
      throw err;
    }
    return json.data;
  }

  function renderList() {
    const root = $("editorial-list");
    const status = $("list-status");
    root.innerHTML = "";

    if (!state.editorials.length) {
      status.textContent = "";
      root.innerHTML =
        '<div class="empty-state"><strong>まだEditorialはありません。</strong>Knowledge から Editorial を作成してください。</div>';
      return;
    }

    status.textContent = `${state.editorials.length} item(s)`;
    for (const item of state.editorials) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "list-item" + (item.id === state.selectedId ? " active" : "");
      btn.innerHTML = `
        <div class="row-title"></div>
        <div class="row-meta">
          <span class="badge-slot"></span>
          <span class="id-slot"></span>
          <span class="cat-slot"></span>
          <span class="upd-slot"></span>
        </div>
      `;
      btn.querySelector(".row-title").textContent = item.title || "(untitled)";
      const badge = document.createElement("span");
      const pubStatus =
        item.publishStatus || (item.published ? "published" : "draft");
      badge.className = statusChipClass(pubStatus);
      badge.textContent = pubStatus;
      btn.querySelector(".badge-slot").replaceWith(badge);
      btn.querySelector(".id-slot").textContent = item.id;
      btn.querySelector(".cat-slot").textContent = item.category || "—";
      btn.querySelector(".upd-slot").textContent = item.updatedAt || "—";
      btn.addEventListener("click", () => selectEditorial(item.id));
      root.appendChild(btn);
    }
  }

  function updatePublishControls() {
    const published = !!(state.detail && state.detail.published);
    const exceeds = !!(state.preview && state.preview.exceedsLimit);
    const publishBtn = $("btn-publish");
    publishBtn.disabled = published || exceeds;
    if (published) {
      publishBtn.title = "Already published.";
    } else if (exceeds) {
      publishBtn.title = "Post exceeds the allowed X character limit.";
    } else {
      publishBtn.title = "";
    }
  }

  function resetAiUi() {
    state.aiSuggestions = [];
    state.aiApplyPending = null;
    state.aiGenerating = false;
    showAiError("");
    showAiStatus("");
    $("ai-suggestions").innerHTML = "";
    $("ai-apply-confirm").classList.add("hidden");
    $("btn-ai-again").classList.add("hidden");
    $("btn-ai-generate").disabled = false;
    $("btn-ai-again").disabled = false;
  }

  function currentOriginalBody() {
    return $("body-editor").value || (state.detail && state.detail.body) || "";
  }

  function renderAiSuggestions() {
    const root = $("ai-suggestions");
    root.innerHTML = "";
    const has = state.aiSuggestions.length > 0;
    $("btn-ai-again").classList.toggle("hidden", !has);
    const original = currentOriginalBody();

    for (const s of state.aiSuggestions) {
      const card = document.createElement("article");
      card.className = "ai-card" + (s.invalid || !s.withinLimit ? " invalid" : "");

      const head = document.createElement("div");
      head.className = "ai-card-head";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = `Label: ${s.label || "案"}`;
      const intent = document.createElement("span");
      intent.textContent = `Intent: ${s.intent || "—"}`;
      const chars = document.createElement("span");
      chars.textContent = `Characters: ${
        s.characterCount != null ? s.characterCount : "—"
      }`;
      head.appendChild(label);
      head.appendChild(intent);
      head.appendChild(chars);
      card.appendChild(head);

      if (s.invalid || !s.withinLimit) {
        const notice = document.createElement("p");
        notice.className = "notice notice-warn";
        notice.textContent =
          s.validationError || "Post exceeds the allowed X character limit.";
        card.appendChild(notice);
      }

      const bodyLabel = document.createElement("div");
      bodyLabel.className = "muted";
      bodyLabel.style.fontSize = "0.8rem";
      bodyLabel.textContent = "Body";
      card.appendChild(bodyLabel);

      const body = document.createElement("pre");
      body.className = "ai-card-body";
      body.textContent = s.body || "";
      card.appendChild(body);

      const diffLabel = document.createElement("div");
      diffLabel.className = "muted";
      diffLabel.style.fontSize = "0.8rem";
      diffLabel.textContent = "Diff vs Original";
      card.appendChild(diffLabel);
      const diff = document.createElement("div");
      diff.className = "diff-view";
      if (window.DashboardTheme && DashboardTheme.renderDiffHtml) {
        diff.innerHTML = DashboardTheme.renderDiffHtml(original, s.body || "");
      } else {
        diff.textContent = s.body || "";
      }
      card.appendChild(diff);

      const actions = document.createElement("div");
      actions.className = "ai-card-actions";

      const useBtn = document.createElement("button");
      useBtn.type = "button";
      useBtn.className = "btn btn-primary";
      useBtn.textContent = "Use";
      useBtn.disabled = !!(s.invalid || s.withinLimit === false);
      useBtn.addEventListener("click", () => openAiApplyConfirm(s));
      actions.appendChild(useBtn);

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "btn btn-secondary";
      copyBtn.textContent = "Copy";
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(s.body || "");
          toast("Copied.");
        } catch (_error) {
          toast("Copy failed.", true);
        }
      });
      actions.appendChild(copyBtn);

      card.appendChild(actions);
      root.appendChild(card);
    }
  }

  function openAiApplyConfirm(suggestion) {
    state.aiApplyPending = suggestion;
    const current = currentOriginalBody();
    $("ai-apply-current").textContent = current || "(empty)";
    $("ai-apply-next").textContent = suggestion.body || "";
    const diffEl = $("ai-apply-diff");
    if (window.DashboardTheme && DashboardTheme.renderDiffHtml) {
      diffEl.innerHTML = DashboardTheme.renderDiffHtml(
        current,
        suggestion.body || ""
      );
    } else {
      diffEl.textContent = "";
    }
    $("ai-apply-confirm").classList.remove("hidden");
    showAiError("");
    showAiStatus("");
  }

  function cancelAiApply() {
    state.aiApplyPending = null;
    $("ai-apply-confirm").classList.add("hidden");
  }

  async function confirmAiApply() {
    if (!state.selectedId || !state.aiApplyPending) return;
    showAiError("");
    showAiStatus("");
    try {
      const data = await api(
        `/api/editorials/${encodeURIComponent(state.selectedId)}/apply-ai-draft`,
        {
          method: "POST",
          body: JSON.stringify({
            suggestionBody: state.aiApplyPending.body,
            confirm: true,
          }),
        }
      );
      track("selected", {
        editorialId: state.selectedId,
        label: state.aiApplyPending.label || null,
      });
      state.detail = data.editorial;
      $("body-editor").value = data.editorial.body || "";
      cancelAiApply();
      showAiStatus("Draft applied.");
      showStatus("Draft applied.");
      toast("Draft applied.");
      await loadList();
      renderDetail();
      if (state.aiSuggestions.length) renderAiSuggestions();
    } catch (error) {
      showAiError(`Draft apply failed: ${error.message}`);
      toast(`Draft apply failed: ${error.message}`, true);
    }
  }

  async function generateAiDrafts() {
    if (!state.selectedId || state.aiGenerating) return;
    state.aiGenerating = true;
    $("btn-ai-generate").disabled = true;
    $("btn-ai-again").disabled = true;
    showAiError("");
    showAiStatus("Running...", true);
    cancelAiApply();
    try {
      const data = await api(
        `/api/editorials/${encodeURIComponent(state.selectedId)}/ai-drafts`,
        {
          method: "POST",
          body: JSON.stringify({ count: 3 }),
        }
      );
      state.aiSuggestions = data.suggestions || [];
      track("generated", {
        editorialId: state.selectedId,
        count: state.aiSuggestions.length,
      });
      renderAiSuggestions();
      showAiStatus(
        state.aiSuggestions.length
          ? `${state.aiSuggestions.length} suggestion(s) ready.`
          : "No suggestions returned."
      );
      if (state.aiSuggestions.length) toast("Suggestions ready.");
    } catch (error) {
      if (error.code === "AI_CONFIG_MISSING") {
        showAiError("AI Draft Assistant is not configured.");
      } else {
        showAiError(error.message || "AI draft generation failed.");
      }
      state.aiSuggestions = [];
      renderAiSuggestions();
      toast(error.message || "AI draft generation failed.", true);
    } finally {
      state.aiGenerating = false;
      $("btn-ai-generate").disabled = false;
      $("btn-ai-again").disabled = false;
    }
  }

  function renderDetail() {
    const empty = $("empty-detail");
    const detail = $("detail");
    if (!state.detail) {
      empty.classList.remove("hidden");
      detail.classList.add("hidden");
      return;
    }
    empty.classList.add("hidden");
    detail.classList.remove("hidden");

    const d = state.detail;
    setText("detail-title", d.title);
    setText("meta-id", d.id);
    setText("meta-knowledge", d.knowledgeId);
    setText("meta-category", d.category);
    setText("meta-status", d.status);
    setText("meta-created", d.createdAt);
    setText("meta-updated", d.updatedAt);
    $("body-editor").value = d.body || "";

    const badge = $("detail-publish-badge");
    const pubStatus = d.publishStatus || (d.published ? "published" : "draft");
    badge.textContent = pubStatus;
    badge.className = statusChipClass(pubStatus);

    const statusEl = $("meta-status");
    if (statusEl) {
      statusEl.textContent = d.status || "—";
    }

    const pubBlock = $("published-block");
    if (d.published) {
      pubBlock.classList.remove("hidden");
      setText("meta-remote", d.remoteId);
      setText("meta-published-at", d.publishedAt);
    } else {
      pubBlock.classList.add("hidden");
    }

    updatePublishControls();
  }

  function renderPreview() {
    const box = $("preview-box");
    const empty = $("preview-empty");
    if (!state.preview) {
      box.classList.add("hidden");
      if (empty) empty.classList.remove("hidden");
      return;
    }
    box.classList.remove("hidden");
    if (empty) empty.classList.add("hidden");
    $("preview-text").textContent = state.preview.text || "";
    $("preview-chars").textContent = String(
      state.preview.characters != null
        ? state.preview.characters
        : state.preview.estimatedLength || 0
    );
    $("preview-limit-msg").classList.toggle(
      "hidden",
      !state.preview.exceedsLimit
    );
    updatePublishControls();
  }

  function renderConfirm() {
    const box = $("confirm-box");
    box.classList.toggle("hidden", !state.confirmOpen);
    if (state.confirmOpen && state.preview) {
      $("confirm-text").textContent = state.preview.text || "";
    }
  }

  function renderHistory(items) {
    const root = $("history-list");
    const status = $("history-status");
    root.innerHTML = "";
    if (!items || items.length === 0) {
      status.textContent = "Publish history is empty.";
      return;
    }
    status.textContent = "";
    for (const row of items) {
      const el = document.createElement("div");
      el.className = "history-item";
      el.innerHTML = `
        <div><strong>Editorial ID</strong> <code></code></div>
        <div><strong>Status</strong> <span class="st"></span></div>
        <div><strong>Remote ID</strong> <code class="rid"></code></div>
        <div><strong>Published At</strong> <span class="at"></span></div>
        <div class="err-line hidden"><strong>Error</strong> <span class="err"></span></div>
      `;
      el.querySelector("code").textContent = row.editorialId || "—";
      const st = el.querySelector(".st");
      const chip = document.createElement("span");
      chip.className = statusChipClass(row.status);
      chip.textContent = row.status || "—";
      st.replaceWith(chip);
      el.querySelector(".rid").textContent = row.remoteId || "—";
      el.querySelector(".at").textContent = row.publishedAt || "—";
      if (row.error) {
        const line = el.querySelector(".err-line");
        line.classList.remove("hidden");
        line.querySelector(".err").textContent = String(row.error);
      }
      root.appendChild(el);
    }
  }

  async function loadList() {
    showError("");
    const data = await api("/api/editorials");
    state.editorials = data.editorials || [];
    renderList();
  }

  async function loadHistory(editorialId) {
    const q = editorialId
      ? `?editorialId=${encodeURIComponent(editorialId)}`
      : "";
    const data = await api(`/api/publishes${q}`);
    renderHistory(data.publishes || []);
  }

  async function selectEditorial(id) {
    showError("");
    showStatus("");
    state.confirmOpen = false;
    state.preview = null;
    state.selectedId = id;
    resetAiUi();
    const data = await api(`/api/editorials/${encodeURIComponent(id)}`);
    state.detail = data.editorial;
    renderList();
    renderDetail();
    renderPreview();
    renderConfirm();
    await loadHistory(id);
  }

  async function saveDraft() {
    if (!state.selectedId) return;
    showError("");
    showStatus("");
    try {
      const body = $("body-editor").value;
      const data = await api(
        `/api/editorials/${encodeURIComponent(state.selectedId)}`,
        {
          method: "PUT",
          body: JSON.stringify({ body }),
        }
      );
      state.detail = data.editorial;
      showStatus("Saved.");
      toast("Saved.");
      await loadList();
      renderDetail();
      if (state.aiSuggestions.length) renderAiSuggestions();
    } catch (error) {
      showError(`Save failed: ${error.message}`);
      toast(`Save failed: ${error.message}`, true);
    }
  }

  async function preview() {
    if (!state.selectedId) return;
    showError("");
    showStatus("");
    state.confirmOpen = false;
    renderConfirm();
    try {
      const data = await api(
        `/api/editorials/${encodeURIComponent(state.selectedId)}/preview`,
        {
          method: "POST",
          body: JSON.stringify({ body: $("body-editor").value }),
        }
      );
      state.preview = data.preview;
      renderPreview();
      showStatus("Preview ready.");
      toast("Preview ready.");
    } catch (error) {
      showError(`Preview failed: ${error.message}`);
      toast(`Preview failed: ${error.message}`, true);
    }
  }

  function openConfirm() {
    if (!state.selectedId || !state.detail) return;
    if (state.detail.published) {
      showError("Already published.");
      return;
    }
    if (!state.preview) {
      showError("Run Preview X Post before publishing.");
      return;
    }
    if (state.preview.exceedsLimit) {
      showError("Post exceeds the allowed X character limit.");
      return;
    }
    state.confirmOpen = true;
    renderConfirm();
    showStatus("");
    showError("");
  }

  function cancelConfirm() {
    state.confirmOpen = false;
    renderConfirm();
  }

  async function confirmPublish() {
    if (!state.selectedId) return;
    showError("");
    showStatus("");
    try {
      const body = $("body-editor").value;
      const saved = await api(
        `/api/editorials/${encodeURIComponent(state.selectedId)}`,
        {
          method: "PUT",
          body: JSON.stringify({ body }),
        }
      );
      state.detail = saved.editorial;

      const data = await api(
        `/api/editorials/${encodeURIComponent(state.selectedId)}/publish`,
        {
          method: "POST",
          body: JSON.stringify({ confirm: true }),
        }
      );
      state.confirmOpen = false;
      renderConfirm();
      track("published", {
        editorialId: state.selectedId,
        remoteId: data.remoteId || null,
      });
      showStatus(
        `Published successfully.\nRemote ID: ${data.remoteId || "—"}`
      );
      toast("Published.");
      await selectEditorial(state.selectedId);
      await loadList();
    } catch (error) {
      if (error.code === "ALREADY_PUBLISHED") {
        showError("Already published.");
      } else if (
        error.message &&
        /Save failed|body is required/i.test(error.message)
      ) {
        showError(`Save failed: ${error.message}`);
      } else {
        showError(`Publish failed.\n${error.message}`);
      }
      toast(error.message || "Publish failed.", true);
      state.confirmOpen = false;
      renderConfirm();
      await selectEditorial(state.selectedId).catch(() => {});
    }
  }

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return true;
    return !!el.isContentEditable;
  }

  function bindKeyboard() {
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (state.aiApplyPending) {
          e.preventDefault();
          cancelAiApply();
          return;
        }
        if (state.confirmOpen) {
          e.preventDefault();
          cancelConfirm();
        }
        return;
      }

      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target) && e.key !== "Escape") {
        // Allow G/E/P only when not in textarea — except we still want
        // shortcuts when focus is elsewhere. Skip while typing in fields.
        return;
      }

      const key = e.key.toLowerCase();
      if (key === "e") {
        e.preventDefault();
        saveDraft();
      } else if (key === "p") {
        e.preventDefault();
        preview();
      } else if (key === "g") {
        e.preventDefault();
        generateAiDrafts();
      }
    });
  }

  function bind() {
    if (window.DashboardTheme) DashboardTheme.initThemeToggle();
    bindKeyboard();

    $("btn-refresh").addEventListener("click", async () => {
      try {
        await loadList();
        if (state.selectedId) await selectEditorial(state.selectedId);
        toast("Refreshed.");
      } catch (error) {
        showError(error.message);
      }
    });
    $("btn-save").addEventListener("click", (e) => {
      e.preventDefault();
      saveDraft();
    });
    $("btn-preview").addEventListener("click", (e) => {
      e.preventDefault();
      preview();
    });
    $("btn-publish").addEventListener("click", (e) => {
      e.preventDefault();
      openConfirm();
    });
    $("btn-cancel-publish").addEventListener("click", (e) => {
      e.preventDefault();
      cancelConfirm();
    });
    $("btn-confirm-publish").addEventListener("click", (e) => {
      e.preventDefault();
      confirmPublish();
    });
    $("btn-confirm-publish").addEventListener("keydown", (e) => {
      if (e.key === "Enter") e.preventDefault();
    });

    $("btn-ai-generate").addEventListener("click", (e) => {
      e.preventDefault();
      generateAiDrafts();
    });
    $("btn-ai-again").addEventListener("click", (e) => {
      e.preventDefault();
      generateAiDrafts();
    });
    $("btn-ai-cancel").addEventListener("click", (e) => {
      e.preventDefault();
      cancelAiApply();
    });
    $("btn-ai-confirm").addEventListener("click", (e) => {
      e.preventDefault();
      confirmAiApply();
    });
    $("btn-morning-run").addEventListener("click", (e) => {
      e.preventDefault();
      runMorningPipeline();
    });

    $("body-editor").addEventListener("input", () => {
      if (state.aiSuggestions.length) renderAiSuggestions();
    });
  }

  async function boot() {
    bind();
    try {
      await loadList();
      await loadHistory(null);
      await refreshMorningPipeline();
    } catch (error) {
      showError(error.message);
    }
  }

  boot();
})();
