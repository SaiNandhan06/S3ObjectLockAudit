/**
 * AuditLock Dashboard Application
 * Implements S3 Object Lock compliance audit interface, direct presigned uploads,
 * live S3 status reconciliation, and role-based delete attempt verification.
 */

(() => {
  // --- Global State & Configuration ---
  const REMOTE_API_GATEWAY = "https://6yl1sp5oa7.execute-api.us-east-1.amazonaws.com";
  const isProxiedHost =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1" ||
    window.location.hostname.endsWith(".vercel.app") ||
    window.location.hostname.includes("vercel");
  const DEFAULT_API_BASE = isProxiedHost ? "/api" : REMOTE_API_GATEWAY;
  const S3_BUCKET_NAME = "s3objectlock-auditlock-locked";

  const state = {
    apiBase: localStorage.getItem("auditlock_api_base") || DEFAULT_API_BASE,
    githubClientId: localStorage.getItem("auditlock_gh_client_id") || "",
    sessionToken: sessionStorage.getItem("auditlock_session_token") || null,
    currentUser: null, // { githubLogin, role, exp }
    records: [],
    selectedRecord: null,
    selectedFile: null,
    activeFilter: "ALL",
  };

  // --- Utility Functions ---
  const el = (id) => document.getElementById(id);

  function showToast(message, type = "info") {
    const container = el("toast-container");
    if (!container) return;
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(10px)";
      setTimeout(() => toast.remove(), 250);
    }, 4000);
  }

  function formatBytes(bytes, decimals = 1) {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
  }

  function formatDate(isoString) {
    if (!isoString) return "--";
    try {
      const d = new Date(isoString);
      return d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return isoString;
    }
  }

  function getFileExtension(filename) {
    return filename.split(".").pop().toUpperCase() || "DOC";
  }

  // --- Auth & Session Token Handling (B6) ---
  function initAuth() {
    // 1. Check URL fragment for token (from GitHub OAuth redirect)
    const hash = window.location.hash;
    if (hash && hash.includes("token=")) {
      const match = hash.match(/token=([^&]+)/);
      if (match && match[1]) {
        const token = decodeURIComponent(match[1]);
        sessionStorage.setItem("auditlock_session_token", token);
        state.sessionToken = token;
        // Strip token from visible URL fragment for security
        history.replaceState(null, null, window.location.pathname + window.location.search);
        showToast("Logged in via GitHub OAuth successfully", "success");
      }
    }

    decodeAndApplySession();
    renderAuthUI();
  }

  function decodeAndApplySession() {
    if (!state.sessionToken) {
      state.currentUser = null;
      return;
    }

    try {
      // Decode JWT / custom token payload
      const parts = state.sessionToken.split(".");
      let payloadJson = null;

      if (parts.length >= 2) {
        // Standard JWT or signed payload format: header.payload.signature
        const base64Url = parts[1] || parts[0];
        const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
        payloadJson = JSON.parse(decodeURIComponent(escape(window.atob(base64))));
      } else {
        // Attempt direct base64 decode
        payloadJson = JSON.parse(window.atob(state.sessionToken));
      }

      state.currentUser = {
        githubLogin: payloadJson.githubLogin || payloadJson.login || "user",
        role: (payloadJson.role || "user").toLowerCase(),
        exp: payloadJson.exp || null,
      };
    } catch (e) {
      console.warn("Could not decode session token as structured JWT/JSON:", e);
      // Fallback object
      state.currentUser = {
        githubLogin: "authenticated-user",
        role: "user",
        exp: null,
      };
    }
  }

  function updateGitHubLoginUrls() {
    const clientId = state.githubClientId || "Ov23liauExample";
    const oauthUrl = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&scope=read:user`;
    const btnHero = el("btn-hero-login-github");
    if (btnHero) btnHero.href = oauthUrl;
    const btnNav = el("btn-login-github");
    if (btnNav) btnNav.href = oauthUrl;
  }

  function renderAuthUI() {
    const profileBadge = el("user-profile-badge");
    const authControls = el("auth-controls");
    const loginName = el("user-login-name");
    const roleBadge = el("user-role-badge");
    const actionRoleText = el("action-role-text");
    const adminDeleteBtn = el("btn-attempt-admin-delete");
    const viewLogin = el("view-login");
    const viewDashboard = el("view-dashboard");

    updateGitHubLoginUrls();

    if (state.currentUser && state.sessionToken) {
      // Logged-in view: show dashboard, hide login view
      if (viewLogin) viewLogin.style.display = "none";
      if (viewDashboard) viewDashboard.style.display = "block";

      if (profileBadge) profileBadge.style.display = "flex";
      if (authControls) authControls.style.display = "none";
      if (loginName) loginName.textContent = state.currentUser.githubLogin;
      
      const roleUpper = state.currentUser.role.toUpperCase();
      if (roleBadge) {
        roleBadge.textContent = roleUpper;
        roleBadge.className = `role-badge ${state.currentUser.role === "admin" ? "role-admin" : "role-user"}`;
      }
      if (actionRoleText) actionRoleText.textContent = roleUpper;

      // Role enforcement in UI: Admin Override button rendered ONLY for admin role
      if (adminDeleteBtn) {
        adminDeleteBtn.style.display = state.currentUser.role === "admin" ? "inline-flex" : "none";
      }
    } else {
      // Logged-out view: show login view, hide dashboard
      if (viewLogin) viewLogin.style.display = "flex";
      if (viewDashboard) viewDashboard.style.display = "none";

      if (profileBadge) profileBadge.style.display = "none";
      if (authControls) authControls.style.display = "flex";
      if (actionRoleText) actionRoleText.textContent = "UNAUTHENTICATED";
      if (adminDeleteBtn) adminDeleteBtn.style.display = "none";
    }
  }

  function logout() {
    sessionStorage.removeItem("auditlock_session_token");
    state.sessionToken = null;
    state.currentUser = null;
    renderAuthUI();
    showToast("Session ended", "info");
    window.location.reload();
  }

  function simulateRoleLogin(role, username) {
    // Generates a mock signed session token for testing before/without OAuth callback
    const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = btoa(
      JSON.stringify({
        githubLogin: username,
        role: role,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
      })
    );
    const mockToken = `${header}.${payload}.mock-signature-eval`;
    sessionStorage.setItem("auditlock_session_token", mockToken);
    state.sessionToken = mockToken;
    decodeAndApplySession();
    renderAuthUI();
    showToast(`Switched active session to ${username} (${role.toUpperCase()})`, "success");
    loadRecords();
    // Also re-render detail drawer buttons if currently open
    if (state.selectedRecord) {
      renderRecordDetail(state.selectedRecord);
    }
  }

  // --- API Client with Auth Context ---
  async function apiFetch(endpoint, options = {}) {
    const url = `${state.apiBase}${endpoint}`;
    const headers = options.headers ? { ...options.headers } : {};

    if (state.sessionToken) {
      headers["Authorization"] = `Bearer ${state.sessionToken}`;
    }

    try {
      const response = await fetch(url, { ...options, headers });

      if (response.status === 401) {
        // Token expired or invalid
        showToast("Session expired or unauthorized (401). Please re-authenticate.", "error");
        sessionStorage.removeItem("auditlock_session_token");
        state.sessionToken = null;
        state.currentUser = null;
        renderAuthUI();
      }

      return response;
    } catch (err) {
      console.error(`API Fetch Error [${endpoint}]:`, err);
      throw err;
    }
  }

  // --- Records List & Detail (B8) ---
  async function loadRecords() {
    const tbody = el("records-tbody");
    const refreshBtn = el("btn-refresh-records");
    if (refreshBtn) refreshBtn.querySelector("svg")?.classList.add("spin-on-load");

    try {
      const res = await apiFetch("/records");
      if (!res.ok) {
        throw new Error(`Failed to fetch records: HTTP ${res.status}`);
      }
      const data = await res.json();
      state.records = data.records || [];

      updateMetrics();
      renderRecordsTable();
      updateApiConnectionStatus(true);
    } catch (err) {
      console.error("Error loading records:", err);
      updateApiConnectionStatus(false);
      if (tbody) {
        tbody.innerHTML = `
          <tr>
            <td colspan="7">
              <div class="empty-state">
                <span style="color: var(--danger);">Failed to connect to API Gateway (${err.message})</span>
                <button class="btn btn-secondary btn-sm" onclick="window.AuditLock.loadRecords()">Retry</button>
              </div>
            </td>
          </tr>
        `;
      }
    } finally {
      if (refreshBtn) refreshBtn.querySelector("svg")?.classList.remove("spin-on-load");
    }
  }

  function updateMetrics() {
    const totalRecords = state.records.length;
    const lockedRecords = state.records.filter(
      (r) => r.retentionMode && r.retentionMode !== "NONE"
    ).length;
    const legalHolds = state.records.filter((r) => !!r.legalHold).length;

    if (el("metric-total-records")) el("metric-total-records").textContent = totalRecords;
    if (el("metric-locked-records")) el("metric-locked-records").textContent = lockedRecords;
    if (el("metric-legal-holds")) el("metric-legal-holds").textContent = legalHolds;
  }

  function updateApiConnectionStatus(connected) {
    const dot = el("api-status-dot");
    const text = el("api-status-text");
    if (dot && text) {
      if (connected) {
        dot.className = "pulse-dot active";
        text.textContent = "Connected";
        text.style.color = "var(--text-main)";
      } else {
        dot.className = "pulse-dot";
        text.textContent = "Disconnected";
        text.style.color = "var(--danger)";
      }
    }
  }

  function renderRecordsTable() {
    const tbody = el("records-tbody");
    if (!tbody) return;

    const searchTerm = (el("filter-search-input")?.value || "").toLowerCase().trim();
    const filtered = state.records.filter((r) => {
      // Search
      const matchesSearch =
        !searchTerm ||
        r.fileName.toLowerCase().includes(searchTerm) ||
        r.recordId.toLowerCase().includes(searchTerm);

      // Filter chips
      let matchesFilter = true;
      if (state.activeFilter === "GOVERNANCE") {
        matchesFilter = r.retentionMode === "GOVERNANCE";
      } else if (state.activeFilter === "NONE") {
        matchesFilter = !r.retentionMode || r.retentionMode === "NONE";
      } else if (state.activeFilter === "LEGAL_HOLD") {
        matchesFilter = !!r.legalHold;
      }

      return matchesSearch && matchesFilter;
    });

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7">
            <div class="empty-state">
              <p>No audit records match the current filter.</p>
              <button class="btn btn-secondary btn-sm" id="btn-empty-clear-filters">Reset Filters</button>
            </div>
          </td>
        </tr>
      `;
      el("btn-empty-clear-filters")?.addEventListener("click", () => {
        state.activeFilter = "ALL";
        document.querySelectorAll(".filter-chip").forEach((c) => c.classList.remove("active"));
        document.querySelector('.filter-chip[data-filter="ALL"]')?.classList.add("active");
        if (el("filter-search-input")) el("filter-search-input").value = "";
        renderRecordsTable();
      });
      return;
    }

    tbody.innerHTML = filtered
      .map((r) => {
        const ext = getFileExtension(r.fileName);
        const isLocked = r.retentionMode && r.retentionMode !== "NONE";
        const lockBadge = isLocked
          ? `<span class="lock-badge lock-badge-governance">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
              ${r.retentionMode}
            </span>`
          : `<span class="lock-badge lock-badge-none">NONE</span>`;

        const holdBadge = r.legalHold
          ? `<span class="legal-hold-badge hold-active">ACTIVE</span>`
          : `<span class="legal-hold-badge hold-off">OFF</span>`;

        return `
          <tr data-record-id="${r.recordId}">
            <td>
              <div class="file-row-name">
                <span class="file-type-pill">${ext}</span>
                <span>${escapeHtml(r.fileName)}</span>
              </div>
            </td>
            <td>${lockBadge}</td>
            <td>${formatDate(r.retentionUntil)}</td>
            <td>${holdBadge}</td>
            <td>${formatDate(r.uploadDate)}</td>
            <td class="record-id-col code-font" title="${r.recordId}">${r.recordId}</td>
            <td class="th-actions">
              <button class="btn btn-secondary btn-sm btn-view-detail" data-record-id="${r.recordId}">
                Inspect Detail
              </button>
            </td>
          </tr>
        `;
      })
      .join("");

    // Attach row click listeners
    tbody.querySelectorAll("tr[data-record-id]").forEach((row) => {
      row.addEventListener("click", (e) => {
        const id = row.getAttribute("data-record-id");
        openRecordDetail(id);
      });
    });
  }

  // --- Detail Drawer & Delete Actions (B8) ---
  async function openRecordDetail(recordId) {
    const modal = el("detail-modal");
    if (!modal) return;
    modal.style.display = "flex";

    // Set initial loading state in modal
    el("modal-file-name").textContent = "Loading record...";
    el("modal-record-id").textContent = recordId;
    el("delete-outcome-banner").style.display = "none";
    el("timeline-feed").innerHTML = '<div class="spinner" style="margin: 2rem auto;"></div>';

    try {
      const res = await apiFetch(`/records/${recordId}`);
      if (res.ok) {
        const data = await res.json();
        state.selectedRecord = data;
        renderRecordDetail(data);
      } else {
        // Graceful fallback to record metadata from catalog list if live status check failed
        const cached = state.records.find((r) => r.recordId === recordId);
        const errJson = await res.json().catch(() => ({}));
        const fallbackData = {
          record: cached || { recordId, fileName: "Record " + recordId.slice(0, 8) },
          liveStatus: {
            mode: "INACCESSIBLE / DELETED",
            retainUntilDate: null,
            legalHold: "OFF",
          },
          events: [
            {
              eventType: "LIVE_STATUS_NOTICE",
              actor: "s3-reconcile",
              outcome: "NOTICE",
              detail: errJson.error?.message || `S3 live retention query returned HTTP ${res.status}`,
              occurredAt: new Date().toISOString(),
            },
          ],
        };
        state.selectedRecord = fallbackData;
        renderRecordDetail(fallbackData);
      }
    } catch (err) {
      console.error("Error fetching record detail:", err);
      showToast(`Error: ${err.message}`, "error");
      el("modal-file-name").textContent = "Error loading record";
    }
  }

  function renderRecordDetail(data) {
    const record = data.record || {};
    const live = data.liveStatus || {};
    const events = data.events || [];

    el("modal-file-name").textContent = record.fileName || "Unknown File";
    el("modal-file-icon").textContent = getFileExtension(record.fileName || "DOC");
    el("modal-record-id").textContent = record.recordId;

    // Live S3 Status (rendered strictly from liveStatus, not cached record)
    el("modal-live-mode").textContent = live.mode || "NONE";
    el("modal-live-until").textContent = formatDate(live.retainUntilDate);
    el("modal-live-legal-hold").textContent = live.legalHold || "OFF";
    el("modal-s3-bucket").textContent = record.s3Bucket || S3_BUCKET_NAME;

    // Stored Record Metadata
    el("modal-s3-key").textContent = record.s3Key || "--";
    el("modal-s3-key").title = record.s3Key || "";
    el("modal-s3-version").textContent = record.s3VersionId || "--";
    el("modal-s3-version").title = record.s3VersionId || "";
    el("modal-upload-date").textContent = formatDate(record.uploadDate);
    el("modal-demo-flag").textContent = record.isDemoObject ? "Yes" : "No";

    // Admin Override Button visibility based on current role (B8 requirement: ONLY when role is admin)
    const adminBtn = el("btn-attempt-admin-delete");
    const isAdmin = state.currentUser && state.currentUser.role === "admin";
    if (adminBtn) {
      adminBtn.style.display = isAdmin ? "inline-flex" : "none";
    }

    // Render Timeline (oldest first per B8 spec)
    const timelineContainer = el("timeline-feed");
    if (!events || events.length === 0) {
      timelineContainer.innerHTML = '<p class="text-muted" style="padding: 1rem 0;">No audit events recorded.</p>';
    } else {
      // Sort oldest first
      const sortedEvents = [...events].sort((a, b) => (a.occurredAt > b.occurredAt ? 1 : -1));
      timelineContainer.innerHTML = sortedEvents
        .map((ev) => {
          let dotClass = "dot-neutral";
          if (ev.outcome === "DENIED") dotClass = "dot-denied";
          else if (ev.outcome === "ALLOWED" || ev.outcome === "DELETED") dotClass = "dot-allowed";

          return `
            <div class="timeline-item">
              <span class="timeline-dot ${dotClass}"></span>
              <div class="timeline-meta-line">
                <span class="timeline-type">${escapeHtml(ev.eventType)}</span>
                <span class="timeline-actor">${escapeHtml(ev.actor || "system")}</span>
                <span class="outcome-badge ${ev.outcome === "DENIED" ? "outcome-denied" : "outcome-deleted"}">${escapeHtml(ev.outcome)}</span>
                <span class="timeline-time">${formatDate(ev.occurredAt)}</span>
              </div>
              <div class="timeline-detail code-font">${escapeHtml(ev.detail || "(no detail)")}</div>
            </div>
          `;
        })
        .join("");
    }
  }

  async function handleStandardDeleteAttempt() {
    if (!state.selectedRecord || !state.selectedRecord.record) return;
    const recordId = state.selectedRecord.record.recordId;
    const btn = el("btn-attempt-delete");
    btn.disabled = true;

    try {
      const res = await apiFetch(`/records/${recordId}/delete-attempt`, { method: "POST" });
      const result = await res.json();
      displayDeleteOutcome(result);
      // Immediately refresh detail and timeline
      await reloadSelectedRecord(recordId);
    } catch (err) {
      console.error("Standard delete attempt error:", err);
      displayDeleteOutcome({ outcome: "ERROR", reason: err.message });
    } finally {
      btn.disabled = false;
    }
  }

  async function handleAdminDeleteAttempt() {
    if (!state.selectedRecord || !state.selectedRecord.record) return;
    const recordId = state.selectedRecord.record.recordId;
    const btn = el("btn-attempt-admin-delete");
    btn.disabled = true;

    try {
      const res = await apiFetch(`/records/${recordId}/delete-attempt-admin`, { method: "POST" });
      const result = await res.json();
      displayDeleteOutcome(result);
      // Immediately refresh detail and timeline
      await reloadSelectedRecord(recordId);
    } catch (err) {
      console.error("Admin delete attempt error:", err);
      displayDeleteOutcome({ outcome: "ERROR", reason: err.message });
    } finally {
      btn.disabled = false;
    }
  }

  function displayDeleteOutcome(result) {
    const banner = el("delete-outcome-banner");
    const badge = el("outcome-badge");
    const reason = el("outcome-reason");
    const icon = el("outcome-icon");

    banner.style.display = "flex";
    const outcome = (result.outcome || "ERROR").toUpperCase();

    if (outcome === "DENIED") {
      banner.className = "delete-outcome-banner banner-denied";
      badge.className = "outcome-badge outcome-denied";
      badge.textContent = "DENIED";
      icon.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f43f5e" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`;
      reason.textContent = result.reason || "AccessDenied: Object is locked by S3 Object Lock Governance mode.";
    } else if (outcome === "DELETED") {
      banner.className = "delete-outcome-banner banner-deleted";
      badge.className = "outcome-badge outcome-deleted";
      badge.textContent = "DELETED";
      icon.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`;
      reason.textContent = result.bypassUsed
        ? "S3 accepted the delete request via authorized governance bypass (s3:BypassGovernanceRetention)."
        : (result.reason || "S3 delete succeeded");
    } else {
      banner.className = "delete-outcome-banner banner-denied";
      badge.className = "outcome-badge outcome-denied";
      badge.textContent = outcome;
      icon.innerHTML = "";
      reason.textContent = result.reason || (result.error && result.error.message) || JSON.stringify(result);
    }
  }

  async function reloadSelectedRecord(recordId) {
    try {
      const res = await apiFetch(`/records/${recordId}`);
      if (res.ok) {
        const data = await res.json();
        state.selectedRecord = data;
        renderRecordDetail(data);
        // Also refresh the background records list
        loadRecords();
      }
    } catch (e) {
      console.warn("Could not reload record:", e);
    }
  }

  // --- Upload Flow: Presigned S3 PUT + Record Registration (B7) ---
  const ALLOWED_CONTENT_TYPES = new Set([
    "application/pdf",
    "text/plain",
    "image/png",
    "image/jpeg",
  ]);

  function handleFileSelected(file) {
    if (!file) return;

    if (!state.sessionToken) {
      showToast("Please log in to upload files.", "error");
      renderAuthUI();
      return;
    }

    // Validate type
    const mime = file.type || (file.name.endsWith(".txt") ? "text/plain" : (file.name.endsWith(".pdf") ? "application/pdf" : "application/octet-stream"));
    if (!ALLOWED_CONTENT_TYPES.has(mime)) {
      showUploadAlert(`Invalid file format (${mime || "unrecognized"}). Allowed formats: PDF, TXT, PNG, JPEG.`, "error");
      clearSelectedFile();
      return;
    }

    state.selectedFile = file;
    el("preview-filename").textContent = file.name;
    el("preview-filesize").textContent = formatBytes(file.size);
    el("preview-filetype").textContent = mime;

    el("drop-zone-content").style.display = "none";
    el("file-preview-card").style.display = "flex";
    el("btn-start-upload").disabled = false;
    clearUploadAlert();
  }

  function clearSelectedFile() {
    state.selectedFile = null;
    el("file-input").value = "";
    el("drop-zone-content").style.display = "flex";
    el("file-preview-card").style.display = "none";
    el("btn-start-upload").disabled = true;
    clearUploadAlert();
  }

  function showUploadAlert(msg, type = "error") {
    const alert = el("upload-alert");
    if (!alert) return;
    alert.style.display = "block";
    alert.className = `alert-banner alert-${type}`;
    alert.textContent = msg;
  }

  function clearUploadAlert() {
    const alert = el("upload-alert");
    if (alert) alert.style.display = "none";
  }

  function updateUploadProgress(stepText, percent) {
    el("upload-progress-box").style.display = "block";
    el("progress-step-text").textContent = stepText;
    el("progress-percent-text").textContent = `${Math.round(percent)}%`;
    el("progress-bar-fill").style.width = `${percent}%`;
  }

  async function executeUpload() {
    if (!state.sessionToken) {
      showToast("Please log in to upload files.", "error");
      renderAuthUI();
      return;
    }

    if (!state.selectedFile) return;
    const file = state.selectedFile;
    const mime = file.type || (file.name.endsWith(".txt") ? "text/plain" : "application/pdf");
    const retentionMode = el("retention-mode-select").value;
    const retentionMins = parseInt(el("retention-duration-input").value || "10", 10);

    const startBtn = el("btn-start-upload");
    startBtn.disabled = true;

    try {
      // Step 1: Call POST /uploads/presign with file's name and MIME type
      updateUploadProgress("Requesting presigned upload URL from API...", 25);
      
      const presignRes = await apiFetch("/uploads/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: file.name,
          contentType: mime,
        }),
      });

      if (!presignRes.ok) {
        if (presignRes.status === 404) {
          throw new Error("POST /uploads/presign returned 404. Ensure create-presigned-upload Lambda and route are wired into auditlock-dashboard-api.");
        }
        const errJson = await presignRes.json().catch(() => ({}));
        throw new Error(errJson.error?.message || `Presign request failed with HTTP ${presignRes.status}`);
      }

      const presignData = await presignRes.json();
      const { uploadUrl, s3Bucket, s3Key } = presignData;

      // Step 2: PUT raw file directly to uploadUrl (not through the API)
      updateUploadProgress("Uploading directly to S3 Object Lock bucket...", 50);

      const uploadResult = await uploadFileToS3(uploadUrl, file, mime, (percent) => {
        const overall = 50 + percent * 0.35; // 50% to 85%
        updateUploadProgress(`Uploading directly to S3: ${Math.round(percent)}%`, overall);
      });

      // Step 3: Register record metadata via POST /records with retentionMode "NONE" (or selected)
      updateUploadProgress("Registering record in DynamoDB AuditRecords...", 90);

      let retentionUntil = null;
      if (retentionMode === "GOVERNANCE") {
        const d = new Date(Date.now() + retentionMins * 60 * 1000);
        retentionUntil = d.toISOString();
      }

      const recordBody = {
        fileName: file.name,
        s3Bucket: s3Bucket || S3_BUCKET_NAME,
        s3Key: s3Key,
        s3VersionId: uploadResult.versionId || `v-${Date.now()}`,
        retentionMode: retentionMode || "NONE",
        retentionUntil: retentionUntil,
        isDemoObject: true,
      };

      const recordRes = await apiFetch("/records", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(recordBody),
      });

      if (!recordRes.ok) {
        const errJson = await recordRes.json().catch(() => ({}));
        throw new Error(errJson.error?.message || `Failed to register record: HTTP ${recordRes.status}`);
      }

      const createdRecord = await recordRes.json();

      // Step 4: Show upload progress and clear success state
      updateUploadProgress("Complete!", 100);
      showToast(`Successfully registered audit record for ${file.name}`, "success");

      // Step 5: On success, refresh records list
      setTimeout(() => {
        el("upload-progress-box").style.display = "none";
        el("upload-panel").style.display = "none";
        clearSelectedFile();
        startBtn.disabled = false;
        loadRecords();
        // Open the newly created record
        if (createdRecord.recordId) {
          openRecordDetail(createdRecord.recordId);
        }
      }, 1000);

    } catch (err) {
      console.error("Upload flow error:", err);
      showUploadAlert(err.message, "error");
      el("upload-progress-box").style.display = "none";
      startBtn.disabled = false;
    }
  }

  function uploadFileToS3(uploadUrl, file, contentType, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", uploadUrl, true);
      xhr.setRequestHeader("Content-Type", contentType);

      if (xhr.upload) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const percent = (e.loaded / e.total) * 100;
            onProgress(percent);
          }
        };
      }

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const versionId = xhr.getResponseHeader("x-amz-version-id") || xhr.getResponseHeader("ETag")?.replace(/"/g, "") || `v-${Date.now()}`;
          resolve({ response: xhr.response, versionId });
        } else {
          reject(new Error(`S3 PUT failed with status ${xhr.status}: ${xhr.statusText}`));
        }
      };

      xhr.onerror = () => {
        reject(new Error("Network error during direct S3 PUT upload. Verify bucket CORS rules allow PUT."));
      };

      xhr.send(file);
    });
  }

  // Escape HTML helper
  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // --- Event Listeners Initialization ---
  function initEventListeners() {
    // Refresh Button
    el("btn-refresh-records")?.addEventListener("click", () => loadRecords());

    // Upload Panel Toggles
    el("btn-trigger-upload")?.addEventListener("click", () => {
      const panel = el("upload-panel");
      panel.style.display = panel.style.display === "none" ? "block" : "none";
      if (panel.style.display === "block") {
        panel.scrollIntoView({ behavior: "smooth" });
      }
    });
    el("btn-close-upload")?.addEventListener("click", () => {
      el("upload-panel").style.display = "none";
    });
    el("btn-cancel-upload")?.addEventListener("click", () => {
      el("upload-panel").style.display = "none";
      clearSelectedFile();
    });

    // File Drop Zone
    const dropZone = el("drop-zone");
    const fileInput = el("file-input");

    dropZone?.addEventListener("click", (e) => {
      if (e.target !== el("btn-remove-file")) {
        fileInput.click();
      }
    });

    fileInput?.addEventListener("change", (e) => {
      if (e.target.files && e.target.files[0]) {
        handleFileSelected(e.target.files[0]);
      }
    });

    ["dragenter", "dragover"].forEach((eventName) => {
      dropZone?.addEventListener(eventName, (e) => {
        e.preventDefault();
        dropZone.classList.add("dragover");
      });
    });

    ["dragleave", "drop"].forEach((eventName) => {
      dropZone?.addEventListener(eventName, (e) => {
        e.preventDefault();
        dropZone.classList.remove("dragover");
      });
    });

    dropZone?.addEventListener("drop", (e) => {
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleFileSelected(e.dataTransfer.files[0]);
      }
    });

    el("btn-remove-file")?.addEventListener("click", (e) => {
      e.stopPropagation();
      clearSelectedFile();
    });

    // Retention duration group toggle
    el("retention-mode-select")?.addEventListener("change", (e) => {
      const group = el("retention-duration-group");
      if (group) group.style.display = e.target.value === "GOVERNANCE" ? "flex" : "none";
    });

    // Start upload button
    el("btn-start-upload")?.addEventListener("click", executeUpload);

    // Search & Filter chips
    el("filter-search-input")?.addEventListener("input", () => renderRecordsTable());

    document.querySelectorAll(".filter-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        document.querySelectorAll(".filter-chip").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        state.activeFilter = chip.getAttribute("data-filter") || "ALL";
        renderRecordsTable();
      });
    });

    // Modals
    el("btn-close-detail")?.addEventListener("click", () => {
      el("detail-modal").style.display = "none";
    });
    el("detail-modal")?.addEventListener("click", (e) => {
      if (e.target === el("detail-modal")) {
        el("detail-modal").style.display = "none";
      }
    });

    // Delete Buttons in Detail Modal
    el("btn-attempt-delete")?.addEventListener("click", handleStandardDeleteAttempt);
    el("btn-attempt-admin-delete")?.addEventListener("click", handleAdminDeleteAttempt);

    // GitHub OAuth Button (B6)
    el("btn-login-github")?.addEventListener("click", () => {
      const clientId = state.githubClientId || "Ov23liauExample";
      const oauthUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&scope=read:user`;
      window.location.href = oauthUrl;
    });

    // Logout Button
    el("btn-logout")?.addEventListener("click", logout);

    // Simulated Role Switcher (Fast Demo Login)
    const roleWrapper = el("sim-role-dropdown");
    el("btn-demo-roles")?.addEventListener("click", (e) => {
      e.stopPropagation();
      roleWrapper.classList.toggle("open");
    });
    document.addEventListener("click", (e) => {
      if (!roleWrapper.contains(e.target)) {
        roleWrapper.classList.remove("open");
      }
    });

    el("btn-quick-admin")?.addEventListener("click", () => {
      simulateRoleLogin("admin", "sai-admin");
    });
    el("btn-quick-user")?.addEventListener("click", () => {
      simulateRoleLogin("user", "auditor-1");
    });

    el("btn-simulate-admin")?.addEventListener("click", () => {
      roleWrapper.classList.remove("open");
      simulateRoleLogin("admin", "sai-admin");
    });
    el("btn-simulate-user")?.addEventListener("click", () => {
      roleWrapper.classList.remove("open");
      simulateRoleLogin("user", "auditor-1");
    });
    el("btn-custom-token")?.addEventListener("click", () => {
      roleWrapper.classList.remove("open");
      const token = prompt("Paste raw Bearer session token:");
      if (token) {
        sessionStorage.setItem("auditlock_session_token", token.trim());
        state.sessionToken = token.trim();
        decodeAndApplySession();
        renderAuthUI();
        showToast("Custom token set", "success");
        loadRecords();
      }
    });

    // Settings Modal
    el("btn-open-settings")?.addEventListener("click", () => {
      el("setting-api-url").value = state.apiBase;
      el("setting-github-client-id").value = state.githubClientId;
      el("settings-modal").style.display = "flex";
    });
    el("btn-close-settings")?.addEventListener("click", () => {
      el("settings-modal").style.display = "none";
    });
    el("settings-modal")?.addEventListener("click", (e) => {
      if (e.target === el("settings-modal")) {
        el("settings-modal").style.display = "none";
      }
    });
    el("btn-save-settings")?.addEventListener("click", () => {
      const newApi = el("setting-api-url").value.trim().replace(/\/+$/, "");
      const newClientId = el("setting-github-client-id").value.trim();
      state.apiBase = newApi || DEFAULT_API_BASE;
      state.githubClientId = newClientId;
      localStorage.setItem("auditlock_api_base", state.apiBase);
      localStorage.setItem("auditlock_gh_client_id", state.githubClientId);
      updateGitHubLoginUrls();
      el("settings-modal").style.display = "none";
      showToast("Settings updated", "success");
      if (state.sessionToken) {
        loadRecords();
      }
    });
  }

  // --- Bootstrap ---
  window.AuditLock = {
    loadRecords,
    openRecordDetail,
    simulateRoleLogin,
    logout,
  };

  document.addEventListener("DOMContentLoaded", () => {
    initAuth();
    initEventListeners();
    // B6: Only attempt API calls when authenticated
    if (state.sessionToken) {
      loadRecords();
    }
  });
})();
