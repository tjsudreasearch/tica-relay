const root = document.getElementById("root");
let refreshTimer = null;
let activeProjectId = null;
let dashboardProjects = [];
let activeFilter = new URLSearchParams(location.search).get("status") || "all";
let dashboardAdmins = [];
let authContext = { hasOwner: false, hasAdmins: false, pendingAdminCount: 0, currentAdmin: null, shareOrigin: "" };
let currentAdmin = null;
let createProjectSubmitting = false;

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function toDatetimeLocal(value) {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function fromDatetimeLocal(value) {
  if (!value) return "";
  return new Date(value).toISOString();
}

function countCharacters(text, countWhitespace) {
  const value = String(text ?? "");
  return countWhitespace ? value.length : value.replace(/\s/g, "").length;
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

async function api(url, options = {}) {
  const request = { ...options };
  request.credentials = "same-origin";
  request.headers = { ...(request.headers || {}) };
  if (request.body && typeof request.body !== "string" && !(request.body instanceof FormData)) {
    request.headers["Content-Type"] = "application/json";
    request.body = JSON.stringify(request.body);
  }
  const response = await fetch(url, request);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || (response.status === 401 ? "관리자 로그인이 필요합니다." : "요청에 실패했습니다."));
    error.status = response.status;
    error.payload = data;
    error.url = url;
    if (response.status === 401 && String(url).startsWith("/api/admin/")) {
      currentAdmin = null;
      authContext.currentAdmin = null;
      authContext.pendingAdminCount = authContext.pendingAdminCount || 0;
      showAdminLoginScreen("관리자 세션이 만료되었습니다. 다시 로그인해 주세요.");
    }
    throw error;
  }
  return data;
}

async function loadAuthContext() {
  authContext = await api("/api/auth/context");
  currentAdmin = authContext.currentAdmin || null;
  return authContext;
}

function adminTopbarRight() {
  if (!currentAdmin) {
    return "";
  }
  return `
    <div class="actions">
      <span class="pill gray">${esc(currentAdmin.name || currentAdmin.adminId)} · ${esc(roleLabel(currentAdmin.role))}</span>
      <button class="btn" onclick="logoutAdmin()">로그아웃</button>
    </div>
  `;
}

function handleAdminError(error, messageId = "") {
  if (error && error.status === 401) {
    currentAdmin = null;
    authContext.currentAdmin = null;
    showAdminLoginScreen("관리자 세션이 만료되었습니다. 다시 로그인해 주세요.");
    return true;
  }
  const message = messageId ? document.getElementById(messageId) : null;
  if (message) {
    message.innerHTML = `<div class="notice error">${esc(error.message)}</div>`;
  } else {
    alert(error.message);
  }
  return false;
}

function layout({ eyebrow = "", title = "", subtitle = "", actions = "", content = "", topbarRight = "" }) {
  root.innerHTML = `
    <div class="app">
      <header class="topbar">
        <div>
          <div class="brand">TiCa Relay</div>
        </div>
        ${topbarRight}
      </header>
      <main class="container">
        <section class="card hero ${subtitle ? "" : "hero-compact"}">
          <div>
            ${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ""}
            <h1>${esc(title)}</h1>
            ${subtitle ? `<p>${esc(subtitle)}</p>` : ""}
          </div>
          ${actions ? `<div class="hero-actions">${actions}</div>` : ""}
        </section>
        ${content}
      </main>
    </div>
  `;
}

function projectPath(id) {
  return `/?apply=${encodeURIComponent(id)}`;
}

function participantPath(token) {
  return `/?token=${encodeURIComponent(token)}`;
}

function adminProjectPath(id) {
  return `/?project=${encodeURIComponent(id)}`;
}

function absoluteUrl(path) {
  const baseOrigin = authContext.shareOrigin || location.origin;
  return new URL(path, baseOrigin).toString();
}

function linkChip(path) {
  const url = absoluteUrl(path);
  return `<a class="share-link" href="${esc(url)}">${esc(url)}</a>`;
}

function openView(view) {
  location.href = `/?view=${encodeURIComponent(view)}`;
}

function openApplyFromForm() {
  const value = document.getElementById("applyProjectId").value.trim();
  if (!value) {
    alert("프로젝트 ID를 입력해 주세요.");
    return;
  }
  location.href = `/?apply=${encodeURIComponent(value)}`;
}

function openParticipantFromForm() {
  const value = document.getElementById("participantToken").value.trim();
  if (!value) {
    alert("개인 링크 토큰을 입력해 주세요.");
    return;
  }
  location.href = `/?token=${encodeURIComponent(value)}`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    alert("복사되었습니다.");
  } catch {
    window.prompt("아래 내용을 복사해 주세요.", text);
  }
}

function roleLabel(role) {
  const labels = {
    owner: "Owner",
    admin: "Admin",
  };
  return labels[role] || role;
}

function statusLabel(status) {
  const labels = {
    active: "활성",
    archived: "보관",
    completed: "완료",
    draft: "초안",
    pending: "승인 대기",
    pending_review: "검수 대기",
    recruiting: "모집 중",
    rejected: "거절",
    revision_requested: "수정 요청",
    running: "진행 중",
    selected: "확정",
    skipped: "건너뜀",
    submitted: "제출 완료",
    suspended: "정지",
    waiting: "대기",
    writing: "작성 중",
    paused: "일시정지",
  };
  return labels[status] || status;
}

function reviewStateLabel(state) {
  const labels = {
    rejected: "반려",
    revision_requested: "수정 요청",
  };
  return labels[state] || statusLabel(state);
}

function statusPill(status) {
  const map = {
    active: "green",
    draft: "gray",
    pending: "slate",
    recruiting: "green",
    running: "green",
    paused: "slate",
    completed: "green",
    archived: "gray",
    pending_review: "slate",
    revision_requested: "gray",
    rejected: "red",
    selected: "green",
    suspended: "red",
    waiting: "gray",
    writing: "green",
    submitted: "green",
    skipped: "red",
  };
  return `<span class="pill ${map[status] || "gray"}">${esc(statusLabel(status))}</span>`;
}

function booleanPill(value, yes = "활성", no = "비활성") {
  return `<span class="pill ${value ? "green" : "gray"}">${value ? yes : no}</span>`;
}

function recruitmentPill(project) {
  if (project.canApply) {
    return '<span class="pill green">모집 중</span>';
  }
  const message = String(project.applyMessage || "");
  if (message.includes("시작 전")) {
    return '<span class="pill slate">모집 전</span>';
  }
  if (message.includes("종료")) {
    return '<span class="pill gray">모집 종료</span>';
  }
  return '<span class="pill gray">모집 닫힘</span>';
}

function countCard(label, value) {
  return `<div class="stat"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
}

function setFieldInvalid(id, invalid) {
  const field = document.getElementById(id);
  if (field) {
    field.classList.toggle("is-invalid", invalid);
  }
  return field;
}

function showInlineError(messageId, text) {
  const message = document.getElementById(messageId);
  if (message) {
    message.innerHTML = `<div class="notice error">${esc(text)}</div>`;
  }
}

function choiceCard({ title, description, actionLabel, action, accent = "secondary", disabled = false }) {
  return `
    <article class="project-card">
      <div class="project-meta">
        <span class="pill gray">${esc(title)}</span>
      </div>
      <div>
        <h3>${esc(title)}</h3>
        <p>${esc(description)}</p>
      </div>
      <div class="actions">
        <button class="btn ${accent}" ${disabled ? "disabled" : ""} ${disabled ? "" : `onclick="${action}"`}>${esc(actionLabel)}</button>
      </div>
    </article>
  `;
}

function formatWindow(project) {
  return project.visibleWindowAll ? "전체 공개" : `최근 ${project.visibleWindow}개`;
}

function formatCharacterLimit(project) {
  if (project.characterLimitMode !== "limit") return "제한 없음";
  return `${project.characterLimit}자(${project.countWhitespace ? "공백 포함" : "공백 제외"})`;
}

function formatDateTimeCompact(value) {
  if (!value) return "미설정";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatRecruitmentPeriod(project) {
  return `${formatDateTimeCompact(project.recruitmentStartAt)} ~ ${formatDateTimeCompact(project.recruitmentEndAt)}`;
}

function participantLabel(participant) {
  if (!participant) return "참가자";
  const name = String(participant.name || "").trim();
  const studentId = String(participant.studentId || "").trim();
  if (name && studentId) return `${name} · ${studentId}`;
  return name || studentId || "참가자";
}

function filterLabel(filter) {
  const labels = {
    all: "전체",
    draft: "초안",
    recruiting: "모집",
    running: "진행",
    paused: "일시정지",
    completed: "완료",
    archived: "보관",
  };
  return labels[filter] || filter;
}

function projectCard(project) {
  return `
    <article class="project-card">
      <div class="project-meta">
        ${statusPill(project.status)}
        ${recruitmentPill(project)}
      </div>
      <div>
        <h3>${esc(project.name)}</h3>
        <p>${esc(project.description || "설명 없음")}</p>
      </div>
      <div class="project-stats">
        <div class="mini-stat"><span>신청</span><strong>${project.applicationCount}</strong></div>
        <div class="mini-stat"><span>확정</span><strong>${project.selectedCount}</strong></div>
        <div class="mini-stat"><span>문장</span><strong>${Math.max(0, project.sentenceCount - 1)}</strong></div>
      </div>
      <div class="helper">
        모집 기간: ${esc(formatRecruitmentPeriod(project))}<br>
        공개 범위: ${esc(formatWindow(project))}<br>
        글자 제한: ${esc(formatCharacterLimit(project))}
      </div>
      <div class="actions">
        <a class="btn primary" href="${esc(adminProjectPath(project.id))}">관리</a>
        <button class="btn danger" onclick="deleteProject('${project.id}')">삭제</button>
      </div>
      <div class="link-row">
        ${linkChip(projectPath(project.id))}
        <button class="btn" onclick="copyText('${absoluteUrl(projectPath(project.id))}')">신청 링크 복사</button>
      </div>
    </article>
  `;
}

function filterTabs(projects) {
  const statuses = ["all", "draft", "recruiting", "running", "paused", "completed", "archived"];
  return statuses.map((status) => {
    const count = status === "all" ? projects.length : projects.filter((project) => project.status === status).length;
    return `<button class="tab ${activeFilter === status ? "active" : ""}" onclick="setFilter('${status}')">${filterLabel(status)} ${count}</button>`;
  }).join("");
}

function renderAdminManagement(admins) {
  const pendingAdmins = admins.filter((admin) => admin.role === "admin" && admin.status === "pending");
  const activeAdmins = admins.filter((admin) => admin.role === "admin" && admin.status === "active");
  const inactiveAdmins = admins.filter((admin) => admin.role === "admin" && admin.status !== "pending" && admin.status !== "active");

  const renderRow = (admin, actionButtons = "") => `
    <div class="table-row">
      <div>
        <strong>${esc(admin.name || admin.adminId)} · ${esc(admin.adminId)}</strong>
        <small>${esc(roleLabel(admin.role))} · ${esc(statusLabel(admin.status))}${admin.appliedAt ? ` · 신청 ${esc(formatDate(admin.appliedAt))}` : ""}</small>
      </div>
      <div class="link-row">
        <div class="project-meta">
          ${statusPill(admin.status)}
          <span class="pill gray">${esc(roleLabel(admin.role))}</span>
        </div>
        ${actionButtons}
      </div>
    </div>
  `;

  return `
    <section class="card panel section">
      <div class="section-head">
        <div>
          <h2>관리자 승인</h2>
          <p>Owner만 관리자 신청과 승인 기록을 확인합니다.</p>
        </div>
      </div>
      <div class="split">
        <article class="card panel" style="background: rgba(248,250,252,0.78); box-shadow:none">
          <div class="section-head">
            <div>
              <h2>승인 대기</h2>
              <p>새 관리자 신청을 승인하거나 거절합니다.</p>
            </div>
          </div>
          <div class="table-list">
            ${pendingAdmins.length ? pendingAdmins.map((admin) => renderRow(admin, `
              <div class="actions">
                <button class="btn primary" onclick="approveAdmin('${admin.id}')">승인</button>
                <button class="btn" onclick="rejectAdmin('${admin.id}')">거절</button>
                <button class="btn danger" onclick="deleteAdmin('${admin.id}')">삭제</button>
              </div>
            `)).join("") : '<div class="empty">승인 대기 중인 신청이 없습니다.</div>'}
          </div>
        </article>
        <article class="card panel" style="background: rgba(248,250,252,0.78); box-shadow:none">
          <div class="section-head">
            <div>
              <h2>활성 관리자</h2>
              <p>현재 권한이 활성화된 관리자 계정입니다.</p>
            </div>
          </div>
          <div class="table-list">
            ${activeAdmins.length ? activeAdmins.map((admin) => renderRow(admin, `
              <div class="actions">
                <button class="btn primary" onclick="transferOwner('${admin.id}')">Owner 이전</button>
                <button class="btn" onclick="suspendAdmin('${admin.id}')">정지</button>
                <button class="btn danger" onclick="deleteAdmin('${admin.id}')">삭제</button>
              </div>
            `)).join("") : '<div class="empty">활성 관리자 계정이 없습니다.</div>'}
          </div>
          ${inactiveAdmins.length ? `
            <div class="space">
              <div class="section-head">
                <div>
                  <h2>비활성 계정</h2>
                  <p>거절되었거나 정지된 관리자 기록입니다.</p>
                </div>
              </div>
              <div class="table-list">
                ${inactiveAdmins.map((admin) => renderRow(admin, `
                  <div class="actions">
                    <button class="btn danger" onclick="deleteAdmin('${admin.id}')">삭제</button>
                  </div>
                `)).join("")}
              </div>
            </div>
          ` : ""}
        </article>
      </div>
    </section>
  `;
}

function renderDashboard(projects, admins = []) {
  const visibleProjects = activeFilter === "all"
    ? projects
    : projects.filter((project) => project.status === activeFilter);

  const counts = {
    total: projects.length,
    recruiting: projects.filter((project) => project.status === "recruiting").length,
    running: projects.filter((project) => project.status === "running").length,
    completed: projects.filter((project) => project.status === "completed").length,
    archived: projects.filter((project) => project.status === "archived").length,
  };

  layout({
    eyebrow: "",
    title: "프로젝트",
    subtitle: "",
    actions: `<button class="btn primary" onclick="showCreateProject()">새 프로젝트</button>`,
    topbarRight: adminTopbarRight(),
    content: `
      <section class="tabs section">${filterTabs(projects)}</section>
      <section class="stats section">
        ${countCard("전체 프로젝트", counts.total)}
        ${countCard("모집 중", counts.recruiting)}
        ${countCard("진행 중", counts.running)}
        ${countCard("완료/보관", counts.completed + counts.archived)}
      </section>
      <section class="card panel section">
        <div class="section-head">
          <div>
            <h2>프로젝트 목록</h2>
            <p>필요한 프로젝트만 간단히 관리합니다.</p>
          </div>
        </div>
        <div class="project-grid">
          ${visibleProjects.length ? visibleProjects.map(projectCard).join("") : '<div class="empty">현재 표시할 프로젝트가 없습니다.</div>'}
        </div>
      </section>
      ${currentAdmin && currentAdmin.role === "owner" ? renderAdminManagement(admins) : ""}
    `,
  });
}

async function adminHome() {
  stopAutoRefresh();
  activeProjectId = null;
  try {
    dashboardProjects = await api("/api/admin/projects");
    dashboardAdmins = currentAdmin && currentAdmin.role === "owner"
      ? await api("/api/admin/admins")
      : [];
    renderDashboard(dashboardProjects, dashboardAdmins);
  } catch (error) {
    if (handleAdminError(error)) {
      return;
    }
    alert(error.message);
  }
}

function showStartScreen() {
  stopAutoRefresh();
  activeProjectId = null;
  const hasOwner = Boolean(authContext.hasOwner);
  layout({
    eyebrow: "시작",
    title: "TiCa Relay",
    subtitle: hasOwner
      ? "역할을 선택하세요."
      : "처음에는 Owner 계정을 만듭니다.",
    content: `
      <section class="project-grid section">
        ${choiceCard({
          title: "Owner 생성",
          description: hasOwner
            ? "이미 설정되어 있습니다."
            : "최초 관리자 계정입니다.",
          actionLabel: hasOwner ? "완료" : "Owner 만들기",
          action: "showAdminSetupScreen()",
          disabled: hasOwner,
        })}
        ${choiceCard({
          title: "관리자 신청",
          description: "Owner 승인을 요청합니다.",
          actionLabel: "신청 화면",
          action: "showAdminApplyScreen()",
          accent: "primary",
        })}
        ${choiceCard({
          title: "관리자 로그인",
          description: "프로젝트를 관리합니다.",
          actionLabel: "로그인 화면",
          action: "showAdminLoginScreen()",
        })}
        ${choiceCard({
          title: "참가자",
          description: "신청하거나 집필합니다.",
          actionLabel: "참가자 화면",
          action: "showParticipantEntryScreen()",
        })}
      </section>
    `,
  });
}

function showAdminSetupScreen(message = "") {
  stopAutoRefresh();
  layout({
    eyebrow: "Owner 생성",
    title: "최초 Owner 만들기",
    subtitle: "이 화면은 처음 한 번만 사용할 수 있습니다.",
    actions: `<button class="btn" onclick="showStartScreen()">돌아가기</button>`,
    content: `
      <section class="card panel center section">
        ${message ? `<div class="notice error">${esc(message)}</div>` : ""}
        ${authContext.hasOwner ? '<div class="notice neutral">이미 Owner가 존재합니다. 초기 설정은 더 이상 사용할 수 없습니다.</div>' : ""}
        <div class="form-grid space">
          <div class="field full">
            <label for="ownerName">이름</label>
            <input id="ownerName" placeholder="예: 김OO">
          </div>
          <div class="field full">
            <label for="ownerAdminId">관리자 ID</label>
            <input id="ownerAdminId" placeholder="예: tica-owner">
          </div>
          <div class="field">
            <label for="ownerPassword">비밀번호</label>
            <input id="ownerPassword" type="password" placeholder="8자 이상">
          </div>
          <div class="field">
            <label for="ownerPasswordConfirm">비밀번호 확인</label>
            <input id="ownerPasswordConfirm" type="password" placeholder="다시 입력">
          </div>
        </div>
        <div class="actions space">
          <button class="btn secondary" onclick="showAdminApplyScreen()">관리자 신청으로</button>
          <button class="btn secondary" onclick="showAdminLoginScreen()">로그인 화면으로</button>
          <button class="btn primary" onclick="submitOwnerSetup()" ${authContext.hasOwner ? "disabled" : ""}>Owner 만들기</button>
        </div>
        <div id="ownerSetupMessage"></div>
      </section>
    `,
  });
}

function showAdminApplyScreen(message = "") {
  stopAutoRefresh();
  const isLoggedInAdmin = Boolean(currentAdmin);
  const applyDisabled = !authContext.hasOwner || isLoggedInAdmin;
  layout({
    eyebrow: "관리자 신청",
    title: "새 관리자 신청",
    subtitle: "신청 후 Owner 승인을 받아 활성화됩니다.",
    actions: `<button class="btn" onclick="showStartScreen()">돌아가기</button>`,
    content: `
      <section class="card panel center section">
        ${message ? `<div class="notice error">${esc(message)}</div>` : ""}
        ${!authContext.hasOwner ? '<div class="notice neutral">먼저 Owner를 만들어야 관리자 신청을 받을 수 있습니다.</div>' : ""}
        ${isLoggedInAdmin ? '<div class="notice neutral">이미 관리자 계정으로 로그인 중입니다. 새 관리자 신청은 로그아웃 후 진행해 주세요.</div>' : ""}
        <div class="form-grid space">
          <div class="field full">
            <label for="applyName">이름</label>
            <input id="applyName" placeholder="예: 김OO" ${applyDisabled ? "disabled" : ""}>
          </div>
          <div class="field full">
            <label for="applyAdminId">관리자 ID</label>
            <input id="applyAdminId" placeholder="예: tica-editor" ${applyDisabled ? "disabled" : ""}>
          </div>
          <div class="field">
            <label for="applyPassword">비밀번호</label>
            <input id="applyPassword" type="password" placeholder="8자 이상" ${applyDisabled ? "disabled" : ""}>
          </div>
          <div class="field">
            <label for="applyPasswordConfirm">비밀번호 확인</label>
            <input id="applyPasswordConfirm" type="password" placeholder="다시 입력" ${applyDisabled ? "disabled" : ""}>
          </div>
        </div>
        <div class="actions space">
          <button class="btn secondary" onclick="showAdminSetupScreen()">Owner 생성으로</button>
          <button class="btn secondary" onclick="showAdminLoginScreen()">로그인 화면으로</button>
          ${isLoggedInAdmin ? '<button class="btn secondary" onclick="logoutAdmin()">로그아웃</button>' : ""}
          <button class="btn primary" onclick="submitAdminApply()" ${applyDisabled ? "disabled" : ""}>관리자 신청</button>
        </div>
        <div id="adminApplyMessage"></div>
      </section>
    `,
  });
}

function showAdminLoginScreen(message = "") {
  stopAutoRefresh();
  layout({
    eyebrow: "관리자 로그인",
    title: "관리자 로그인",
    subtitle: "승인된 관리자 또는 Owner만 로그인할 수 있습니다.",
    actions: `<button class="btn" onclick="showStartScreen()">돌아가기</button>`,
    content: `
      <section class="card panel center section">
        ${message ? `<div class="notice error">${esc(message)}</div>` : ""}
        ${!authContext.hasOwner ? '<div class="notice neutral">아직 Owner가 없습니다. 먼저 Owner를 만들어 주세요.</div>' : ""}
        <div class="form-grid space">
          <div class="field full">
            <label for="loginAdminId">관리자 ID</label>
            <input id="loginAdminId" placeholder="아이디를 입력하세요">
          </div>
          <div class="field full">
            <label for="loginPassword">비밀번호</label>
            <input id="loginPassword" type="password" placeholder="비밀번호를 입력하세요">
          </div>
        </div>
        <div class="actions space">
          <button class="btn secondary" onclick="showAdminSetupScreen()">Owner 생성으로</button>
          <button class="btn secondary" onclick="showAdminApplyScreen()">관리자 신청으로</button>
          <button class="btn primary" onclick="submitAdminLogin()" ${authContext.hasOwner ? "" : "disabled"}>로그인</button>
        </div>
        <div id="adminLoginMessage"></div>
      </section>
    `,
  });
}

function showParticipantEntryScreen() {
  stopAutoRefresh();
  layout({
    eyebrow: "참가자",
    title: "참가자 화면",
    subtitle: "참가 신청 링크와 개인 링크로 들어갑니다.",
    actions: `<button class="btn" onclick="showStartScreen()">돌아가기</button>`,
    content: `
      <section class="split section">
        <article class="card panel">
          <div class="section-head">
            <div>
              <h2>참가 신청</h2>
              <p>프로젝트 신청 링크로 이동합니다.</p>
            </div>
          </div>
          <div class="field">
            <label for="applyProjectId">프로젝트 ID</label>
            <input id="applyProjectId" placeholder="프로젝트 ID를 입력하세요">
          </div>
          <div class="actions space">
            <button class="btn primary full" onclick="openApplyFromForm()">참가 신청 화면 열기</button>
          </div>
        </article>
        <article class="card panel">
          <div class="section-head">
            <div>
              <h2>개인 링크</h2>
              <p>참가자 개인 링크로 바로 들어갑니다.</p>
            </div>
          </div>
          <div class="field">
            <label for="participantToken">개인 링크 토큰</label>
            <input id="participantToken" placeholder="token을 입력하세요">
          </div>
          <div class="actions space">
            <button class="btn primary full" onclick="openParticipantFromForm()">참가 화면 열기</button>
          </div>
        </article>
      </section>
    `,
  });
}

async function submitOwnerSetup() {
  try {
    const result = await api("/api/auth/setup", {
      method: "POST",
      body: {
        name: document.getElementById("ownerName").value.trim(),
        adminId: document.getElementById("ownerAdminId").value.trim(),
        password: document.getElementById("ownerPassword").value,
        confirmPassword: document.getElementById("ownerPasswordConfirm").value,
      },
    });
    currentAdmin = result.admin;
    authContext.currentAdmin = result.admin;
    authContext.hasOwner = true;
    authContext.hasAdmins = true;
    authContext.pendingAdminCount = authContext.pendingAdminCount || 0;
    await adminHome();
  } catch (error) {
    if (!handleAdminError(error, "ownerSetupMessage")) {
      const message = document.getElementById("ownerSetupMessage");
      if (message) {
        message.innerHTML = `<div class="notice error">${esc(error.message)}</div>`;
      }
    }
  }
}

async function submitAdminApply() {
  try {
    const result = await api("/api/auth/apply", {
      method: "POST",
      body: {
        name: document.getElementById("applyName").value.trim(),
        adminId: document.getElementById("applyAdminId").value.trim(),
        password: document.getElementById("applyPassword").value,
        confirmPassword: document.getElementById("applyPasswordConfirm").value,
      },
    });
    const message = document.getElementById("adminApplyMessage");
    if (message) {
      message.innerHTML = `<div class="notice success">${esc(result.admin.name || result.admin.adminId)}님의 신청이 접수되었습니다. Owner 승인을 기다려 주세요.</div>`;
    }
    const password = document.getElementById("applyPassword");
    const passwordConfirm = document.getElementById("applyPasswordConfirm");
    if (password) password.value = "";
    if (passwordConfirm) passwordConfirm.value = "";
  } catch (error) {
    if (!handleAdminError(error, "adminApplyMessage")) {
      const message = document.getElementById("adminApplyMessage");
      if (message) {
        message.innerHTML = `<div class="notice error">${esc(error.message)}</div>`;
      }
    }
  }
}

async function submitAdminLogin() {
  try {
    const result = await api("/api/auth/login", {
      method: "POST",
      body: {
        adminId: document.getElementById("loginAdminId").value.trim(),
        password: document.getElementById("loginPassword").value,
      },
    });
    currentAdmin = result.admin;
    authContext.currentAdmin = result.admin;
    await adminHome();
  } catch (error) {
    if (!handleAdminError(error, "adminLoginMessage")) {
      const message = document.getElementById("adminLoginMessage");
      if (message) {
        message.innerHTML = `<div class="notice error">${esc(error.message)}</div>`;
      }
    }
  }
}

async function logoutAdmin() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    // 로그아웃은 세션이 없어도 로컬 상태를 지웁니다.
  }
  currentAdmin = null;
  authContext.currentAdmin = null;
  dashboardProjects = [];
  dashboardAdmins = [];
  activeProjectId = null;
  showStartScreen();
}

async function approveAdmin(id) {
  if (!confirm("이 관리자 신청을 승인할까요?")) return;
  await api(`/api/admin/admins/${id}/approve`, { method: "POST" });
  await adminHome();
}

async function rejectAdmin(id) {
  if (!confirm("이 관리자 신청을 거절할까요?")) return;
  await api(`/api/admin/admins/${id}/reject`, { method: "POST" });
  await adminHome();
}

async function suspendAdmin(id) {
  if (!confirm("이 관리자 계정을 정지할까요?")) return;
  await api(`/api/admin/admins/${id}/suspend`, { method: "POST" });
  await adminHome();
}

async function deleteAdmin(id) {
  const admin = dashboardAdmins.find((entry) => entry.id === id);
  const label = admin ? `${admin.name || admin.adminId} (${admin.adminId})` : "이 관리자";
  if (!confirm(`${label} 계정을 삭제할까요?\n삭제된 계정은 로그인할 수 없고 세션도 모두 해제됩니다.`)) return;
  try {
    await api(`/api/admin/admins/${id}`, { method: "DELETE" });
    await adminHome();
  } catch (error) {
    handleAdminError(error);
  }
}

async function transferOwner(id) {
  const admin = dashboardAdmins.find((entry) => entry.id === id);
  if (!admin) {
    alert("관리자 정보를 찾을 수 없습니다.");
    return;
  }
  if (!confirm(`${admin.name || admin.adminId} 관리자에게 Owner 권한을 이전할까요?\n이후 현재 Owner는 일반 Admin으로 변경됩니다.`)) return;
  const password = prompt("현재 Owner 비밀번호를 입력해 주세요.");
  if (!password) return;
  const confirmText = prompt(`확인을 위해 이전 대상 관리자 ID를 입력해 주세요: ${admin.adminId}`);
  if (confirmText !== admin.adminId) {
    alert("관리자 ID가 일치하지 않아 이전을 취소합니다.");
    return;
  }
  try {
    await api(`/api/admin/admins/${id}/transfer-owner`, {
      method: "POST",
      body: { password, confirmText },
    });
    await loadAuthContext();
    alert("Owner 이전이 완료되었습니다. 현재 계정은 일반 Admin 권한으로 전환되었습니다.");
    await adminHome();
  } catch (error) {
    handleAdminError(error);
  }
}

function setFilter(filter) {
  activeFilter = filter;
  renderDashboard(dashboardProjects, dashboardAdmins);
}

function projectForm(project, prefix, isEditable) {
  const disabledCore = isEditable ? "" : "disabled";
  const disabledAll = project.status === "completed" || project.status === "archived" ? "disabled" : "";
  return `
    <div class="settings-grid">
      <div class="field full">
        <label for="${prefix}-name">프로젝트명 *</label>
        <input id="${prefix}-name" value="${esc(project.name)}" placeholder="예: TiCa Relay 2026" required ${disabledAll}>
      </div>
      <div class="field full">
        <label for="${prefix}-description">설명</label>
        <input id="${prefix}-description" value="${esc(project.description || "")}" ${disabledAll}>
      </div>
      <div class="field">
        <label for="${prefix}-targetParticipants">목표 참가 인원</label>
        <input id="${prefix}-targetParticipants" type="number" min="1" value="${project.targetParticipants}" ${disabledCore}>
      </div>
      <div class="field">
        <label for="${prefix}-recruitmentStartAt">모집 시작</label>
        <input id="${prefix}-recruitmentStartAt" type="datetime-local" value="${esc(toDatetimeLocal(project.recruitmentStartAt))}" ${disabledCore}>
      </div>
      <div class="field">
        <label for="${prefix}-recruitmentEndAt">모집 종료</label>
        <input id="${prefix}-recruitmentEndAt" type="datetime-local" value="${esc(toDatetimeLocal(project.recruitmentEndAt))}" ${disabledCore}>
      </div>
      <div class="field full">
        <div class="toggle-row">
          <div>
            <strong>이전 문장 전체 공개</strong>
            <span>최근 N개 문장만 보여주거나 전체 공개로 전환합니다.</span>
          </div>
          <input id="${prefix}-visibleWindowAll" type="checkbox" ${project.visibleWindowAll ? "checked" : ""} ${disabledCore}>
        </div>
      </div>
      <div class="field">
        <label for="${prefix}-visibleWindow">최근 문장 수</label>
        <input id="${prefix}-visibleWindow" type="number" min="1" value="${project.visibleWindow}" ${disabledCore}>
      </div>
      <div class="field">
        <label for="${prefix}-characterLimitMode">글자 수 제한</label>
        <select id="${prefix}-characterLimitMode" ${disabledCore}>
          <option value="none" ${project.characterLimitMode === "none" ? "selected" : ""}>제한 없음</option>
          <option value="limit" ${project.characterLimitMode === "limit" ? "selected" : ""}>제한 적용</option>
        </select>
      </div>
      <div class="field">
        <label for="${prefix}-characterLimit">최대 글자 수</label>
        <input id="${prefix}-characterLimit" type="number" min="1" value="${project.characterLimit}" ${disabledCore}>
      </div>
      <div class="field">
        <div class="toggle-row">
          <div>
            <strong>공백 포함</strong>
            <span>체크하면 공백까지 포함해 글자 수를 계산합니다.</span>
          </div>
          <input id="${prefix}-countWhitespace" type="checkbox" ${project.countWhitespace ? "checked" : ""} ${disabledCore}>
        </div>
      </div>
      <div class="field">
        <div class="toggle-row">
          <div>
            <strong>집필 순서 공개</strong>
            <span>참가자에게 자신의 순서를 보여줄지 결정합니다.</span>
          </div>
          <input id="${prefix}-revealOrderToParticipants" type="checkbox" ${project.revealOrderToParticipants ? "checked" : ""} ${disabledCore}>
        </div>
      </div>
      <div class="field">
        <div class="toggle-row">
          <div>
            <strong>전체 참가 인원 공개</strong>
            <span>참가자에게 모집 인원 규모를 보여줍니다.</span>
          </div>
          <input id="${prefix}-revealParticipantCountToParticipants" type="checkbox" ${project.revealParticipantCountToParticipants ? "checked" : ""} ${disabledCore}>
        </div>
      </div>
      <div class="field">
        <div class="toggle-row">
          <div>
            <strong>관리자 검수</strong>
            <span>제출 후 승인되어야 다음 참가자로 넘어갑니다.</span>
          </div>
          <input id="${prefix}-reviewEnabled" type="checkbox" ${project.reviewEnabled ? "checked" : ""} ${disabledCore}>
        </div>
      </div>
      <div class="field">
        <div class="toggle-row">
          <div>
            <strong>제출 후 수정 가능</strong>
            <span>검수 대기 중인 내용을 다시 제출할 수 있습니다.</span>
          </div>
          <input id="${prefix}-editableAfterSubmit" type="checkbox" ${project.editableAfterSubmit ? "checked" : ""} ${disabledCore}>
        </div>
      </div>
      <div class="field">
        <div class="toggle-row">
          <div>
            <strong>강제 스킵 허용</strong>
            <span>관리자가 현재 차례를 건너뛸 수 있습니다.</span>
          </div>
          <input id="${prefix}-allowSkip" type="checkbox" ${project.allowSkip ? "checked" : ""}>
        </div>
      </div>
      <div class="field">
        <div class="toggle-row">
          <div>
            <strong>일시정지 허용</strong>
            <span>진행 중인 릴레이를 멈추고 다시 이어갈 수 있습니다.</span>
          </div>
          <input id="${prefix}-allowPause" type="checkbox" ${project.allowPause ? "checked" : ""}>
        </div>
      </div>
      <div class="field">
        <div class="toggle-row">
          <div>
            <strong>TXT 다운로드</strong>
            <span>최종 원고를 TXT 파일로 내려받을 수 있습니다.</span>
          </div>
          <input id="${prefix}-txtDownloadEnabled" type="checkbox" ${project.txtDownloadEnabled ? "checked" : ""}>
        </div>
      </div>
      <div class="field full">
        <label for="${prefix}-firstSentence">첫 문장 *</label>
        <textarea id="${prefix}-firstSentence" placeholder="릴레이를 시작할 첫 문장을 입력하세요." required ${disabledCore}>${esc(project.firstSentence || "")}</textarea>
      </div>
    </div>
  `;
}

function settingsButtonLabel(project) {
  return project.status === "archived" || project.status === "completed" ? "보관" : "설정 저장";
}

function gatherProjectForm(prefix) {
  setFieldInvalid(`${prefix}-name`, false);
  setFieldInvalid(`${prefix}-firstSentence`, false);
  return {
    name: document.getElementById(`${prefix}-name`).value,
    description: document.getElementById(`${prefix}-description`).value,
    targetParticipants: Number(document.getElementById(`${prefix}-targetParticipants`).value),
    recruitmentStartAt: fromDatetimeLocal(document.getElementById(`${prefix}-recruitmentStartAt`).value),
    recruitmentEndAt: fromDatetimeLocal(document.getElementById(`${prefix}-recruitmentEndAt`).value),
    visibleWindow: Number(document.getElementById(`${prefix}-visibleWindow`).value),
    visibleWindowAll: document.getElementById(`${prefix}-visibleWindowAll`).checked,
    characterLimitMode: document.getElementById(`${prefix}-characterLimitMode`).value,
    characterLimit: Number(document.getElementById(`${prefix}-characterLimit`).value),
    countWhitespace: document.getElementById(`${prefix}-countWhitespace`).checked,
    revealOrderToParticipants: document.getElementById(`${prefix}-revealOrderToParticipants`).checked,
    revealParticipantCountToParticipants: document.getElementById(`${prefix}-revealParticipantCountToParticipants`).checked,
    reviewEnabled: document.getElementById(`${prefix}-reviewEnabled`).checked,
    editableAfterSubmit: document.getElementById(`${prefix}-editableAfterSubmit`).checked,
    allowSkip: document.getElementById(`${prefix}-allowSkip`).checked,
    allowPause: document.getElementById(`${prefix}-allowPause`).checked,
    txtDownloadEnabled: document.getElementById(`${prefix}-txtDownloadEnabled`).checked,
    firstSentence: document.getElementById(`${prefix}-firstSentence`).value,
  };
}

async function showCreateProject() {
  stopAutoRefresh();
  createProjectSubmitting = false;
  layout({
    eyebrow: "새 프로젝트",
    title: "프로젝트 만들기",
    subtitle: "",
    actions: `<button class="btn" onclick="adminHome()">돌아가기</button>`,
    topbarRight: adminTopbarRight(),
    content: `
      <section class="card panel center section">
        <div class="section-head">
          <div>
            <h2>프로젝트 설정</h2>
            <p>기본 문서의 규칙을 여기서 입력합니다.</p>
          </div>
        </div>
        ${projectForm({
          name: "",
          description: "",
          targetParticipants: 90,
          recruitmentStartAt: "",
          recruitmentEndAt: "",
          visibleWindow: 5,
          visibleWindowAll: false,
          characterLimitMode: "none",
          characterLimit: 100,
          countWhitespace: false,
          revealOrderToParticipants: false,
          revealParticipantCountToParticipants: false,
          reviewEnabled: false,
          editableAfterSubmit: false,
          allowSkip: true,
          allowPause: true,
          txtDownloadEnabled: true,
          firstSentence: "",
          status: "draft",
        }, "create", true)}
        <div class="actions space">
          <button class="btn" onclick="adminHome()">취소</button>
          <button id="createProjectButton" class="btn primary" onclick="createProject()">프로젝트 생성</button>
        </div>
        <div id="createMessage"></div>
      </section>
    `,
  });
}

async function createProject() {
  if (createProjectSubmitting) return;
  const payload = gatherProjectForm("create");
  if (!payload.name.trim()) {
    const field = setFieldInvalid("create-name", true);
    showInlineError("createMessage", "프로젝트명을 입력해 주세요.");
    field?.focus();
    return;
  }
  if (!payload.firstSentence.trim()) {
    const field = setFieldInvalid("create-firstSentence", true);
    showInlineError("createMessage", "첫 문장을 입력해 주세요.");
    field?.focus();
    return;
  }

  const button = document.getElementById("createProjectButton");
  createProjectSubmitting = true;
  if (button) {
    button.disabled = true;
    button.textContent = "생성 중...";
  }
  try {
    const project = await api("/api/admin/projects", {
      method: "POST",
      body: payload,
    });
    openProject(project.id);
  } catch (error) {
    if (document.getElementById("createMessage")) {
      showInlineError("createMessage", error.message);
    } else {
      alert(error.message);
    }
    createProjectSubmitting = false;
    if (button) {
      button.disabled = false;
      button.textContent = "프로젝트 생성";
    }
  }
}

async function openProject(id) {
  stopAutoRefresh();
  activeProjectId = id;
  try {
    const project = await api(`/api/admin/projects/${id}`);
    renderProject(project);
  } catch (error) {
    activeProjectId = null;
    if (!handleAdminError(error)) {
      alert(error.message);
      await adminHome();
    }
  }
}

function renderAuditItem(item) {
  const labels = {
    project_created: "프로젝트 생성",
    settings_update: "설정 변경",
    application_toggle: "모집 상태",
    application: "참가 신청",
    selection_draw: "참가자 추첨",
    order_draw: "순서 추첨",
    skip: "건너뛰기",
    status: "상태 변경",
    submission: "문장 제출",
    submission_pending: "검토 대기",
    review_approve: "검토 승인",
    review_revision: "수정 요청",
    review_reject: "반려",
  };

  const details = {
    project_created: "프로젝트가 생성되었습니다.",
    settings_update: "프로젝트 설정이 수정되었습니다.",
    application_toggle: `참가 신청이 ${item.open ? "열렸습니다." : "닫혔습니다."}`,
    application: `${item.name ? `${item.name} · ` : ""}${item.studentId}의 신청이 기록되었습니다.`,
    selection_draw: `신청자 ${item.applicantCount}명 중 ${item.selectedCount}명이 선정되었습니다.`,
    order_draw: `${item.participantCount}명의 집필 순서가 추첨되었습니다.`,
    skip: `${item.order}번 참가자가 건너뛰어졌습니다.`,
    status: `상태가 ${statusLabel(item.status)} 상태로 변경되었습니다.`,
    submission: `${item.order}번 참가자가 문장을 제출했습니다.`,
    submission_pending: `${item.order}번 참가자의 제출이 검토 대기 상태가 되었습니다.`,
    review_approve: `${item.order}번 참가자의 제출이 승인되었습니다.`,
    review_revision: `${item.order}번 참가자에게 수정 요청이 전달되었습니다.`,
    review_reject: `${item.order}번 참가자의 제출이 반려되었습니다.`,
  };

  return `
    <div class="timeline-item">
      <div class="project-meta">
        <span class="pill gray">${esc(labels[item.type] || item.type)}</span>
        <span class="muted">${esc(formatDate(item.at))}</span>
      </div>
      <p>${esc(details[item.type] || "기록을 확인할 수 없습니다.")}</p>
    </div>
  `;
}

function renderParticipantRows(project) {
  if (!project.participants.length) {
    return '<div class="empty">아직 확정된 참가자가 없습니다.</div>';
  }
  return project.participants.map((participant) => `
    <div class="table-row">
      <div>
        <strong>#${participant.order ?? "?"} · ${esc(participantLabel(participant))}</strong>
        <small>${esc(statusLabel(participant.status))}${participant.reviewState ? ` · ${esc(reviewStateLabel(participant.reviewState))}` : ""}</small>
      </div>
      <div class="project-meta">
        ${statusPill(participant.status)}
        ${participant.submittedAt ? `<span class="muted">${esc(formatDate(participant.submittedAt))}</span>` : '<span class="muted">대기</span>'}
      </div>
    </div>
  `).join("");
}

function renderReviewBox(project) {
  if (!project.pendingReview) {
    return '<div class="review-box">검수 대기 중인 문장이 없습니다.</div>';
  }
  const pending = project.pendingReview;
  const participant = project.participants.find((entry) => entry.token === pending.participantToken);
  return `
    <div class="review-box">
      <div class="section-head">
        <div>
          <h2>검수 대기</h2>
          <p>${esc(participant ? `${participant.order ?? "?"}번 · ${participantLabel(participant)}` : "참가자 제출")} 문장입니다.</p>
        </div>
      </div>
      <div class="sentence">${esc(pending.text)}</div>
      <div class="actions space">
        <button class="btn primary" onclick="approveReview('${project.id}')">승인</button>
        <button class="btn" onclick="requestRevision('${project.id}')">수정 요청</button>
        <button class="btn danger" onclick="rejectReview('${project.id}')">반려</button>
      </div>
    </div>
  `;
}

function renderApprovedSentences(project) {
  const sentences = project.sentences.filter((sentence) => sentence.status === "approved" || sentence.type === "admin");
  if (!sentences.length) {
    return '<div class="empty">아직 원고가 없습니다.</div>';
  }
  return sentences.map((sentence, index) => `
    <div class="sentence">
      <strong>${index === 0 ? "첫 문장" : `${index}번`}</strong>
      ${esc(sentence.text)}
    </div>
  `).join("");
}

function renderProject(project) {
  const currentParticipant = project.currentIndex !== null ? project.participants[project.currentIndex] : null;
  const canEditCore = project.status === "draft" || project.status === "recruiting";
  const applicationUrl = projectPath(project.id);
  const canSelect = project.status === "draft" || project.status === "recruiting";
  const canDraw = canSelect && project.participants.length > 0;
  const canPauseToggle = project.allowPause && (project.status === "running" || project.status === "paused");
  const canSkip = project.allowSkip && project.status === "running";
  const canArchive = project.status === "completed";
  const participantLinks = project.participants.length
    ? project.participants.map((participant) => {
      const link = participantPath(participant.token);
      return `
        <div class="table-row">
          <div>
            <strong>#${participant.order ?? "?"} · ${esc(participantLabel(participant))}</strong>
            <small>${esc(statusLabel(participant.status))}${participant.reviewState ? ` · ${esc(reviewStateLabel(participant.reviewState))}` : ""}</small>
          </div>
          <div class="link-row">
            ${linkChip(link)}
            <button class="btn" onclick="copyText('${absoluteUrl(link)}')">개인 링크 복사</button>
          </div>
        </div>
      `;
    }).join("")
    : '<div class="empty">아직 확정된 참가자가 없습니다.</div>';

  layout({
    eyebrow: "프로젝트 관리",
    title: project.name,
    subtitle: project.description || "설명 없음",
    actions: `
      <button class="btn" onclick="adminHome()">목록</button>
      <button class="btn secondary" onclick="downloadTxt('${project.id}')" ${project.txtDownloadEnabled ? "" : "disabled"}>TXT 다운로드</button>
      <button class="btn danger" onclick="deleteProject('${project.id}')">삭제</button>
    `,
    topbarRight: adminTopbarRight(),
    content: `
      <section class="stats section">
        ${countCard("신청", project.applicationCount)}
        ${countCard("확정", project.selectedCount)}
        ${countCard("승인 문장", Math.max(0, project.sentences.filter((sentence) => sentence.status === "approved" || sentence.type === "admin").length - 1))}
        ${countCard("현재 차례", currentParticipant ? `#${currentParticipant.order} · ${participantLabel(currentParticipant)}` : "없음")}
      </section>

      <section class="split section">
        <article class="card panel">
          <div class="section-head">
            <div>
              <h2>진행 제어</h2>
              <p>모집, 추첨, 순서, 일시정지, 스킵, 보관을 관리합니다.</p>
            </div>
            ${statusPill(project.status)}
          </div>
          <div class="actions">
            <button class="btn" onclick="toggleRecruitment('${project.id}', ${project.applicationOpen ? "false" : "true"})" ${project.status === "running" || project.status === "paused" || project.status === "completed" || project.status === "archived" ? "disabled" : ""}>
              ${project.applicationOpen ? "참가 모집 닫기" : "참가 모집 열기"}
            </button>
            <button class="btn" onclick="selectParticipants('${project.id}')" ${canSelect ? "" : "disabled"}>참가자 추첨</button>
            <button class="btn" onclick="drawOrder('${project.id}')" ${canDraw ? "" : "disabled"}>집필 순서 추첨</button>
            <button class="btn" onclick="togglePause('${project.id}')" ${canPauseToggle ? "" : "disabled"}>
              ${project.status === "paused" ? "재개" : "일시정지"}
            </button>
            <button class="btn danger" onclick="skipCurrent('${project.id}')" ${canSkip ? "" : "disabled"}>현재 차례 건너뛰기</button>
            <button class="btn secondary" onclick="setStatus('${project.id}', 'archived')" ${canArchive ? "" : "disabled"}>아카이브 보관</button>
          </div>
          <div class="space">
            <div class="section-head" style="margin-bottom:10px">
              <div>
                <h2>링크 배부</h2>
                <p>참가 신청 링크와 참가자 개인 링크를 바로 복사할 수 있습니다.</p>
              </div>
            </div>
            <div class="table-list">
              <div class="table-row">
                <div>
                  <strong>참가 신청 링크</strong>
                  <small>외부 참가자가 신청하는 링크입니다.</small>
                </div>
                <div class="link-row">
                  ${linkChip(applicationUrl)}
                  <button class="btn" onclick="copyText('${absoluteUrl(applicationUrl)}')">복사</button>
                </div>
              </div>
              ${participantLinks}
            </div>
          </div>
        </article>

        <article class="card panel">
          <div class="section-head">
            <div>
              <h2>참가자 상태</h2>
              <p>확정 결과와 집필 순서를 관리자만 확인할 수 있습니다.</p>
            </div>
          </div>
          <div class="table-list">
            ${renderParticipantRows(project)}
          </div>
          <div class="space">
            ${renderReviewBox(project)}
          </div>
        </article>
      </section>

      <section class="card panel section">
        <div class="section-head">
            <div>
              <h2>프로젝트 설정</h2>
              <p>모집 기한, 참가 인원, 공개 문장 수, 검수 여부, 첫 문장을 관리합니다.</p>
            </div>
          ${project.status === "completed" || project.status === "archived" ? '<span class="pill gray">수정 제한</span>' : canEditCore ? '<span class="pill green">편집 가능</span>' : statusPill(project.status)}
        </div>
        ${projectForm(project, "edit", canEditCore)}
        <div class="actions space">
          <button class="btn primary" onclick="updateProjectSettings('${project.id}')" ${project.status === "archived" || project.status === "completed" ? "disabled" : ""}>${settingsButtonLabel(project)}</button>
          <div id="settingsMessage"></div>
        </div>
      </section>

      <section class="split section">
        <article class="card panel">
          <div class="section-head">
            <div>
              <h2>원고</h2>
              <p>승인된 문장만 최종 원고에 반영됩니다.</p>
            </div>
          </div>
          <div class="script">
            ${renderApprovedSentences(project)}
          </div>
        </article>

        <article class="card panel">
          <div class="section-head">
            <div>
              <h2>기록</h2>
              <p>추첨, 상태 변경, 검토 과정의 기록을 보여줍니다.</p>
            </div>
          </div>
          <div class="timeline">
            ${project.audit.slice().reverse().map(renderAuditItem).join("")}
          </div>
        </article>
      </section>
    `,
  });
}

async function updateProjectSettings(id) {
  try {
    await api(`/api/admin/projects/${id}/settings`, {
      method: "PATCH",
      body: gatherProjectForm("edit"),
    });
    openProject(id);
  } catch (error) {
    const message = document.getElementById("settingsMessage");
    if (message) {
      message.innerHTML = `<div class="notice error">${esc(error.message)}</div>`;
    } else {
      alert(error.message);
    }
  }
}

async function deleteProject(id) {
  const confirmation = window.prompt("프로젝트를 삭제하면 되돌릴 수 없습니다. 삭제하려면 '삭제'를 입력해 주세요.");
  if (confirmation !== "삭제") {
    return;
  }
  try {
    await api(`/api/admin/projects/${id}`, { method: "DELETE" });
    activeProjectId = null;
    await adminHome();
  } catch (error) {
    alert(error.message);
  }
}

async function toggleRecruitment(id, open) {
  await api(`/api/admin/projects/${id}/application`, {
    method: "POST",
    body: { open: open === true || open === "true" },
  });
  openProject(id);
}

async function selectParticipants(id) {
  if (!confirm("신청자 중에서 참가자를 추첨할까요?")) return;
  await api(`/api/admin/projects/${id}/select`, { method: "POST" });
  openProject(id);
}

async function drawOrder(id) {
  if (!confirm("집필 순서를 추첨하고 릴레이를 시작할까요?")) return;
  await api(`/api/admin/projects/${id}/draw-order`, { method: "POST" });
  openProject(id);
}

async function skipCurrent(id) {
  if (!confirm("현재 차례를 건너뛰겠습니까?")) return;
  await api(`/api/admin/projects/${id}/skip`, { method: "POST" });
  openProject(id);
}

async function togglePause(id) {
  const project = await api(`/api/admin/projects/${id}`);
  const nextStatus = project.status === "paused" ? "running" : "paused";
  await api(`/api/admin/projects/${id}/status`, { method: "POST", body: { status: nextStatus } });
  openProject(id);
}

async function setStatus(id, status) {
  await api(`/api/admin/projects/${id}/status`, { method: "POST", body: { status } });
  openProject(id);
}

async function approveReview(id) {
  await api(`/api/admin/projects/${id}/review/approve`, { method: "POST" });
  openProject(id);
}

async function requestRevision(id) {
  await api(`/api/admin/projects/${id}/review/revision`, { method: "POST" });
  openProject(id);
}

async function rejectReview(id) {
  await api(`/api/admin/projects/${id}/review/reject`, { method: "POST" });
  openProject(id);
}

function downloadTxt(id) {
  window.location.href = `/api/admin/projects/${id}/export.txt`;
}

async function showApplyPage(projectId) {
  stopAutoRefresh();
  const project = await api(`/api/public/project/${projectId}`);
  const canApply = project.canApply === true;
  layout({
    eyebrow: "참가 신청",
    title: `${project.name} 참가 신청`,
    subtitle: project.description || "프로젝트 참가를 신청합니다.",
    actions: `<button class="btn" onclick="showParticipantEntryScreen()">참가자 화면</button>`,
    content: `
      <section class="card panel center section">
        <div class="project-meta">
          ${statusPill(project.status)}
          ${recruitmentPill(project)}
        </div>
        <div class="helper" style="margin-top:14px">
          공개 범위: ${esc(project.visibleWindowAll ? "전체 공개" : `최근 ${project.visibleWindow}개`)}<br>
          글자 제한: ${esc(project.characterLimitMode === "limit" ? `${project.characterLimit}자` : "제한 없음")}
        </div>
        ${canApply ? "" : `<div class="notice neutral">${esc(project.applyMessage || "현재 참가 신청을 받을 수 없습니다.")}</div>`}
        <div class="space">
          <label for="studentName">이름</label>
          <input id="studentName" placeholder="이름을 입력하세요" ${canApply ? "" : "disabled"}>
        </div>
        <div class="space">
          <label for="studentId">학번</label>
          <input id="studentId" inputmode="numeric" placeholder="학번을 입력하세요" ${canApply ? "" : "disabled"}>
          <div class="helper">이름과 학번은 관리자만 확인합니다.</div>
        </div>
        <div class="actions space">
          <button class="btn" onclick="showParticipantEntryScreen()">참가자 화면으로</button>
          <button id="applyButton" class="btn primary" onclick="submitApplication('${projectId}')" ${canApply ? "" : "disabled"}>참가 신청</button>
        </div>
        <div id="applyMessage"></div>
      </section>
    `,
  });
}

async function submitApplication(projectId) {
  const nameInput = document.getElementById("studentName");
  const studentIdInput = document.getElementById("studentId");
  const applyButton = document.getElementById("applyButton");
  const name = nameInput.value.trim();
  const studentId = studentIdInput.value.trim();
  if (!name) {
    const message = document.getElementById("applyMessage");
    if (message) {
      message.innerHTML = '<div class="notice error">이름을 입력해 주세요.</div>';
    }
    nameInput.focus();
    return;
  }
  if (!/^\d{4,12}$/.test(studentId)) {
    const message = document.getElementById("applyMessage");
    if (message) {
      message.innerHTML = '<div class="notice error">학번은 숫자만 입력해 주세요.</div>';
    }
    studentIdInput.focus();
    return;
  }
  if (applyButton) {
    applyButton.disabled = true;
    applyButton.textContent = "신청 중...";
  }
  try {
    await api(`/api/apply/${projectId}`, {
      method: "POST",
      body: { studentId, name },
    });
    const message = document.getElementById("applyMessage");
    if (message) {
      message.innerHTML = '<div class="notice success">참가 신청이 완료되었습니다. 추첨이 끝나면 관리자 화면에서 확인할 수 있습니다.</div>';
    }
    nameInput.disabled = true;
    studentIdInput.disabled = true;
  } catch (error) {
    const message = document.getElementById("applyMessage");
    if (message) {
      message.innerHTML = `<div class="notice error">${esc(error.message)}</div>`;
    } else {
      alert(error.message);
    }
    if (applyButton) {
      applyButton.disabled = false;
      applyButton.textContent = "참가 신청";
    }
  }
}

function participantActionButtonLabel(data) {
  if (data.state === "pending_review" && data.canEditPendingReview) return "다시 제출";
  return "문장 제출";
}

function isParticipantEditing(data) {
  return data && (data.state === "writing" || (data.state === "pending_review" && data.canEditPendingReview));
}

function renderParticipantScreen(data) {
  const canEdit = data.state === "writing" || (data.state === "pending_review" && data.canEditPendingReview);
  const draftValue = canEdit ? (data.draftText || "") : "";
  const currentCount = countCharacters(draftValue, data.project.countWhitespace);
  const limitLabel = data.project.characterLimitMode === "limit"
    ? `${currentCount} / ${data.project.characterLimit}자`
    : `${currentCount}자`;
  const visibilityLabel = data.project.visibleWindowAll ? "전체 공개" : `최근 ${data.project.visibleWindow}개`;

  const badges = [];
  if (data.myOrder != null) badges.push(`<span class="pill gray">순서 #${data.myOrder}</span>`);
  if (data.participantCount != null) badges.push(`<span class="pill gray">전체 ${data.participantCount}명</span>`);
  badges.push(`<span class="pill gray">${esc(visibilityLabel)}</span>`);

  const sharedHeader = `
    <div class="project-meta">${badges.join("")}</div>
  `;

  if (data.state === "writing" || (data.state === "pending_review" && data.canEditPendingReview)) {
    layout({
      eyebrow: data.state === "pending_review" ? "검토 대기" : "집필 중",
      title: data.project.name,
      subtitle: "최근 문장만 보고 한 문장을 작성합니다.",
      content: `
        <section class="card panel center section">
          ${sharedHeader}
          <div class="script space">
            ${data.visibleSentences.map((sentence) => `<div class="sentence">${esc(sentence.text)}</div>`).join("")}
          </div>
          ${data.reviewState === "revision_requested" ? '<div class="notice neutral">수정 요청이 있습니다. 내용을 고친 뒤 다시 제출하세요.</div>' : ""}
          ${data.reviewState === "rejected" ? '<div class="notice error">반려되었습니다. 내용을 다시 작성하세요.</div>' : ""}
          ${data.state === "pending_review" ? '<div class="notice neutral">검토 중입니다. 결과가 오면 다시 제출할 수 있습니다.</div>' : ""}
          <div class="space">
            <label for="answer">다음 문장</label>
            <textarea id="answer" placeholder="한 문장을 작성하세요.">${esc(draftValue)}</textarea>
            <div class="count">
              <span>${data.project.characterLimitMode === "limit" ? `제한: ${data.project.characterLimit}${data.project.countWhitespace ? "자(공백 포함)" : "자(공백 제외)"}` : "글자 제한 없음"}</span>
              <span id="charCount">${limitLabel}</span>
            </div>
          </div>
          <div class="actions space">
            <button class="btn primary full" onclick="submitSentence('${data.token}')">${participantActionButtonLabel(data)}</button>
          </div>
        </section>
      `,
    });

    const answer = document.getElementById("answer");
    const charCount = document.getElementById("charCount");
    if (answer && charCount) {
      answer.addEventListener("input", (event) => {
        const nextCount = countCharacters(event.target.value, data.project.countWhitespace);
        charCount.textContent = data.project.characterLimitMode === "limit"
          ? `${nextCount} / ${data.project.characterLimit}자`
          : `${nextCount}자`;
      });
      answer.dispatchEvent(new Event("input"));
    }
    return;
  }

  if (data.state === "pending_review") {
    layout({
      eyebrow: "검토 대기",
      title: data.project.name,
      subtitle: "제출한 문장을 검토 중입니다. 결과가 오면 다시 확인하세요.",
      content: `
        <section class="card panel center section">
          ${sharedHeader}
          <div class="notice neutral">현재 제출문은 검토 중입니다. 결과가 나오면 수정 요청 또는 승인 상태가 반영됩니다.</div>
        </section>
      `,
    });
    return;
  }

  if (data.state === "submitted") {
    layout({
      eyebrow: "제출 완료",
      title: data.project.name,
      subtitle: "문장을 제출했습니다. 다음 차례를 기다려 주세요.",
      content: `
        <section class="card panel center section">
          <div class="notice success">제출이 완료되었습니다. 현재는 대기 상태입니다.</div>
        </section>
      `,
    });
    return;
  }

  if (data.state === "paused") {
    layout({
      eyebrow: "일시정지",
      title: data.project.name,
      subtitle: "관리자가 릴레이를 잠시 멈춰둔 상태입니다.",
      content: `
        <section class="card panel center section">
          <div class="notice neutral">현재 프로젝트가 일시정지 상태입니다. 재개될 때 다시 확인하세요.</div>
        </section>
      `,
    });
    return;
  }

  if (data.state === "finished") {
    layout({
      eyebrow: "완료",
      title: data.project.name,
      subtitle: "릴레이가 끝났습니다.",
      content: `
        <section class="card panel center section">
          <div class="notice success">릴레이가 모두 완료되었습니다. 참여해 주셔서 감사합니다.</div>
        </section>
      `,
    });
    return;
  }

  layout({
    eyebrow: "대기",
    title: data.project.name,
    subtitle: "아직 당신 차례가 아닙니다. 차례가 오면 자동으로 바뀝니다.",
    content: `
      <section class="card panel center section">
        <div class="notice neutral">현재는 대기 상태입니다. 이 페이지를 열어 둔 채 기다려 주세요.</div>
      </section>
    `,
  });
}

async function participantPage(token) {
  stopAutoRefresh();

  async function render() {
    try {
      const data = await api(`/api/join/${token}`);
      renderParticipantScreen(data);
      if (isParticipantEditing(data)) {
        stopAutoRefresh();
      }
      return data;
    } catch (error) {
      layout({
        eyebrow: "오류",
        title: "유효하지 않은 개인 링크입니다.",
        subtitle: error.message,
        content: `
          <section class="card panel center section">
            <div class="notice error">${esc(error.message)}</div>
          </section>
        `,
      });
      return null;
    }
  }

  const initialData = await render();
  if (!isParticipantEditing(initialData)) {
    refreshTimer = setInterval(render, 2500);
  }
}

async function submitSentence(token) {
  const text = document.getElementById("answer").value.trim();
  if (!text) {
    alert("문장을 입력해 주세요.");
    return;
  }
  if (!confirm("제출한 문장은 수정할 수 없습니다. 제출하시겠습니까?")) return;

  const submitButton = document.querySelector("button[onclick^=\"submitSentence\"]");
  const submitButtonLabel = submitButton ? submitButton.textContent : "문장 제출";
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "제출 중...";
  }
  try {
    await api(`/api/join/${token}/submit`, {
      method: "POST",
      body: { text },
    });
    participantPage(token);
  } catch (error) {
    alert(error.message);
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = submitButtonLabel;
    }
  }
}

async function bootstrapApp() {
  const query = new URLSearchParams(location.search);
  const token = query.get("token");
  const apply = query.get("apply");
  const view = query.get("view");
  const project = query.get("project");

  if (token) {
    participantPage(token);
    return;
  }

  if (apply) {
    showApplyPage(apply);
    return;
  }

  if (view === "participant") {
    showParticipantEntryScreen();
    return;
  }

  await loadAuthContext().catch(() => {
    authContext = { hasOwner: false, hasAdmins: false, pendingAdminCount: 0, currentAdmin: null, shareOrigin: "" };
    currentAdmin = null;
  });

  if (view === "admin-setup") {
    showAdminSetupScreen();
    return;
  }

  if (view === "admin-apply") {
    showAdminApplyScreen();
    return;
  }

  if (view === "admin-login") {
    showAdminLoginScreen();
    return;
  }

  if (project) {
    if (currentAdmin) {
      await openProject(project);
    } else {
      showAdminLoginScreen("프로젝트 관리는 관리자 로그인 후 사용할 수 있습니다.");
    }
    return;
  }

  if (currentAdmin) {
    await adminHome();
    return;
  }

  showStartScreen();
}

bootstrapApp();













