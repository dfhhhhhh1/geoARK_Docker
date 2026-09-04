/**
 * Access control.
 *
 * WHY A COOKIE AND NOT A BEARER HEADER: the analysis UI runs on
 * GET /api/analyze/stream via EventSource, and EventSource cannot set request
 * headers. A token in the querystring would end up in nginx access logs and in
 * browser history. A cookie is the only mechanism that works for the streaming
 * endpoint without leaking the credential into a log.
 *
 * Sessions are a signed value, not a stored one: HMAC-SHA256 over a small
 * payload, verified on each request. Nothing to persist, nothing to evict, and
 * a restart invalidates everything -- acceptable for a single-instance
 * deployment, and it keeps the whole thing dependency-free.
 *
 * AUTH IS OFF UNTIL ACCESS_CODE IS SET. That is deliberate: turning it on by
 * default would break the eval harness and local development, and a half-broken
 * dev loop is how people end up disabling security properly. The server logs a
 * loud warning whenever it starts unprotected.
 */

const crypto = require("crypto");

const COOKIE_NAME = "geoark_session";
const DEFAULT_TTL_HOURS = 12;

/** Codes that grant access. Multiple so they can be handed out and revoked individually. */
function accessCodes() {
  const raw = process.env.ACCESS_CODE || process.env.ACCESS_CODES || "";
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

const AUTH_ENABLED = accessCodes().length > 0;

/**
 * Signing key. A generated one is fine -- it only means sessions do not survive
 * a restart -- but it must never be a fixed default, or every deployment that
 * forgets to set it shares a forgeable key.
 */
const SESSION_SECRET = process.env.SESSION_SECRET
  || crypto.randomBytes(32).toString("hex");
const SECRET_WAS_GENERATED = !process.env.SESSION_SECRET;

const TTL_MS = Number(process.env.SESSION_TTL_HOURS || DEFAULT_TTL_HOURS) * 3600_000;

const b64u = (buf) => Buffer.from(buf).toString("base64url");

function sign(payloadB64) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(payloadB64).digest("base64url");
}

/** Timing-safe compare that does not leak length via early return. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // Still burn a comparison so a length mismatch is not measurably faster.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function issueToken(subject) {
  const payload = b64u(JSON.stringify({ sub: subject, exp: Date.now() + TTL_MS }));
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payload, mac] = token.split(".", 2);
  if (!payload || !mac || !safeEqual(mac, sign(payload))) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!claims.exp || claims.exp < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Minimal cookie header parse -- avoids a dependency for one header. */
function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

function setSessionCookie(req, res, token) {
  // Secure only over https, or the cookie is silently dropped on a plain-http
  // localhost deployment and login appears to fail for no visible reason.
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const secure = proto === "https";
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,          // not readable from JS, so XSS cannot exfiltrate it
    sameSite: "strict",      // the API is same-origin behind nginx; blocks CSRF
    secure,
    maxAge: TTL_MS,
    path: "/",
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: "/", httpOnly: true, sameSite: "strict" });
}

/**
 * Identity for a request: the session subject when signed in, otherwise the
 * client address. Used for rate limiting, so it must be present even when auth
 * is disabled.
 */
function identify(req) {
  const claims = verifyToken(readCookie(req, COOKIE_NAME));
  if (claims?.sub) return `s:${claims.sub}`;
  // trust proxy is set, so req.ip already reflects X-Forwarded-For from nginx.
  return `ip:${req.ip || req.socket?.remoteAddress || "unknown"}`;
}

/** Express middleware. A no-op when no ACCESS_CODE is configured. */
function requireAuth(req, res, next) {
  if (!AUTH_ENABLED) return next();
  if (verifyToken(readCookie(req, COOKIE_NAME))) return next();
  return res.status(401).json({
    error: "not signed in",
    detail: "This instance requires an access code.",
    auth_required: true,
  });
}

/** True when the supplied code matches one that is configured. */
function checkCode(candidate) {
  if (typeof candidate !== "string" || !candidate) return false;
  // Compare against every code so the time taken does not reveal which matched.
  let ok = false;
  for (const code of accessCodes()) if (safeEqual(candidate, code)) ok = true;
  return ok;
}

function startupWarning() {
  if (AUTH_ENABLED) {
    const n = accessCodes().length;
    return `  Auth ENABLED (${n} access code${n === 1 ? "" : "s"})` +
      (SECRET_WAS_GENERATED
        ? "\n  ! SESSION_SECRET unset - sessions will not survive a restart"
        : "");
  }
  return "  ! AUTH DISABLED - no ACCESS_CODE set. Every endpoint is open,\n" +
         "  ! including the LLM. Do not expose this beyond localhost.";
}

module.exports = {
  AUTH_ENABLED, COOKIE_NAME,
  issueToken, verifyToken, readCookie,
  setSessionCookie, clearSessionCookie,
  requireAuth, checkCode, identify, startupWarning,
};
