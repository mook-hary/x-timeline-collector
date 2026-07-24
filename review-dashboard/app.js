(() => {
  const state = {
    filter: "pending",
    candidates: [],
    pendingCount: 0,
    categories: [],
    selectedId: null,
    detail: null,
    preview: null,
    busy: false,
    approveOpen: false,
    rejectOpen: false,
  };

  const $ = (id) => document.getElementById(id);

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value == null || value === "" ? "—" : String(value);
  }

  function showError(msg) {
    const box = $("action-error");
    box.textContent = msg || "";
    box.classList.toggle("hidden", !msg);
  }

  function showStatus(msg) {
    $("action-status").textContent = msg || "";
  }

  function setBusy(busy) {
    state.busy = busy;
    [
      "btn-save",
      "btn-preview",
      "btn-approve",
      "btn-reject",
      "btn-confirm-approve",
      "btn-confirm-reject",
    ].forEach((id) => {
      const el = $(id);
      if (el) el.disabled = busy || el.dataset.locked === "1";
    });
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
      err.data = json && json.data;
      throw err;
    }
    return json.data;
  }

  function renderFilters() {
    document.querySelectorAll(".filter").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.status === state.filter);
    });
  }

  function renderList() {
    const root = $("candidate-list");
    root.innerHTML = "";
    $("pending-count").textContent = `Pending: ${state.pendingCount}`;
    if (!state.candidates.length) {
      root.innerHTML =
        '<p class="empty">レビュー対象のCandidateはありません。</p>';
      $("list-status").textContent = "";
      return;
    }
    $("list-status").textContent = `${state.candidates.length} item(s)`;
    for (const item of state.candidates) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "list-item" + (item.id === state.selectedId ? " active" : "");
      const badge = document.createElement("span");
      badge.className = `badge ${item.status || ""}`;
      badge.textContent = item.status || "—";
      btn.innerHTML = `<div class="row-title"></div><div class="row-meta"></div>`;
      btn.querySelector(".row-title").textContent = item.title || "(untitled)";
      const meta = btn.querySelector(".row-meta");
      meta.appendChild(badge);
      const idSpan = document.createElement("span");
      idSpan.textContent = item.id;
      meta.appendChild(idSpan);
      const cat = document.createElement("span");
      cat.textContent = item.category || "—";
      meta.appendChild(cat);
      const src = document.createElement("span");
      src.textContent = item.sourceId || "—";
      meta.appendChild(src);
      const created = document.createElement("span");
      created.textContent = item.createdAt || "—";
      meta.appendChild(created);
      btn.addEventListener("click", () => selectCandidate(item.id));
      root.appendChild(btn);
    }
  }

  function fillCategories(selected) {
    const sel = $("field-category");
    sel.innerHTML = "";
    for (const c of state.categories) {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      if (c === selected) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  function setEditable(editable) {
    ["field-title", "field-category", "field-summary", "field-content", "field-tags", "field-difficulty"].forEach(
      (id) => {
        $(id).disabled = !editable;
      }
    );
    $("btn-save").dataset.locked = editable ? "0" : "1";
    $("btn-approve").dataset.locked = editable || (state.detail && (state.detail.status === "approved" || state.detail.status === "converted" || state.detail.status === "rejected")) ? (state.detail && (state.detail.status === "approved" || state.detail.status === "converted" || state.detail.status === "rejected") ? "1" : "0") : "0";
    // Simplify lock logic below in updateActionLocks
    updateActionLocks();
  }

  function updateActionLocks() {
    const d = state.detail;
    const terminal =
      d &&
      (d.status === "converted" ||
        d.status === "approved" ||
        d.status === "rejected");
    const editable = !!(d && d.editable);
    $("btn-save").disabled = state.busy || !editable;
    $("btn-preview").disabled = state.busy || !d;
    $("btn-approve").disabled =
      state.busy || !d || d.status === "converted" || d.status === "rejected" || !!d.knowledgeId;
    $("btn-reject").disabled =
      state.busy || !d || terminal;
  }

  function renderReviewHistory(d) {
    const box = $("review-history");
    if (!d.review || !d.review.decision) {
      box.textContent = "Not reviewed yet.";
      return;
    }
    box.innerHTML = "";
    const lines = [
      ["Decision", d.review.decision],
      ["Reason", d.review.reason || "—"],
      ["Knowledge ID", d.review.knowledgeId || "—"],
      ["Reviewed At", d.review.reviewedAt || "—"],
    ];
    for (const [k, v] of lines) {
      const row = document.createElement("div");
      row.innerHTML = `<strong></strong> <code></code>`;
      row.querySelector("strong").textContent = k + ":";
      row.querySelector("code").textContent = v == null ? "—" : String(v);
      box.appendChild(row);
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
    const badge = $("detail-status-badge");
    badge.className = `badge ${d.status || ""}`;
    badge.textContent = d.status || "—";
    setText("meta-id", d.id);
    setText("meta-source-id", d.sourceId);
    setText("meta-category", d.category);
    setText("meta-difficulty", d.difficulty);
    setText("meta-created", d.createdAt);
    setText("meta-updated", d.updatedAt);
    setText("meta-knowledge", d.knowledgeId);

    fillCategories(d.category);
    $("field-title").value = d.title || "";
    $("field-summary").value = d.summary || "";
    $("field-content").value = d.content || "";
    $("field-tags").value = Array.isArray(d.tags) ? d.tags.join(", ") : "";
    $("field-difficulty").value = d.difficulty != null ? d.difficulty : 1;

    if (d.sourceUnavailable) {
      $("source-unavailable").classList.remove("hidden");
      $("source-grid").classList.add("hidden");
    } else if (d.source) {
      $("source-unavailable").classList.add("hidden");
      $("source-grid").classList.remove("hidden");
      setText("source-title", d.source.title);
      setText("source-type", d.source.sourceType);
      // textContent only — never innerHTML for URL
      setText("source-url", d.source.url);
      setText("source-collected", d.source.collectedAt);
    } else {
      $("source-unavailable").classList.add("hidden");
      $("source-grid").classList.add("hidden");
    }

    setEditable(d.editable);
    renderReviewHistory(d);
  }

  function renderPreview() {
    const box = $("preview-box");
    if (!state.preview) {
      box.classList.add("hidden");
      return;
    }
    box.classList.remove("hidden");
    const p = state.preview;
    setText("pv-title", p.title);
    setText("pv-category", p.category);
    setText("pv-summary", p.summary);
    setText("pv-content", p.content);
    setText("pv-tags", Array.isArray(p.tags) ? p.tags.join(", ") : "");
    setText("pv-difficulty", p.difficulty);
    setText("pv-sources", Array.isArray(p.sources) ? p.sources.join(", ") : "");
  }

  function renderConfirm() {
    $("approve-box").classList.toggle("hidden", !state.approveOpen);
    $("reject-box").classList.toggle("hidden", !state.rejectOpen);
    if (state.approveOpen && state.preview) {
      $("approve-preview").textContent =
        `${state.preview.title}\n\n${state.preview.content}`;
    }
  }

  async function loadList() {
    const data = await api(
      `/api/candidates?status=${encodeURIComponent(state.filter)}`
    );
    state.candidates = data.candidates || [];
    state.pendingCount = data.pendingCount || 0;
    state.categories = data.categories || [];
    renderFilters();
    renderList();
  }

  async function selectCandidate(id) {
    showError("");
    showStatus("");
    state.approveOpen = false;
    state.rejectOpen = false;
    state.preview = null;
    state.selectedId = id;
    const data = await api(`/api/candidates/${encodeURIComponent(id)}`);
    state.detail = data.candidate;
    renderList();
    renderDetail();
    renderPreview();
    renderConfirm();
  }

  async function saveCandidate() {
    if (!state.selectedId || state.busy) return;
    setBusy(true);
    showError("");
    showStatus("");
    try {
      const data = await api(`/api/candidates/${encodeURIComponent(state.selectedId)}`, {
        method: "PUT",
        body: JSON.stringify({
          title: $("field-title").value,
          category: $("field-category").value,
          summary: $("field-summary").value,
          content: $("field-content").value,
          tags: $("field-tags").value,
          difficulty: $("field-difficulty").value,
        }),
      });
      state.detail = data.candidate;
      showStatus("Candidate saved.");
      await loadList();
      renderDetail();
    } catch (error) {
      showError(`Save failed: ${error.message}`);
    } finally {
      setBusy(false);
      updateActionLocks();
    }
  }

  async function previewKnowledge() {
    if (!state.selectedId || state.busy) return;
    setBusy(true);
    showError("");
    showStatus("");
    state.approveOpen = false;
    state.rejectOpen = false;
    try {
      // Save first if editable so preview matches form
      if (state.detail && state.detail.editable) {
        await api(`/api/candidates/${encodeURIComponent(state.selectedId)}`, {
          method: "PUT",
          body: JSON.stringify({
            title: $("field-title").value,
            category: $("field-category").value,
            summary: $("field-summary").value,
            content: $("field-content").value,
            tags: $("field-tags").value,
            difficulty: $("field-difficulty").value,
          }),
        });
      }
      const data = await api(
        `/api/candidates/${encodeURIComponent(state.selectedId)}/knowledge-preview`,
        { method: "POST", body: "{}" }
      );
      state.preview = data.preview;
      const refreshed = await api(
        `/api/candidates/${encodeURIComponent(state.selectedId)}`
      );
      state.detail = refreshed.candidate;
      renderDetail();
      renderPreview();
      renderConfirm();
      showStatus("Knowledge preview ready.");
      await loadList();
    } catch (error) {
      showError(`Preview failed: ${error.message}`);
    } finally {
      setBusy(false);
      updateActionLocks();
    }
  }

  function openApprove() {
    if (!state.preview) {
      showError("Run Preview Knowledge before approval.");
      return;
    }
    state.approveOpen = true;
    state.rejectOpen = false;
    renderConfirm();
  }

  function openReject() {
    state.rejectOpen = true;
    state.approveOpen = false;
    renderConfirm();
  }

  async function confirmApprove() {
    if (!state.selectedId || state.busy) return;
    setBusy(true);
    showError("");
    showStatus("");
    try {
      const data = await api(
        `/api/candidates/${encodeURIComponent(state.selectedId)}/approve`,
        { method: "POST", body: JSON.stringify({ confirm: true }) }
      );
      state.approveOpen = false;
      showStatus(
        `Approved successfully.\nKnowledge ID: ${data.knowledgeId || "—"}`
      );
      await selectCandidate(state.selectedId);
      await loadList();
    } catch (error) {
      if (error.code === "ALREADY_APPROVED") {
        const kid = error.data && error.data.knowledgeId;
        showError(
          kid
            ? `Already approved.\nKnowledge ID: ${kid}`
            : "Already approved."
        );
      } else {
        showError(`Approve failed: ${error.message}`);
      }
      state.approveOpen = false;
      await selectCandidate(state.selectedId).catch(() => {});
    } finally {
      setBusy(false);
      updateActionLocks();
      renderConfirm();
    }
  }

  async function confirmReject() {
    if (!state.selectedId || state.busy) return;
    setBusy(true);
    showError("");
    showStatus("");
    try {
      await api(
        `/api/candidates/${encodeURIComponent(state.selectedId)}/reject`,
        {
          method: "POST",
          body: JSON.stringify({
            confirm: true,
            reason: $("reject-reason").value,
          }),
        }
      );
      state.rejectOpen = false;
      showStatus("Candidate rejected.");
      await selectCandidate(state.selectedId);
      await loadList();
    } catch (error) {
      showError(`Reject failed: ${error.message}`);
      state.rejectOpen = false;
    } finally {
      setBusy(false);
      updateActionLocks();
      renderConfirm();
    }
  }

  function bind() {
    document.querySelectorAll(".filter").forEach((btn) => {
      btn.addEventListener("click", async () => {
        state.filter = btn.dataset.status;
        try {
          await loadList();
        } catch (error) {
          showError(error.message);
        }
      });
    });
    $("btn-refresh").addEventListener("click", async () => {
      try {
        await loadList();
        if (state.selectedId) await selectCandidate(state.selectedId);
      } catch (error) {
        showError(error.message);
      }
    });
    $("btn-save").addEventListener("click", (e) => {
      e.preventDefault();
      saveCandidate();
    });
    $("btn-preview").addEventListener("click", (e) => {
      e.preventDefault();
      previewKnowledge();
    });
    $("btn-approve").addEventListener("click", (e) => {
      e.preventDefault();
      openApprove();
    });
    $("btn-reject").addEventListener("click", (e) => {
      e.preventDefault();
      openReject();
    });
    $("btn-cancel-approve").addEventListener("click", (e) => {
      e.preventDefault();
      state.approveOpen = false;
      renderConfirm();
    });
    $("btn-cancel-reject").addEventListener("click", (e) => {
      e.preventDefault();
      state.rejectOpen = false;
      renderConfirm();
    });
    $("btn-confirm-approve").addEventListener("click", (e) => {
      e.preventDefault();
      confirmApprove();
    });
    $("btn-confirm-approve").addEventListener("keydown", (e) => {
      if (e.key === "Enter") e.preventDefault();
    });
    $("btn-confirm-reject").addEventListener("click", (e) => {
      e.preventDefault();
      confirmReject();
    });
  }

  async function boot() {
    bind();
    try {
      await loadList();
    } catch (error) {
      showError(error.message);
    }
  }

  boot();
})();
