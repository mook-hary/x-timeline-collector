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
  };

  const $ = (id) => document.getElementById(id);

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value == null || value === "" ? "—" : String(value);
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

  function showAiStatus(message) {
    $("ai-draft-status").textContent = message || "";
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
        (json && json.error && json.error.message) || `Request failed (${res.status})`
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
        '<p class="empty">Editorialはまだありません。</p>';
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
      badge.className =
        "badge " + (item.published ? "published" : "unpublished");
      badge.textContent = item.publishStatus || (item.published ? "published" : "unpublished");
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

  function renderAiSuggestions() {
    const root = $("ai-suggestions");
    root.innerHTML = "";
    const has = state.aiSuggestions.length > 0;
    $("btn-ai-again").classList.toggle("hidden", !has);

    for (const s of state.aiSuggestions) {
      const card = document.createElement("article");
      card.className = "ai-card" + (s.invalid || !s.withinLimit ? " invalid" : "");

      const head = document.createElement("div");
      head.className = "ai-card-head";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = s.label || "案";
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

      const body = document.createElement("pre");
      body.className = "ai-card-body";
      body.textContent = s.body || "";
      card.appendChild(body);

      const useBtn = document.createElement("button");
      useBtn.type = "button";
      useBtn.className = "btn btn-secondary";
      useBtn.textContent = "Use This Draft";
      useBtn.disabled = !!(s.invalid || s.withinLimit === false);
      useBtn.addEventListener("click", () => openAiApplyConfirm(s));
      card.appendChild(useBtn);

      root.appendChild(card);
    }
  }

  function openAiApplyConfirm(suggestion) {
    state.aiApplyPending = suggestion;
    $("ai-apply-current").textContent =
      ($("body-editor").value || (state.detail && state.detail.body) || "") ||
      "(empty)";
    $("ai-apply-next").textContent = suggestion.body || "";
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
      state.detail = data.editorial;
      $("body-editor").value = data.editorial.body || "";
      cancelAiApply();
      showAiStatus("AI draft applied and saved.");
      showStatus("AI draft applied and saved.");
      await loadList();
      renderDetail();
    } catch (error) {
      showAiError(`Draft apply failed: ${error.message}`);
    }
  }

  async function generateAiDrafts() {
    if (!state.selectedId || state.aiGenerating) return;
    state.aiGenerating = true;
    $("btn-ai-generate").disabled = true;
    $("btn-ai-again").disabled = true;
    showAiError("");
    showAiStatus("Generating suggestions...");
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
      renderAiSuggestions();
      showAiStatus(
        state.aiSuggestions.length
          ? `${state.aiSuggestions.length} suggestion(s) ready.`
          : "No suggestions returned."
      );
    } catch (error) {
      if (error.code === "AI_CONFIG_MISSING") {
        showAiError("AI Draft Assistant is not configured.");
      } else {
        showAiError(error.message || "AI draft generation failed.");
      }
      state.aiSuggestions = [];
      renderAiSuggestions();
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
    badge.textContent = d.publishStatus || "unpublished";
    badge.className =
      "badge " + (d.published ? "published" : "unpublished");

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
    if (!state.preview) {
      box.classList.add("hidden");
      return;
    }
    box.classList.remove("hidden");
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
      el.querySelector(".st").textContent = row.status || "—";
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
      await loadList();
      renderDetail();
    } catch (error) {
      showError(`Save failed: ${error.message}`);
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
    } catch (error) {
      showError(`Preview failed: ${error.message}`);
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
      showStatus(
        `Published successfully.\nRemote ID: ${data.remoteId || "—"}`
      );
      await selectEditorial(state.selectedId);
      await loadList();
    } catch (error) {
      if (error.code === "ALREADY_PUBLISHED") {
        showError("Already published.");
      } else if (error.message && /Save failed|body is required/i.test(error.message)) {
        showError(`Save failed: ${error.message}`);
      } else {
        showError(`Publish failed.\n${error.message}`);
      }
      state.confirmOpen = false;
      renderConfirm();
      await selectEditorial(state.selectedId).catch(() => {});
    }
  }

  function bind() {
    $("btn-refresh").addEventListener("click", async () => {
      try {
        await loadList();
        if (state.selectedId) await selectEditorial(state.selectedId);
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
  }

  async function boot() {
    bind();
    try {
      await loadList();
      await loadHistory(null);
    } catch (error) {
      showError(error.message);
    }
  }

  boot();
})();
