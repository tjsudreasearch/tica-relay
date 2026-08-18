const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.VERCEL ? path.join(os.tmpdir(), "tica-relay-data") : path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "db.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const INDEX_FILE = path.join(PUBLIC_DIR, "index.html");
const ADMIN_SESSION_COOKIE = "tica_admin_session";
const ADMIN_SESSION_MAX_AGE = 60 * 60 * 24 * 14;
const LOGIN_RATE_LIMIT_MAX = 5;
const LOGIN_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_RATE_LIMIT_LOCK_MS = 15 * 60 * 1000;
const DATABASE_URL = process.env.DATABASE_URL || "";
const STORAGE_MODE = String(process.env.TICA_STORAGE || (DATABASE_URL ? "postgres" : "json")).toLowerCase();

if (STORAGE_MODE !== "postgres") {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ projects: [], admins: [], sessions: [] }, null, 2), "utf8");
  }
}

let mutationQueue = Promise.resolve();
let pgPool = null;
let postgresReady = null;

function enqueueMutation(task) {
  const run = mutationQueue.then(task, task);
  mutationQueue = run.catch(() => {});
  return run;
}

function randomId(byteLength = 12) {
  return crypto.randomBytes(byteLength).toString("base64url");
}

function now() {
  return new Date().toISOString();
}

function normalizeAdminId(value) {
  return String(value || "").trim().toLowerCase();
}

function hashValue(value) {
  return crypto.createHash("sha256").update(String(value)).digest("base64url");
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 64).toString("base64url");
}

function verifyPassword(password, admin) {
  if (!admin || !admin.passwordSalt || !admin.passwordHash) {
    return false;
  }
  const expected = Buffer.from(admin.passwordHash);
  const actual = Buffer.from(hashPassword(password, admin.passwordSalt));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function normalizeAdmin(admin) {
  const normalized = admin || {};
  normalized.id = String(normalized.id || randomId());
  normalized.name = String(normalized.name || normalized.displayName || "").trim();
  normalized.adminId = normalizeAdminId(normalized.adminId || normalized.username || "");
  normalized.role = normalized.role === "owner" ? "owner" : "admin";
  normalized.status = ["pending", "active", "rejected", "suspended"].includes(normalized.status)
    ? normalized.status
    : (normalized.role === "owner" ? "active" : "pending");
  normalized.passwordSalt = String(normalized.passwordSalt || "");
  normalized.passwordHash = String(normalized.passwordHash || "");
  normalized.createdAt = normalized.createdAt || now();
  normalized.updatedAt = normalized.updatedAt || normalized.createdAt;
  normalized.appliedAt = normalized.appliedAt || normalized.createdAt;
  normalized.approvedAt = normalized.approvedAt || (normalized.status === "active" ? normalized.createdAt : null);
  normalized.rejectedAt = normalized.rejectedAt || null;
  normalized.suspendedAt = normalized.suspendedAt || null;
  normalized.lastLoginAt = normalized.lastLoginAt || null;
  normalized.reviewedBy = normalized.reviewedBy || null;
  normalized.reviewedAt = normalized.reviewedAt || null;
  return normalized;
}

function normalizeSession(session) {
  const normalized = session || {};
  normalized.id = String(normalized.id || randomId());
  normalized.adminId = String(normalized.adminId || "");
  normalized.tokenHash = String(normalized.tokenHash || "");
  normalized.createdAt = normalized.createdAt || now();
  normalized.lastSeenAt = normalized.lastSeenAt || normalized.createdAt;
  return normalized;
}

function normalizeLoginAttempt(attempt) {
  const normalized = attempt || {};
  normalized.keyHash = String(normalized.keyHash || "");
  normalized.count = Math.max(0, Number(normalized.count || 0));
  normalized.firstFailedAt = normalized.firstFailedAt || now();
  normalized.lastFailedAt = normalized.lastFailedAt || normalized.firstFailedAt;
  normalized.lockedUntil = normalized.lockedUntil || null;
  return normalized;
}

function normalizeAuditLog(entry) {
  const normalized = entry || {};
  normalized.id = String(normalized.id || randomId(10));
  normalized.type = String(normalized.type || "unknown");
  normalized.actorId = normalized.actorId || null;
  normalized.targetId = normalized.targetId || null;
  normalized.at = normalized.at || now();
  normalized.details = normalized.details && typeof normalized.details === "object" ? normalized.details : {};
  return normalized;
}

function defaultDB() {
  return { projects: [], admins: [], sessions: [], loginAttempts: [], auditLogs: [] };
}

function normalizeDB(db) {
  const source = db || defaultDB();
  return {
    projects: Array.isArray(source.projects) ? source.projects.map(normalizeProject) : [],
    admins: Array.isArray(source.admins) ? source.admins.map(normalizeAdmin) : [],
    sessions: Array.isArray(source.sessions) ? source.sessions.map(normalizeSession) : [],
    loginAttempts: Array.isArray(source.loginAttempts) ? source.loginAttempts.map(normalizeLoginAttempt).filter((entry) => entry.keyHash) : [],
    auditLogs: Array.isArray(source.auditLogs) ? source.auditLogs.map(normalizeAuditLog) : [],
  };
}

function postgresSslConfig() {
  if (process.env.PGSSL === "disable" || process.env.PGSSLMODE === "disable") {
    return false;
  }
  if (/localhost|127\.0\.0\.1/i.test(DATABASE_URL)) {
    return false;
  }
  return { rejectUnauthorized: false };
}

function getPgPool() {
  if (!pgPool) {
    let Pool;
    try {
      ({ Pool } = require("pg"));
    } catch (error) {
      throw new Error("PostgreSQL 저장소를 사용하려면 `npm install`로 pg 패키지를 설치해야 합니다.");
    }
    pgPool = new Pool({
      connectionString: DATABASE_URL,
      ssl: postgresSslConfig(),
    });
  }
  return pgPool;
}

async function ensurePostgresStorage() {
  if (STORAGE_MODE !== "postgres") return;
  if (!postgresReady) {
    postgresReady = (async () => {
      const pool = getPgPool();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS tica_state (
          id text PRIMARY KEY,
          data jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await pool.query(
        `INSERT INTO tica_state (id, data)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        ["main", JSON.stringify(defaultDB())],
      );
    })();
  }
  await postgresReady;
}

async function readDB() {
  if (STORAGE_MODE === "postgres") {
    await ensurePostgresStorage();
    const pool = getPgPool();
    const result = await pool.query("SELECT data FROM tica_state WHERE id = $1", ["main"]);
    return normalizeDB(result.rows[0]?.data || defaultDB());
  }
  const db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  return normalizeDB(db);
}

async function writeDB(db) {
  const normalized = normalizeDB(db);
  if (STORAGE_MODE === "postgres") {
    await ensurePostgresStorage();
    const pool = getPgPool();
    await pool.query(
      `INSERT INTO tica_state (id, data, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (id)
       DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      ["main", JSON.stringify(normalized)],
    );
    return;
  }
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), "utf8");
  fs.renameSync(tmp, DATA_FILE);
}

function parseCookies(cookieHeader) {
  return String(cookieHeader || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex === -1) {
        return cookies;
      }
      const key = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      cookies[key] = value;
      return cookies;
    }, {});
}

function authCookie(token) {
  return `${ADMIN_SESSION_COOKIE}=${token}; Path=/; Max-Age=${ADMIN_SESSION_MAX_AGE}; HttpOnly; SameSite=Lax`;
}

function clearAuthCookie() {
  return `${ADMIN_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

function publicAdmin(admin) {
  if (!admin) {
    return null;
  }
  return {
    id: admin.id,
    name: admin.name,
    adminId: admin.adminId,
    role: admin.role,
    status: admin.status,
    createdAt: admin.createdAt,
    updatedAt: admin.updatedAt,
    appliedAt: admin.appliedAt,
    approvedAt: admin.approvedAt,
    rejectedAt: admin.rejectedAt,
    suspendedAt: admin.suspendedAt,
    lastLoginAt: admin.lastLoginAt,
  };
}

function audit(db, type, actorId, targetId, details = {}) {
  db.auditLogs.push(normalizeAuditLog({
    id: randomId(10),
    type,
    actorId: actorId || null,
    targetId: targetId || null,
    at: now(),
    details,
  }));
}

function createAdminSession(db, admin) {
  if (!admin || admin.status !== "active") {
    throw new Error("활성화되지 않은 계정은 로그인할 수 없습니다.");
  }
  const token = randomId(24);
  const session = {
    id: randomId(12),
    adminId: admin.id,
    tokenHash: hashValue(token),
    createdAt: now(),
    lastSeenAt: now(),
  };
  db.sessions.push(session);
  admin.lastLoginAt = session.createdAt;
  admin.updatedAt = session.createdAt;
  return { token, session };
}

function clientIp(req) {
  const forwardedFor = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwardedFor || req.socket?.remoteAddress || "unknown";
}

function loginAttemptKey(req, adminId) {
  return hashValue(`${normalizeAdminId(adminId) || "unknown"}:${clientIp(req)}`);
}

function dateMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function pruneLoginAttempts(db, timestampMs = Date.now()) {
  db.loginAttempts = db.loginAttempts.filter((attempt) => {
    const lockedUntil = dateMs(attempt.lockedUntil);
    const lastFailedAt = dateMs(attempt.lastFailedAt);
    return lockedUntil > timestampMs || timestampMs - lastFailedAt <= LOGIN_RATE_LIMIT_WINDOW_MS;
  });
}

function loginRateLimitMessage(lockedUntil) {
  const remainingMs = Math.max(0, dateMs(lockedUntil) - Date.now());
  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
  return `로그인 실패가 너무 많습니다. 약 ${remainingMinutes}분 후 다시 시도해 주세요.`;
}

function enforceLoginRateLimit(db, keyHash, timestampMs = Date.now()) {
  const attempt = db.loginAttempts.find((entry) => entry.keyHash === keyHash);
  if (attempt && dateMs(attempt.lockedUntil) > timestampMs) {
    throw new Error(loginRateLimitMessage(attempt.lockedUntil));
  }
}

function recordLoginFailure(db, keyHash, timestampMs = Date.now()) {
  const timestamp = new Date(timestampMs).toISOString();
  let attempt = db.loginAttempts.find((entry) => entry.keyHash === keyHash);
  if (!attempt || timestampMs - dateMs(attempt.firstFailedAt) > LOGIN_RATE_LIMIT_WINDOW_MS) {
    attempt = normalizeLoginAttempt({
      keyHash,
      count: 0,
      firstFailedAt: timestamp,
      lastFailedAt: timestamp,
      lockedUntil: null,
    });
    db.loginAttempts = db.loginAttempts.filter((entry) => entry.keyHash !== keyHash);
    db.loginAttempts.push(attempt);
  }

  attempt.count += 1;
  attempt.lastFailedAt = timestamp;
  if (attempt.count >= LOGIN_RATE_LIMIT_MAX) {
    attempt.lockedUntil = new Date(timestampMs + LOGIN_RATE_LIMIT_LOCK_MS).toISOString();
  }
}

function clearLoginFailures(db, keyHash) {
  db.loginAttempts = db.loginAttempts.filter((entry) => entry.keyHash !== keyHash);
}

function sessionFromRequest(req, db) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[ADMIN_SESSION_COOKIE];
  if (!token) {
    return null;
  }
  const tokenHash = hashValue(token);
  const session = db.sessions.find((entry) => entry.tokenHash === tokenHash);
  if (!session) {
    return null;
  }
  const admin = db.admins.find((entry) => entry.id === session.adminId);
  if (!admin || admin.status !== "active") {
    return null;
  }
  return { session, admin };
}

function requireAdmin(req, res, db) {
  const auth = sessionFromRequest(req, db);
  if (!auth) {
    sendJson(res, 401, { error: "관리자 로그인이 필요합니다." });
    return null;
  }
  return auth;
}

function requireOwner(req, res, db) {
  const auth = requireAdmin(req, res, db);
  if (!auth) {
    return null;
  }
  if (auth.admin.role !== "owner") {
    sendJson(res, 403, { error: "Owner 권한이 필요합니다." });
    return null;
  }
  return auth;
}

function defaultSettings() {
  return {
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
  };
}

function normalizeProject(project) {
  const normalized = project || {};
  const defaults = defaultSettings();
  const firstSentence = String(normalized.firstSentence || normalized.sentences?.[0]?.text || "").trim();

  normalized.id = String(normalized.id || randomId());
  normalized.name = String(normalized.name || "").trim();
  normalized.description = String(normalized.description || "").trim();
  normalized.targetParticipants = Math.max(1, Number(normalized.targetParticipants ?? defaults.targetParticipants) || defaults.targetParticipants);
  normalized.recruitmentStartAt = String(normalized.recruitmentStartAt ?? defaults.recruitmentStartAt ?? "");
  normalized.recruitmentEndAt = String(normalized.recruitmentEndAt ?? defaults.recruitmentEndAt ?? "");
  normalized.visibleWindow = Math.max(1, Number(normalized.visibleWindow ?? defaults.visibleWindow) || defaults.visibleWindow);
  normalized.visibleWindowAll = Boolean(normalized.visibleWindowAll ?? defaults.visibleWindowAll);
  normalized.characterLimitMode = normalized.characterLimitMode === "limit" ? "limit" : "none";
  normalized.characterLimit = Math.max(1, Number(normalized.characterLimit ?? defaults.characterLimit) || defaults.characterLimit);
  normalized.countWhitespace = Boolean(normalized.countWhitespace ?? defaults.countWhitespace);
  normalized.revealOrderToParticipants = Boolean(normalized.revealOrderToParticipants ?? defaults.revealOrderToParticipants);
  normalized.revealParticipantCountToParticipants = Boolean(normalized.revealParticipantCountToParticipants ?? defaults.revealParticipantCountToParticipants);
  normalized.reviewEnabled = Boolean(normalized.reviewEnabled ?? defaults.reviewEnabled);
  normalized.editableAfterSubmit = Boolean(normalized.editableAfterSubmit ?? defaults.editableAfterSubmit);
  normalized.allowSkip = Boolean(normalized.allowSkip ?? defaults.allowSkip);
  normalized.allowPause = Boolean(normalized.allowPause ?? defaults.allowPause);
  normalized.txtDownloadEnabled = Boolean(normalized.txtDownloadEnabled ?? defaults.txtDownloadEnabled);
  delete normalized.publishFinalToParticipants;
  delete normalized.participantCertification;
  normalized.status = String(normalized.status || "draft");
  normalized.applicationOpen = Boolean(normalized.applicationOpen);
  normalized.applications = Array.isArray(normalized.applications)
    ? normalized.applications.map((application) => ({
      studentId: String(application.studentId || "").trim(),
      name: String(application.name || "").trim(),
      appliedAt: application.appliedAt || now(),
    }))
    : [];
  normalized.participants = Array.isArray(normalized.participants)
    ? normalized.participants.map((participant) => ({
      studentId: String(participant.studentId || "").trim(),
      name: String(participant.name || "").trim(),
      order: participant.order == null ? null : Number(participant.order),
      token: String(participant.token || randomId(18)),
      status: String(participant.status || "selected"),
      submittedAt: participant.submittedAt || null,
      reviewState: participant.reviewState || null,
      draftText: participant.draftText || "",
      pendingSubmittedAt: participant.pendingSubmittedAt || null,
    }))
    : [];
  normalized.sentences = Array.isArray(normalized.sentences) && normalized.sentences.length
    ? normalized.sentences.map((sentence) => ({
      id: String(sentence.id || randomId(10)),
      text: String(sentence.text || ""),
      type: String(sentence.type || "participant"),
      status: String(sentence.status || "approved"),
      participantToken: sentence.participantToken || null,
      order: sentence.order == null ? null : Number(sentence.order),
      createdAt: sentence.createdAt || now(),
      submittedAt: sentence.submittedAt || null,
      reviewedAt: sentence.reviewedAt || null,
    }))
    : (firstSentence
      ? [{
        id: randomId(10),
        text: firstSentence,
        type: "admin",
        status: "approved",
        participantToken: null,
        order: null,
        createdAt: normalized.createdAt || now(),
        submittedAt: null,
        reviewedAt: null,
      }]
      : []);
  normalized.firstSentence = firstSentence || normalized.sentences[0]?.text || "";
  if (!normalized.sentences.length && normalized.firstSentence) {
    normalized.sentences.push({
      id: randomId(10),
      text: normalized.firstSentence,
      type: "admin",
      status: "approved",
      participantToken: null,
      order: null,
      createdAt: now(),
      submittedAt: null,
      reviewedAt: null,
    });
  } else if (normalized.sentences[0] && normalized.firstSentence && normalized.sentences[0].text !== normalized.firstSentence) {
    normalized.sentences[0].text = normalized.firstSentence;
  }
  normalized.currentIndex = normalized.currentIndex == null ? null : Number(normalized.currentIndex);
  normalized.pendingReview = normalized.pendingReview || null;
  if (normalized.pendingReview) {
    normalized.pendingReview = {
      participantIndex: Number(normalized.pendingReview.participantIndex),
      participantToken: String(normalized.pendingReview.participantToken || ""),
      text: String(normalized.pendingReview.text || ""),
      submittedAt: normalized.pendingReview.submittedAt || now(),
    };
  }
  normalized.audit = Array.isArray(normalized.audit) ? normalized.audit : [];
  normalized.createdAt = normalized.createdAt || now();
  normalized.updatedAt = normalized.updatedAt || normalized.createdAt;
  return normalized;
}

function findProject(db, projectId) {
  return db.projects.find((project) => project.id === projectId);
}

function shuffle(items) {
  const cloned = items.slice();
  for (let index = cloned.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [cloned[index], cloned[swapIndex]] = [cloned[swapIndex], cloned[index]];
  }
  return cloned;
}

function sanitizeFilename(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/g, "") || "tica-relay";
}

function countCharacters(text, countWhitespace) {
  const normalized = String(text || "");
  return countWhitespace ? normalized.length : normalized.replace(/\s/g, "").length;
}

function formatISO(value) {
  return value || null;
}

function localNetworkOrigin(req) {
  const host = String(req.headers.host || `localhost:${PORT}`);
  const port = host.includes(":") ? host.split(":").pop() : String(PORT);
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry && entry.family === "IPv4" && !entry.internal && entry.address) {
        candidates.push(entry.address);
      }
    }
  }
  const privateAddress = candidates.find((address) => {
    const parts = address.split(".").map(Number);
    return parts[0] === 10
      || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
  });
  const selectedAddress = privateAddress || candidates[0];
  return selectedAddress ? `http://${selectedAddress}:${port}` : null;
}

function requestOrigin(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto || "http";
  return `${protocol}://${req.headers.host || `localhost:${PORT}`}`;
}

function shareOriginForRequest(req) {
  const host = String(req.headers.host || "").split(":")[0].toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return localNetworkOrigin(req) || requestOrigin(req);
  }
  return requestOrigin(req);
}

function isRecruitmentActive(project) {
  const nowValue = Date.now();
  if (project.recruitmentStartAt) {
    const start = Date.parse(project.recruitmentStartAt);
    if (!Number.isNaN(start) && nowValue < start) return false;
  }
  if (project.recruitmentEndAt) {
    const end = Date.parse(project.recruitmentEndAt);
    if (!Number.isNaN(end) && nowValue > end) return false;
  }
  return true;
}

function recruitmentState(project) {
  const nowValue = Date.now();
  if (project.recruitmentStartAt) {
    const start = Date.parse(project.recruitmentStartAt);
    if (!Number.isNaN(start) && nowValue < start) {
      return { canApply: false, message: "모집 시작 전입니다." };
    }
  }
  if (project.recruitmentEndAt) {
    const end = Date.parse(project.recruitmentEndAt);
    if (!Number.isNaN(end) && nowValue > end) {
      return { canApply: false, message: "모집이 종료되었습니다." };
    }
  }
  if (!project.applicationOpen) {
    return { canApply: false, message: "아직 참가 신청이 열리지 않았습니다." };
  }
  return { canApply: true, message: "참가 신청을 받을 수 있습니다." };
}

function hasRecruitmentWindow(project) {
  return Boolean(project.recruitmentStartAt || project.recruitmentEndAt);
}

function syncRecruitmentStatusFromWindow(project) {
  if (!hasRecruitmentWindow(project) || !canOpenRecruitment(project)) {
    return false;
  }
  const previousOpen = project.applicationOpen;
  const previousStatus = project.status;
  const active = isRecruitmentActive(project);
  project.applicationOpen = active;
  project.status = active ? "recruiting" : "draft";
  return previousOpen !== project.applicationOpen || previousStatus !== project.status;
}

function visibleSentencesForParticipant(project) {
  const approvedSentences = project.sentences.filter((sentence) => sentence.status === "approved" || sentence.type === "admin");
  if (project.visibleWindowAll) return approvedSentences;
  return approvedSentences.slice(Math.max(0, approvedSentences.length - project.visibleWindow));
}

function publicProject(project) {
  const state = recruitmentState(project);
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    status: project.status,
    applicationOpen: project.applicationOpen,
    canApply: state.canApply,
    applyMessage: state.message,
    targetParticipants: project.targetParticipants,
    recruitmentStartAt: formatISO(project.recruitmentStartAt),
    recruitmentEndAt: formatISO(project.recruitmentEndAt),
    visibleWindow: project.visibleWindow,
    visibleWindowAll: project.visibleWindowAll,
    characterLimitMode: project.characterLimitMode,
    characterLimit: project.characterLimit,
    countWhitespace: project.countWhitespace,
    revealOrderToParticipants: project.revealOrderToParticipants,
    revealParticipantCountToParticipants: project.revealParticipantCountToParticipants,
    reviewEnabled: project.reviewEnabled,
    editableAfterSubmit: project.editableAfterSubmit,
    allowSkip: project.allowSkip,
    allowPause: project.allowPause,
    txtDownloadEnabled: project.txtDownloadEnabled,
    applicationCount: project.applications.length,
    selectedCount: project.participants.length,
    sentenceCount: project.sentences.length,
    hasPendingReview: Boolean(project.pendingReview),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function exportProjectText(project) {
  const lines = [];
  lines.push("TiCa Relay");
  lines.push(project.name);
  if (project.description) lines.push(project.description);
  lines.push("");
  lines.push(`상태: ${project.status}`);
  lines.push(`목표 참가 인원: ${project.targetParticipants}`);
  lines.push(`확정 참가 인원: ${project.participants.length}`);
  lines.push(`공개 문장 수: ${project.visibleWindowAll ? "전체 공개" : `최근 ${project.visibleWindow}개`}`);
  if (project.characterLimitMode === "limit") {
    lines.push(`글자 수 제한: ${project.characterLimit}${project.countWhitespace ? "자 (공백 포함)" : "자 (공백 제외)"}`);
  } else {
    lines.push("글자 수 제한: 없음");
  }
  lines.push("");
  lines.push("원고");
  project.sentences
    .filter((sentence) => sentence.status === "approved" || sentence.type === "admin")
    .forEach((sentence, index) => {
      const label = index === 0 ? "시작" : `문장 ${sentence.order ?? index}`;
      lines.push(`${label}: ${sentence.text}`);
    });
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function sendJson(res, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

function sendText(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

function mimeTypeForFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function resolvePublicAsset(requestPath) {
  const decoded = decodeURIComponent(requestPath);
  const normalized = path.normalize(decoded).replace(/^([/\\])+/, "");
  if (!normalized || normalized === ".") {
    return null;
  }

  const filePath = path.join(PUBLIC_DIR, normalized);
  const relativePath = path.relative(PUBLIC_DIR, filePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null;
  }
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const stat = fs.statSync(filePath);
  return stat.isFile() ? filePath : null;
}

function sendFile(res, filePath) {
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": mimeTypeForFile(filePath),
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function sendNoContent(res, headers = {}) {
  res.writeHead(204, {
    ...headers,
  });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > 1_000_000) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }

      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });

    req.on("error", reject);
  });
}

function badRequest(res, message) {
  sendJson(res, 400, { error: message });
}

function notFound(res, message = "요청한 리소스를 찾을 수 없습니다.") {
  sendJson(res, 404, { error: message });
}

function validateProjectSettings(project, patch) {
  const lockedWhenRunning = [
    "targetParticipants",
    "recruitmentStartAt",
    "recruitmentEndAt",
    "visibleWindow",
    "visibleWindowAll",
    "characterLimitMode",
    "characterLimit",
    "countWhitespace",
    "revealOrderToParticipants",
    "revealParticipantCountToParticipants",
    "reviewEnabled",
    "editableAfterSubmit",
    "firstSentence",
  ];

  if (project.status === "running" || project.status === "paused") {
    const attemptedLocked = lockedWhenRunning.filter((field) => Object.prototype.hasOwnProperty.call(patch, field));
    if (attemptedLocked.length) {
      throw new Error(`진행 중에는 설정을 변경할 수 없습니다: ${attemptedLocked.join(", ")}`);
    }
  }
}

function applyProjectPatch(project, patch) {
  if (Object.prototype.hasOwnProperty.call(patch, "name")) {
    const value = String(patch.name || "").trim();
    if (!value) throw new Error("프로젝트명은 비워둘 수 없습니다.");
    project.name = value;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "description")) {
    project.description = String(patch.description || "").trim();
  }
  if (Object.prototype.hasOwnProperty.call(patch, "targetParticipants")) {
    project.targetParticipants = Math.max(1, Number(patch.targetParticipants) || 1);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "recruitmentStartAt")) {
    project.recruitmentStartAt = String(patch.recruitmentStartAt || "").trim();
  }
  if (Object.prototype.hasOwnProperty.call(patch, "recruitmentEndAt")) {
    project.recruitmentEndAt = String(patch.recruitmentEndAt || "").trim();
  }
  if (Object.prototype.hasOwnProperty.call(patch, "visibleWindow")) {
    project.visibleWindow = Math.max(1, Number(patch.visibleWindow) || 1);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "visibleWindowAll")) {
    project.visibleWindowAll = Boolean(patch.visibleWindowAll);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "characterLimitMode")) {
    project.characterLimitMode = patch.characterLimitMode === "limit" ? "limit" : "none";
  }
  if (Object.prototype.hasOwnProperty.call(patch, "characterLimit")) {
    project.characterLimit = Math.max(1, Number(patch.characterLimit) || 1);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "countWhitespace")) {
    project.countWhitespace = Boolean(patch.countWhitespace);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "revealOrderToParticipants")) {
    project.revealOrderToParticipants = Boolean(patch.revealOrderToParticipants);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "revealParticipantCountToParticipants")) {
    project.revealParticipantCountToParticipants = Boolean(patch.revealParticipantCountToParticipants);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "reviewEnabled")) {
    project.reviewEnabled = Boolean(patch.reviewEnabled);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "editableAfterSubmit")) {
    project.editableAfterSubmit = Boolean(patch.editableAfterSubmit);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "allowSkip")) {
    project.allowSkip = Boolean(patch.allowSkip);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "allowPause")) {
    project.allowPause = Boolean(patch.allowPause);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "txtDownloadEnabled")) {
    project.txtDownloadEnabled = Boolean(patch.txtDownloadEnabled);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "firstSentence")) {
    const value = String(patch.firstSentence || "").trim();
    if (!value) throw new Error("첫 문장은 비워둘 수 없습니다.");
    project.firstSentence = value;
    if (project.sentences.length) {
      project.sentences[0].text = value;
    } else {
      project.sentences = [{
        id: randomId(10),
        text: value,
        type: "admin",
        status: "approved",
        participantToken: null,
        order: null,
        createdAt: now(),
        submittedAt: null,
        reviewedAt: null,
      }];
    }
  }
}

function advanceAfterApprovedSentence(project, participant, text) {
  project.sentences.push({
    id: randomId(10),
    text,
    type: "participant",
    status: "approved",
    participantToken: participant.token,
    order: participant.order,
    createdAt: now(),
    submittedAt: now(),
    reviewedAt: project.reviewEnabled ? now() : null,
  });
  participant.status = "submitted";
  participant.submittedAt = now();
  participant.reviewState = null;
  participant.draftText = "";
  participant.pendingSubmittedAt = null;
  project.pendingReview = null;
  project.currentIndex += 1;
  if (project.currentIndex >= project.participants.length) {
    project.status = "completed";
    project.currentIndex = null;
  } else {
    project.participants[project.currentIndex].status = "writing";
  }
  project.updatedAt = now();
}

function currentParticipant(project) {
  if (project.currentIndex == null || project.currentIndex < 0 || project.currentIndex >= project.participants.length) {
    return null;
  }
  return project.participants[project.currentIndex] || null;
}

function participantIndexByToken(project, token) {
  return project.participants.findIndex((participant) => participant.token === token);
}

function handleReviewSubmission(project, participant, participantIndex, text) {
  const pendingAt = now();
  participant.status = "pending_review";
  participant.reviewState = "pending";
  participant.draftText = text;
  participant.pendingSubmittedAt = pendingAt;
  project.pendingReview = {
    participantIndex,
    participantToken: participant.token,
    text,
    submittedAt: pendingAt,
  };
  project.audit.push({
    type: "submission_pending",
    order: participant.order,
    studentId: participant.studentId,
    at: pendingAt,
  });
  project.updatedAt = pendingAt;
}

function handleReviewDecision(project, decision) {
  if (!project.reviewEnabled) {
    throw new Error("검수가 활성화된 프로젝트가 아닙니다.");
  }
  if (!project.pendingReview) {
    throw new Error("검수 대기 중인 제출물이 없습니다.");
  }

  const pending = project.pendingReview;
  const participant = project.participants[pending.participantIndex];
  if (!participant || participant.token !== pending.participantToken) {
    throw new Error("검수 대기 상태가 올바르지 않습니다.");
  }

  if (decision === "approve") {
    advanceAfterApprovedSentence(project, participant, pending.text);
    project.audit.push({
      type: "review_approve",
      order: participant.order,
      studentId: participant.studentId,
      at: now(),
    });
    return;
  }

  participant.status = "writing";
  participant.reviewState = decision === "revision" ? "revision_requested" : "rejected";
  participant.draftText = decision === "revision" ? pending.text : "";
  participant.pendingSubmittedAt = null;
  project.pendingReview = null;
  project.audit.push({
    type: decision === "revision" ? "review_revision" : "review_reject",
    order: participant.order,
    studentId: participant.studentId,
    at: now(),
  });
  project.updatedAt = now();
}

function canOpenRecruitment(project) {
  return project.status === "draft" || project.status === "recruiting";
}

async function handleRequest(req, res) {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = requestUrl.pathname;
    const method = req.method || "GET";
    let match;

    if (method === "GET" && pathname === "/favicon.ico") {
      sendNoContent(res);
      return;
    }

    if (method === "GET" && pathname === "/api/auth/context") {
      const db = await readDB();
      const auth = sessionFromRequest(req, db);
      sendJson(res, 200, {
        hasOwner: db.admins.some((admin) => admin.role === "owner"),
        hasAdmins: db.admins.length > 0,
        pendingAdminCount: db.admins.filter((admin) => admin.role === "admin" && admin.status === "pending").length,
        currentAdmin: auth ? publicAdmin(auth.admin) : null,
        shareOrigin: shareOriginForRequest(req),
      });
      return;
    }

    if (method === "POST" && pathname === "/api/auth/setup") {
      const body = await readBody(req);
      const result = await enqueueMutation(async () => {
        const db = await readDB();
        if (db.admins.some((admin) => admin.role === "owner")) {
          throw new Error("이미 Owner가 있습니다. 관리자 신청 또는 로그인을 이용해 주세요.");
        }

        const name = String(body.name || "").trim();
        const adminId = normalizeAdminId(body.adminId);
        const password = String(body.password || "");
        const confirmPassword = String(body.confirmPassword || "");
        if (!name) {
          throw new Error("이름을 입력해 주세요.");
        }
        if (!adminId) {
          throw new Error("관리자 ID를 입력해 주세요.");
        }
        if (db.admins.some((admin) => admin.adminId === adminId)) {
          throw new Error("이미 사용 중인 관리자 ID입니다.");
        }
        if (password.length < 8) {
          throw new Error("비밀번호는 8자 이상으로 설정해 주세요.");
        }
        if (password !== confirmPassword) {
          throw new Error("비밀번호 확인이 일치하지 않습니다.");
        }

        const timestamp = now();
        const passwordSalt = randomId(16);
        const owner = normalizeAdmin({
          id: randomId(),
          name,
          adminId,
          role: "owner",
          status: "active",
          passwordSalt,
          passwordHash: hashPassword(password, passwordSalt),
          createdAt: timestamp,
          updatedAt: timestamp,
          appliedAt: timestamp,
          approvedAt: timestamp,
          lastLoginAt: timestamp,
        });
        db.admins.push(owner);
        const { token } = createAdminSession(db, owner);
        await writeDB(db);
        return { admin: publicAdmin(owner), token };
      }).catch((error) => ({ error }));

      if (result.error) {
        badRequest(res, result.error.message);
        return;
      }

      sendJson(res, 200, result, {
        "Set-Cookie": authCookie(result.token),
      });
      return;
    }

    if (method === "POST" && pathname === "/api/auth/apply") {
      const body = await readBody(req);
      const result = await enqueueMutation(async () => {
        const db = await readDB();
        if (!db.admins.some((admin) => admin.role === "owner")) {
          throw new Error("먼저 Owner를 생성해 주세요.");
        }

        const name = String(body.name || "").trim();
        const adminId = normalizeAdminId(body.adminId);
        const password = String(body.password || "");
        const confirmPassword = String(body.confirmPassword || "");
        if (!name) {
          throw new Error("이름을 입력해 주세요.");
        }
        if (!adminId) {
          throw new Error("관리자 ID를 입력해 주세요.");
        }
        if (password.length < 8) {
          throw new Error("비밀번호는 8자 이상으로 설정해 주세요.");
        }
        if (password !== confirmPassword) {
          throw new Error("비밀번호 확인이 일치하지 않습니다.");
        }

        const existing = db.admins.find((admin) => admin.adminId === adminId);
        if (existing) {
          if (existing.role === "owner") {
            throw new Error("이미 Owner 계정이 있습니다.");
          }
          if (existing.status === "pending") {
            throw new Error("이미 승인 대기 중인 관리자 신청입니다.");
          }
          if (existing.status === "active") {
            throw new Error("이미 활성화된 관리자 계정입니다.");
          }
        }

        const timestamp = now();
        const passwordSalt = randomId(16);
        const passwordHash = hashPassword(password, passwordSalt);
        if (existing) {
          existing.name = name;
          existing.passwordSalt = passwordSalt;
          existing.passwordHash = passwordHash;
          existing.status = "pending";
          existing.role = "admin";
          existing.appliedAt = timestamp;
          existing.updatedAt = timestamp;
          existing.approvedAt = null;
          existing.rejectedAt = null;
          existing.suspendedAt = null;
          existing.reviewedBy = null;
          existing.reviewedAt = null;
          await writeDB(db);
          return { admin: publicAdmin(existing) };
        }

        const applicant = normalizeAdmin({
          id: randomId(),
          name,
          adminId,
          role: "admin",
          status: "pending",
          passwordSalt,
          passwordHash,
          createdAt: timestamp,
          updatedAt: timestamp,
          appliedAt: timestamp,
        });
        db.admins.push(applicant);
        await writeDB(db);
        return { admin: publicAdmin(applicant) };
      }).catch((error) => ({ error }));

      if (result.error) {
        badRequest(res, result.error.message);
        return;
      }

      sendJson(res, 200, result);
      return;
    }

    if (method === "POST" && pathname === "/api/auth/login") {
      const body = await readBody(req);
      const result = await enqueueMutation(async () => {
        const db = await readDB();
        const adminId = normalizeAdminId(body.adminId);
        const password = String(body.password || "");
        const keyHash = loginAttemptKey(req, adminId);
        const timestampMs = Date.now();
        pruneLoginAttempts(db, timestampMs);
        try {
          enforceLoginRateLimit(db, keyHash, timestampMs);
        } catch (error) {
          await writeDB(db);
          throw error;
        }
        const failLogin = async (message) => {
          recordLoginFailure(db, keyHash, timestampMs);
          audit(db, "admin_login_failed", null, null, { adminId });
          await writeDB(db);
          throw new Error(message);
        };
        const admin = db.admins.find((entry) => entry.adminId === adminId);
        if (!admin) {
          await failLogin("관리자 ID 또는 비밀번호가 올바르지 않습니다.");
          throw new Error("관리자 ID 또는 비밀번호가 올바르지 않습니다.");
        }
        if (admin.status === "pending") {
          await failLogin("관리자 승인 대기 중입니다.");
          throw new Error("관리자 승인 대기 중입니다.");
        }
        if (admin.status === "rejected") {
          await failLogin("거절된 관리자 신청입니다.");
          throw new Error("거절된 관리자 신청입니다.");
        }
        if (admin.status === "suspended") {
          await failLogin("정지된 관리자 계정입니다.");
          throw new Error("정지된 관리자 계정입니다.");
        }
        if (!verifyPassword(password, admin)) {
          await failLogin("관리자 ID 또는 비밀번호가 올바르지 않습니다.");
          throw new Error("관리자 ID 또는 비밀번호가 올바르지 않습니다.");
        }

        admin.status = "active";
        clearLoginFailures(db, keyHash);
        audit(db, "admin_login", admin.id, admin.id);
        const { token } = createAdminSession(db, admin);
        await writeDB(db);
        return { admin: publicAdmin(admin), token };
      }).catch((error) => ({ error }));

      if (result.error) {
        badRequest(res, result.error.message);
        return;
      }

      sendJson(res, 200, result, {
        "Set-Cookie": authCookie(result.token),
      });
      return;
    }

    if (method === "POST" && pathname === "/api/auth/logout") {
      const result = await enqueueMutation(async () => {
        const db = await readDB();
        const auth = sessionFromRequest(req, db);
        if (auth) {
          db.sessions = db.sessions.filter((session) => session.id !== auth.session.id);
          await writeDB(db);
        }
        return { ok: true };
      }).catch((error) => ({ error }));

      if (result.error) {
        badRequest(res, result.error.message);
        return;
      }

      sendJson(res, 200, result, {
        "Set-Cookie": clearAuthCookie(),
      });
      return;
    }

    if (method === "GET" && pathname === "/api/admin/admins") {
      const db = await readDB();
      const auth = requireOwner(req, res, db);
      if (!auth) {
        return;
      }
      sendJson(res, 200, db.admins.map(publicAdmin).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))));
      return;
    }

    match = pathname.match(/^\/api\/admin\/admins\/([^/]+)\/approve$/);
    if (method === "POST" && match) {
      const db = await readDB();
      const auth = requireOwner(req, res, db);
      if (!auth) {
        return;
      }
      const result = await enqueueMutation(async () => {
        const mutationDB = await readDB();
        const admin = mutationDB.admins.find((entry) => entry.id === decodeURIComponent(match[1]));
        if (!admin) {
          throw new Error("관리자를 찾을 수 없습니다.");
        }
        if (admin.role === "owner") {
          throw new Error("Owner는 승인할 수 없습니다.");
        }
        if (admin.status === "active") {
          throw new Error("이미 활성화된 관리자입니다.");
        }

        const timestamp = now();
        admin.status = "active";
        admin.approvedAt = timestamp;
        admin.rejectedAt = null;
        admin.suspendedAt = null;
        admin.reviewedBy = auth.admin.id;
        admin.reviewedAt = timestamp;
        admin.updatedAt = timestamp;
        mutationDB.sessions = mutationDB.sessions.filter((session) => session.adminId !== admin.id);
        audit(mutationDB, "admin_approve", auth.admin.id, admin.id, { adminId: admin.adminId });
        await writeDB(mutationDB);
        return publicAdmin(admin);
      }).catch((error) => ({ error }));

      if (result.error) {
        badRequest(res, result.error.message);
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    match = pathname.match(/^\/api\/admin\/admins\/([^/]+)\/reject$/);
    if (method === "POST" && match) {
      const db = await readDB();
      const auth = requireOwner(req, res, db);
      if (!auth) {
        return;
      }
      const result = await enqueueMutation(async () => {
        const mutationDB = await readDB();
        const admin = mutationDB.admins.find((entry) => entry.id === decodeURIComponent(match[1]));
        if (!admin) {
          throw new Error("관리자를 찾을 수 없습니다.");
        }
        if (admin.role === "owner") {
          throw new Error("Owner는 거절할 수 없습니다.");
        }

        const timestamp = now();
        admin.status = "rejected";
        admin.rejectedAt = timestamp;
        admin.approvedAt = null;
        admin.suspendedAt = null;
        admin.reviewedBy = auth.admin.id;
        admin.reviewedAt = timestamp;
        admin.updatedAt = timestamp;
        mutationDB.sessions = mutationDB.sessions.filter((session) => session.adminId !== admin.id);
        audit(mutationDB, "admin_reject", auth.admin.id, admin.id, { adminId: admin.adminId });
        await writeDB(mutationDB);
        return publicAdmin(admin);
      }).catch((error) => ({ error }));

      if (result.error) {
        badRequest(res, result.error.message);
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    match = pathname.match(/^\/api\/admin\/admins\/([^/]+)\/suspend$/);
    if (method === "POST" && match) {
      const db = await readDB();
      const auth = requireOwner(req, res, db);
      if (!auth) {
        return;
      }
      const result = await enqueueMutation(async () => {
        const mutationDB = await readDB();
        const admin = mutationDB.admins.find((entry) => entry.id === decodeURIComponent(match[1]));
        if (!admin) {
          throw new Error("관리자를 찾을 수 없습니다.");
        }
        if (admin.role === "owner") {
          throw new Error("Owner는 정지할 수 없습니다.");
        }

        const timestamp = now();
        admin.status = "suspended";
        admin.suspendedAt = timestamp;
        admin.reviewedBy = auth.admin.id;
        admin.reviewedAt = timestamp;
        admin.updatedAt = timestamp;
        mutationDB.sessions = mutationDB.sessions.filter((session) => session.adminId !== admin.id);
        audit(mutationDB, "admin_suspend", auth.admin.id, admin.id, { adminId: admin.adminId });
        await writeDB(mutationDB);
        return publicAdmin(admin);
      }).catch((error) => ({ error }));

      if (result.error) {
        badRequest(res, result.error.message);
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    match = pathname.match(/^\/api\/admin\/admins\/([^/]+)\/transfer-owner$/);
    if (method === "POST" && match) {
      const db = await readDB();
      const auth = requireOwner(req, res, db);
      if (!auth) {
        return;
      }
      const body = await readBody(req);
      const result = await enqueueMutation(async () => {
        const mutationDB = await readDB();
        const currentOwner = mutationDB.admins.find((entry) => entry.id === auth.admin.id);
        const nextOwner = mutationDB.admins.find((entry) => entry.id === decodeURIComponent(match[1]));
        if (!currentOwner || currentOwner.role !== "owner" || currentOwner.status !== "active") {
          throw new Error("현재 Owner 권한을 다시 확인할 수 없습니다.");
        }
        if (!verifyPassword(String(body.password || ""), currentOwner)) {
          throw new Error("Owner 비밀번호가 올바르지 않습니다.");
        }
        if (!nextOwner) {
          throw new Error("관리자를 찾을 수 없습니다.");
        }
        if (nextOwner.id === currentOwner.id) {
          throw new Error("자기 자신에게 Owner를 이전할 수 없습니다.");
        }
        if (nextOwner.role !== "admin" || nextOwner.status !== "active") {
          throw new Error("활성 Admin에게만 Owner를 이전할 수 있습니다.");
        }
        const confirmText = String(body.confirmText || "").trim();
        if (confirmText !== nextOwner.adminId) {
          throw new Error("확인용 관리자 ID가 일치하지 않습니다.");
        }

        const timestamp = now();
        mutationDB.admins.forEach((admin) => {
          if (admin.role === "owner") {
            admin.role = "admin";
            admin.status = "active";
            admin.updatedAt = timestamp;
          }
        });
        nextOwner.role = "owner";
        nextOwner.status = "active";
        nextOwner.approvedAt = nextOwner.approvedAt || timestamp;
        nextOwner.reviewedBy = currentOwner.id;
        nextOwner.reviewedAt = timestamp;
        nextOwner.updatedAt = timestamp;
        audit(mutationDB, "owner_transfer", currentOwner.id, nextOwner.id, {
          previousOwnerAdminId: currentOwner.adminId,
          nextOwnerAdminId: nextOwner.adminId,
        });
        await writeDB(mutationDB);
        return {
          previousOwner: publicAdmin(currentOwner),
          newOwner: publicAdmin(nextOwner),
        };
      }).catch((error) => ({ error }));

      if (result.error) {
        badRequest(res, result.error.message);
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    match = pathname.match(/^\/api\/admin\/admins\/([^/]+)$/);
    if (method === "DELETE" && match) {
      const db = await readDB();
      const auth = requireOwner(req, res, db);
      if (!auth) {
        return;
      }
      const result = await enqueueMutation(async () => {
        const mutationDB = await readDB();
        const adminId = decodeURIComponent(match[1]);
        const admin = mutationDB.admins.find((entry) => entry.id === adminId);
        if (!admin) {
          throw new Error("관리자를 찾을 수 없습니다.");
        }
        if (admin.role === "owner") {
          throw new Error("Owner 계정은 삭제할 수 없습니다. 먼저 Owner를 이전해 주세요.");
        }
        const deletedAdmin = publicAdmin(admin);
        mutationDB.admins = mutationDB.admins.filter((entry) => entry.id !== admin.id);
        mutationDB.sessions = mutationDB.sessions.filter((session) => session.adminId !== admin.id);
        audit(mutationDB, "admin_delete", auth.admin.id, admin.id, {
          deletedAdminId: admin.adminId,
          deletedStatus: admin.status,
        });
        await writeDB(mutationDB);
        return { deleted: true, admin: deletedAdmin };
      }).catch((error) => ({ error }));

      if (result.error) {
        badRequest(res, result.error.message);
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    if (pathname.startsWith("/api/admin/")) {
      const db = await readDB();
      const auth = requireAdmin(req, res, db);
      if (!auth) {
        return;
      }
    }

    if (method === "GET" && pathname === "/api/admin/projects") {
      const db = await readDB();
      const statusFilter = requestUrl.searchParams.get("status");
      const projects = statusFilter
        ? db.projects.filter((project) => project.status === statusFilter)
        : db.projects;
      sendJson(res, 200, projects.map(publicProject).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))));
      return;
    }

    if (method === "POST" && pathname === "/api/admin/projects") {
      const body = await readBody(req);
      const project = await enqueueMutation(async () => {
        const name = String(body.name || "").trim();
        const firstSentence = String(body.firstSentence || "").trim();
        if (!name || !firstSentence) {
          throw new Error("프로젝트명과 첫 문장을 입력해 주세요.");
        }

        const newProject = normalizeProject({
          id: randomId(),
          name,
          description: String(body.description || "").trim(),
          targetParticipants: body.targetParticipants,
          recruitmentStartAt: body.recruitmentStartAt,
          recruitmentEndAt: body.recruitmentEndAt,
          visibleWindow: body.visibleWindow,
          visibleWindowAll: body.visibleWindowAll,
          characterLimitMode: body.characterLimitMode,
          characterLimit: body.characterLimit,
          countWhitespace: body.countWhitespace,
          revealOrderToParticipants: body.revealOrderToParticipants,
          revealParticipantCountToParticipants: body.revealParticipantCountToParticipants,
          reviewEnabled: body.reviewEnabled,
          editableAfterSubmit: body.editableAfterSubmit,
          allowSkip: body.allowSkip,
          allowPause: body.allowPause,
          txtDownloadEnabled: body.txtDownloadEnabled,
          status: "draft",
          applicationOpen: false,
          applications: [],
          participants: [],
          sentences: [],
          currentIndex: null,
          pendingReview: null,
          audit: [{ type: "project_created", at: now() }],
          createdAt: now(),
          updatedAt: now(),
          firstSentence,
        });
        syncRecruitmentStatusFromWindow(newProject);

        const db = await readDB();
        db.projects.push(newProject);
        await writeDB(db);
        return publicProject(newProject);
      }).catch((error) => ({ error }));

      if (project.error) {
        badRequest(res, project.error.message);
        return;
      }
      sendJson(res, 200, project);
      return;
    }

    match = pathname.match(/^\/api\/admin\/projects\/([^/]+)$/);
    if (method === "GET" && match) {
      const db = await readDB();
      const project = findProject(db, decodeURIComponent(match[1]));
      if (!project) {
        notFound(res, "프로젝트를 찾을 수 없습니다.");
        return;
      }
      const state = recruitmentState(project);
      sendJson(res, 200, {
        ...project,
        canApply: state.canApply,
        applyMessage: state.message,
      });
      return;
    }

    if (method === "DELETE" && match) {
      const result = await enqueueMutation(async () => {
        const db = await readDB();
        const projectId = decodeURIComponent(match[1]);
        const projectIndex = db.projects.findIndex((project) => project.id === projectId);
        if (projectIndex === -1) {
          throw new Error("프로젝트를 찾을 수 없습니다.");
        }
        const [deletedProject] = db.projects.splice(projectIndex, 1);
        await writeDB(db);
        return {
          deleted: true,
          project: publicProject(deletedProject),
        };
      }).catch((error) => ({ error }));

      if (result.error) {
        badRequest(res, result.error.message);
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    match = pathname.match(/^\/api\/admin\/projects\/([^/]+)\/settings$/);
    if (method === "PATCH" && match) {
      const body = await readBody(req);
      const result = await enqueueMutation(async () => {
        const db = await readDB();
        const project = findProject(db, decodeURIComponent(match[1]));
        if (!project) {
          throw new Error("프로젝트를 찾을 수 없습니다.");
        }
        validateProjectSettings(project, body);
        applyProjectPatch(project, body);
        const syncedRecruitment = syncRecruitmentStatusFromWindow(project);
        project.updatedAt = now();
        project.audit.push({ type: "settings_update", at: now() });
        if (syncedRecruitment) {
          project.audit.push({
            type: "application_toggle",
            open: project.applicationOpen,
            at: now(),
          });
        }
        await writeDB(db);
        return project;
      }).catch((error) => ({ error }));

      if (result.error) {
        badRequest(res, result.error.message);
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    match = pathname.match(/^\/api\/admin\/projects\/([^/]+)\/export\.txt$/);
    if (method === "GET" && match) {
      const db = await readDB();
      const project = findProject(db, decodeURIComponent(match[1]));
      if (!project) {
        notFound(res, "프로젝트를 찾을 수 없습니다.");
        return;
      }
      if (!project.txtDownloadEnabled) {
        badRequest(res, "TXT 다운로드가 비활성화된 프로젝트입니다.");
        return;
      }

      const filename = `${sanitizeFilename(project.name)}.txt`;
      sendText(res, 200, exportProjectText(project), {
        "Content-Disposition": `attachment; filename="${filename}"`,
      });
      return;
    }

    match = pathname.match(/^\/api\/admin\/projects\/([^/]+)\/application$/);
    if (method === "POST" && match) {
      const body = await readBody(req);
      const result = await enqueueMutation(async () => {
        const db = await readDB();
        const project = findProject(db, decodeURIComponent(match[1]));
        if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
        if (!canOpenRecruitment(project)) throw new Error("모집 중 상태에서만 참가 신청을 열거나 닫을 수 있습니다.");
        project.applicationOpen = Boolean(body.open);
        project.status = project.applicationOpen ? "recruiting" : "draft";
        project.updatedAt = now();
        project.audit.push({
          type: "application_toggle",
          open: project.applicationOpen,
          at: now(),
        });
        await writeDB(db);
        return project;
      }).catch((error) => ({ error }));

      if (result.error) {
        badRequest(res, result.error.message);
        return;
      }
      sendJson(res, 200, publicProject(result));
      return;
    }

    match = pathname.match(/^\/api\/admin\/projects\/([^/]+)\/select$/);
    if (method === "POST" && match) {
      const result = await enqueueMutation(async () => {
        const db = await readDB();
        const project = findProject(db, decodeURIComponent(match[1]));
        if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
        if (project.status === "running" || project.status === "paused" || project.status === "completed" || project.status === "archived") {
          throw new Error("모집 중인 프로젝트에서만 참가자를 추첨할 수 있습니다.");
        }
        const applicantsByStudentId = new Map();
        project.applications.forEach((entry) => {
          if (!applicantsByStudentId.has(entry.studentId)) {
            applicantsByStudentId.set(entry.studentId, entry);
          }
        });
        const uniqueApplicants = [...applicantsByStudentId.values()];
        const selected = uniqueApplicants.length <= project.targetParticipants
          ? uniqueApplicants
          : shuffle(uniqueApplicants).slice(0, project.targetParticipants);

        project.participants = selected.map((applicant) => ({
          studentId: applicant.studentId,
          name: applicant.name || "",
          order: null,
          token: randomId(18),
          status: "selected",
          submittedAt: null,
          reviewState: null,
          draftText: "",
          pendingSubmittedAt: null,
        }));
        project.currentIndex = null;
        project.pendingReview = null;
        project.status = "draft";
        project.applicationOpen = false;
        project.updatedAt = now();
        project.audit.push({
          type: "selection_draw",
          applicantCount: uniqueApplicants.length,
          selectedCount: selected.length,
          selectedStudentIds: selected.map((applicant) => applicant.studentId),
          at: now(),
        });
        await writeDB(db);
        return project;
      }).catch((error) => ({ error }));

      if (result.error) {
        badRequest(res, result.error.message);
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    match = pathname.match(/^\/api\/admin\/projects\/([^/]+)\/draw-order$/);
    if (method === "POST" && match) {
      const result = await enqueueMutation(async () => {
        const db = await readDB();
        const project = findProject(db, decodeURIComponent(match[1]));
        if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
        if (project.status === "running" || project.status === "paused" || project.status === "completed" || project.status === "archived") {
          throw new Error("준비 중 또는 모집 중 상태에서만 집필 순서를 추첨할 수 있습니다.");
        }
        if (!project.participants.length) throw new Error("먼저 참가자를 확정해 주세요.");

        const shuffled = shuffle(project.participants);
        shuffled.forEach((participant, index) => {
          participant.order = index + 1;
          participant.status = "waiting";
        });
        project.participants = shuffled;
        project.currentIndex = 0;
        project.status = "running";
        project.applicationOpen = false;
        if (project.participants[0]) {
          project.participants[0].status = "writing";
        }
        project.updatedAt = now();
        project.audit.push({
          type: "order_draw",
          participantCount: shuffled.length,
          orderStudentIds: shuffled.map((participant) => participant.studentId),
          at: now(),
        });
        await writeDB(db);
        return project;
      }).catch((error) => ({ error }));

      if (result.error) {
        badRequest(res, result.error.message);
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    match = pathname.match(/^\/api\/admin\/projects\/([^/]+)\/skip$/);
    if (method === "POST" && match) {
      const result = await enqueueMutation(async () => {
        const db = await readDB();
        const project = findProject(db, decodeURIComponent(match[1]));
        if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
        if (!project.allowSkip) throw new Error("강제 스킵이 비활성화된 프로젝트입니다.");
        if (project.status !== "running") throw new Error("진행 중인 프로젝트만 건너뛸 수 있습니다.");
        const participant = currentParticipant(project);
        if (!participant) throw new Error("현재 차례인 참가자가 없습니다.");

        participant.status = "skipped";
        participant.reviewState = null;
        participant.draftText = "";
        participant.pendingSubmittedAt = null;
        project.pendingReview = null;
        project.currentIndex += 1;
        if (project.currentIndex >= project.participants.length) {
          project.status = "completed";
          project.currentIndex = null;
        } else {
          project.participants[project.currentIndex].status = "writing";
        }
        project.updatedAt = now();
        project.audit.push({
          type: "skip",
          order: participant.order,
          studentId: participant.studentId,
          at: now(),
        });
        await writeDB(db);
        return project;
      }).catch((error) => ({ error }));

      if (result.error) {
        badRequest(res, result.error.message);
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    match = pathname.match(/^\/api\/admin\/projects\/([^/]+)\/status$/);
    if (method === "POST" && match) {
      const body = await readBody(req);
      const result = await enqueueMutation(async () => {
        const db = await readDB();
        const project = findProject(db, decodeURIComponent(match[1]));
        if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
        const nextStatus = String(body.status || "");
        const allowedStatuses = ["draft", "recruiting", "running", "paused", "completed", "archived"];
        if (!allowedStatuses.includes(nextStatus)) throw new Error("유효하지 않은 상태입니다.");
        if (nextStatus === "paused" && !project.allowPause) throw new Error("일시정지가 비활성화된 프로젝트입니다.");
        if (nextStatus === "running" && project.currentIndex === null) throw new Error("집필 순서를 먼저 추첨해 주세요.");
        if (nextStatus === "recruiting" && !canOpenRecruitment(project)) throw new Error("모집 중 상태로 전환할 수 없습니다.");

        project.status = nextStatus;
        if (nextStatus === "running" && project.currentIndex === null && project.participants.length) {
          project.currentIndex = 0;
          project.participants[0].status = "writing";
        }
        if (nextStatus === "archived") {
          project.applicationOpen = false;
        }
        project.updatedAt = now();
        project.audit.push({
          type: "status",
          status: nextStatus,
          at: now(),
        });
        await writeDB(db);
        return project;
      }).catch((error) => ({ error }));

      if (result.error) {
        badRequest(res, result.error.message);
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    match = pathname.match(/^\/api\/admin\/projects\/([^/]+)\/review\/approve$/);
    if (method === "POST" && match) {
      const result = await enqueueMutation(async () => {
        const db = await readDB();
        const project = findProject(db, decodeURIComponent(match[1]));
        if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
        if (project.status !== "running") throw new Error("진행 중인 프로젝트에서만 검수할 수 있습니다.");
        handleReviewDecision(project, "approve");
        await writeDB(db);
        return project;
      }).catch((error) => ({ error }));

      if (result.error) {
        badRequest(res, result.error.message);
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    match = pathname.match(/^\/api\/admin\/projects\/([^/]+)\/review\/revision$/);
    if (method === "POST" && match) {
      const result = await enqueueMutation(async () => {
        const db = await readDB();
        const project = findProject(db, decodeURIComponent(match[1]));
        if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
        if (project.status !== "running") throw new Error("진행 중인 프로젝트에서만 검수할 수 있습니다.");
        handleReviewDecision(project, "revision");
        await writeDB(db);
        return project;
      }).catch((error) => ({ error }));

      if (result.error) {
        badRequest(res, result.error.message);
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    match = pathname.match(/^\/api\/admin\/projects\/([^/]+)\/review\/reject$/);
    if (method === "POST" && match) {
      const result = await enqueueMutation(async () => {
        const db = await readDB();
        const project = findProject(db, decodeURIComponent(match[1]));
        if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
        if (project.status !== "running") throw new Error("진행 중인 프로젝트에서만 검수할 수 있습니다.");
        handleReviewDecision(project, "reject");
        await writeDB(db);
        return project;
      }).catch((error) => ({ error }));

      if (result.error) {
        badRequest(res, result.error.message);
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    match = pathname.match(/^\/api\/apply\/([^/]+)$/);
    if (method === "POST" && match) {
      const body = await readBody(req);
      const result = await enqueueMutation(async () => {
        const db = await readDB();
        const project = findProject(db, decodeURIComponent(match[1]));
        if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
        const state = recruitmentState(project);
        if (!state.canApply) throw new Error(state.message);
        const studentId = String(body.studentId || "").trim();
        const name = String(body.name || "").trim();
        if (!/^\d{4,12}$/.test(studentId)) throw new Error("학번 형식을 확인해 주세요.");
        if (!name) throw new Error("이름을 입력해 주세요.");
        if (name.length > 30) throw new Error("이름은 30자 이내로 입력해 주세요.");
        if (project.applications.some((entry) => entry.studentId === studentId)) throw new Error("이미 신청한 학번입니다.");

        project.applications.push({ studentId, name, appliedAt: now() });
        project.updatedAt = now();
        project.audit.push({
          type: "application",
          studentId,
          name,
          at: now(),
        });
        await writeDB(db);
        return { ok: true };
      }).catch((error) => ({ error }));

      if (result.error) {
        badRequest(res, result.error.message);
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    match = pathname.match(/^\/api\/join\/([^/]+)$/);
    if (method === "GET" && match) {
      const db = await readDB();
      const token = decodeURIComponent(match[1]);

      for (const project of db.projects) {
        const participantIndex = participantIndexByToken(project, token);
        if (participantIndex < 0) continue;
        const participant = project.participants[participantIndex];
        const isCurrent = project.currentIndex !== null && participantIndex === project.currentIndex && project.status === "running";
        const hasPendingReview = Boolean(project.pendingReview && project.pendingReview.participantToken === participant.token);

        let state = "waiting";
        if (project.status === "completed") state = "finished";
        else if (project.status === "paused") state = "paused";
        else if (hasPendingReview) state = "pending_review";
        else if (participant.status === "submitted") state = "submitted";
        else if (participant.status === "skipped") state = "skipped";
        else if (isCurrent && (participant.status === "writing" || participant.status === "revision_requested")) state = "writing";

        const visibleSentences = visibleSentencesForParticipant(project);
        const draftText = participant.draftText || "";
        const canEditPendingReview = project.reviewEnabled && project.editableAfterSubmit && state === "pending_review";

        sendJson(res, 200, {
          project: {
            id: project.id,
            name: project.name,
            description: project.description,
            status: project.status,
            reviewEnabled: project.reviewEnabled,
            visibleWindowAll: project.visibleWindowAll,
            visibleWindow: project.visibleWindow,
            characterLimitMode: project.characterLimitMode,
            characterLimit: project.characterLimit,
            countWhitespace: project.countWhitespace,
          },
          state,
          visibleSentences,
          submitted: participant.status === "submitted",
          submittedAt: participant.submittedAt || null,
          myOrder: project.revealOrderToParticipants ? participant.order : null,
          participantCount: project.revealParticipantCountToParticipants ? project.participants.length : null,
          draftText: (state === "writing" || canEditPendingReview) ? draftText : "",
          canEditPendingReview,
          reviewState: participant.reviewState || null,
          charCount: countCharacters(draftText, project.countWhitespace),
          token,
        });
        return;
      }

      notFound(res, "유효하지 않은 참가 링크입니다.");
      return;
    }

    match = pathname.match(/^\/api\/join\/([^/]+)\/submit$/);
    if (method === "POST" && match) {
      const body = await readBody(req);
      const result = await enqueueMutation(async () => {
        const db = await readDB();
        const token = decodeURIComponent(match[1]);
        for (const project of db.projects) {
          const participantIndex = participantIndexByToken(project, token);
          if (participantIndex < 0) continue;
          const participant = project.participants[participantIndex];

          if (project.status !== "running") throw new Error("지금은 작성할 차례가 아닙니다.");
          if (project.currentIndex !== participantIndex) throw new Error("지금은 작성할 차례가 아닙니다.");
          if (participant.status === "submitted") throw new Error("이미 제출했습니다.");
          if (participant.status === "skipped") throw new Error("스킵된 참가자는 제출할 수 없습니다.");

          const text = String(body.text || "").trim();
          if (!text) throw new Error("문장을 입력해 주세요.");

          const characterCount = countCharacters(text, project.countWhitespace);
          if (project.characterLimitMode === "limit" && characterCount > project.characterLimit) {
            throw new Error(`글자 수 제한을 초과했습니다. (${characterCount} / ${project.characterLimit})`);
          }

          if (project.reviewEnabled) {
            if (participant.status === "pending_review" && !project.editableAfterSubmit) {
              throw new Error("검수 대기 중입니다.");
            }
            handleReviewSubmission(project, participant, participantIndex, text);
            await writeDB(db);
            return { ok: true, status: "pending_review" };
          }

          advanceAfterApprovedSentence(project, participant, text);
          project.audit.push({
            type: "submission",
            order: participant.order,
            studentId: participant.studentId,
            at: now(),
          });
          await writeDB(db);
          return { ok: true, status: project.status };
        }
        throw new Error("유효하지 않은 참가 링크입니다.");
      }).catch((error) => ({ error }));

      if (result.error) {
        badRequest(res, result.error.message);
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    match = pathname.match(/^\/api\/public\/project\/([^/]+)$/);
    if (method === "GET" && match) {
      const db = await readDB();
      const project = findProject(db, decodeURIComponent(match[1]));
      if (!project) {
        notFound(res, "프로젝트를 찾을 수 없습니다.");
        return;
      }

      const state = recruitmentState(project);
      sendJson(res, 200, {
        id: project.id,
        name: project.name,
        description: project.description,
        status: project.status,
        applicationOpen: project.applicationOpen,
        canApply: state.canApply,
        applyMessage: state.message,
        targetParticipants: project.targetParticipants,
        visibleWindow: project.visibleWindow,
        visibleWindowAll: project.visibleWindowAll,
        characterLimitMode: project.characterLimitMode,
        characterLimit: project.characterLimit,
        countWhitespace: project.countWhitespace,
        reviewEnabled: project.reviewEnabled,
        editableAfterSubmit: project.editableAfterSubmit,
        allowSkip: project.allowSkip,
        allowPause: project.allowPause,
        txtDownloadEnabled: project.txtDownloadEnabled,
        applicationCount: project.applications.length,
        selectedCount: project.participants.length,
        sentenceCount: project.sentences.length,
      });
      return;
    }

    if (method === "GET" && !pathname.startsWith("/api/")) {
      const publicAsset = resolvePublicAsset(pathname);
      if (publicAsset) {
        sendFile(res, publicAsset);
        return;
      }
      sendHtml(res, 200, fs.readFileSync(INDEX_FILE, "utf8"));
      return;
    }

    notFound(res);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "서버 오류가 발생했습니다." });
  }
}

function createServer() {
  return http.createServer((req, res) => {
    handleRequest(req, res);
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`TiCa Relay running on http://localhost:${PORT}`);
  });
} else {
  module.exports = handleRequest;
  module.exports.createServer = createServer;
  module.exports.handleRequest = handleRequest;
  module.exports.readDB = readDB;
  module.exports.writeDB = writeDB;
  module.exports.publicProject = publicProject;
  module.exports.exportProjectText = exportProjectText;
  module.exports.normalizeProject = normalizeProject;
  module.exports.countCharacters = countCharacters;
}
