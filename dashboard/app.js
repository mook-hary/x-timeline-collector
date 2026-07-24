(() => {
  const state = {
    editorials: [],
    selectedId: null,
    detail: null,
    preview: null,
    confirmOpen: false,
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
      // Persist current textarea into preview by saving? Spec: preview uses store.
      // Preview current editor content: save is separate. Use store body.
      // If user edited but not saved, preview store — better to preview textarea:
      // Spec says Formatter on editorial. We'll save is optional; preview uses saved.
      // For UX, temporarily PUT then preview is heavy. Instead preview uses API on saved item.
      // Document: save before preview if edited. Or we pass body - API doesn't accept body on preview.
      // Quick UX: if textarea differs from detail.body, auto-save first? Spec separate buttons.
      // Preview uses existing formatter on stored editorial — user should Save first.
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
      // Persist textarea so publish matches what was confirmed.
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

    // Prevent Enter in confirm from accidentally submitting elsewhere.
    $("btn-confirm-publish").addEventListener("keydown", (e) => {
      if (e.key === "Enter") e.preventDefault();
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
