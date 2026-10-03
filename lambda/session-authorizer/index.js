const crypto = require("crypto");

/**
 * Base64URL decoder helper without external dependencies
 */
function base64UrlDecode(str) {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  return Buffer.from(base64, "base64").toString("utf8");
}

/**
 * Verify a session token using HMAC-SHA256:
 * Expects "header.payload.signature" signed over "header.payload"
 */
function verifySessionToken(token, secret) {
  if (!token || typeof token !== "string") return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, signature] = parts;
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(dataToSign)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
    return null; // Invalid signature / tampered
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (!payload || typeof payload !== "object") return null;

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || typeof payload.exp !== "number" || payload.exp < now) {
      return null; // Expired or missing exp
    }

    if (!payload.githubLogin || typeof payload.githubLogin !== "string") {
      return null; // Missing required login identifier
    }

    return payload;
  } catch {
    return null; // JSON parse error
  }
}

exports.verifySessionToken = verifySessionToken;

/**
 * API Gateway HTTP API Lambda Authorizer (Simple Response Format 2.0)
 * Expected Response on rejection: { isAuthorized: false }
 * Expected Response on success:   { isAuthorized: true, context: { githubLogin, role } }
 */
exports.handler = async (event) => {
  try {
    const SESSION_SECRET = process.env.SESSION_SECRET;
    if (!SESSION_SECRET) {
      console.error("SESSION_SECRET environment variable is missing");
      return { isAuthorized: false };
    }

    // 1. Locate the Authorization header
    // Case-insensitive search in event.headers or identitySource array
    let authHeader = "";
    if (event.headers) {
      for (const [key, value] of Object.entries(event.headers)) {
        if (key.toLowerCase() === "authorization") {
          authHeader = value;
          break;
        }
      }
    }

    if (!authHeader && Array.isArray(event.identitySource) && event.identitySource.length > 0) {
      authHeader = event.identitySource[0] || "";
    }

    if (!authHeader || typeof authHeader !== "string") {
      return { isAuthorized: false };
    }

    // 2. Validate "Bearer <token>" format
    const trimmedHeader = authHeader.trim();
    if (!trimmedHeader.toLowerCase().startsWith("bearer ")) {
      return { isAuthorized: false };
    }

    const token = trimmedHeader.slice(7).trim();
    if (!token) {
      return { isAuthorized: false };
    }

    // 3. Verify cryptographic signature & expiration
    const payload = verifySessionToken(token, SESSION_SECRET);
    if (!payload) {
      return { isAuthorized: false };
    }

    // 4. Return authorized response with session context
    return {
      isAuthorized: true,
      context: {
        githubLogin: String(payload.githubLogin),
        role: String(payload.role || "user"),
      },
    };
  } catch (err) {
    // Catch-all safety guardrail: NEVER throw an uncaught exception
    // Returning { isAuthorized: false } yields a clean 401 response instead of a 5xx crash
    console.warn("Authorizer caught unexpected error, returning unauthorized:", err.message);
    return { isAuthorized: false };
  }
};
