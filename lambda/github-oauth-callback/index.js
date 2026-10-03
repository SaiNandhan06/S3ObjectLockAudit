const crypto = require("crypto");

/**
 * Base64URL encoder/decoder helpers without external dependencies
 */
function base64UrlEncode(str) {
  return Buffer.from(str)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(str) {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  return Buffer.from(base64, "base64").toString("utf8");
}

/**
 * Mint a signed session token:
 * header.payload.signature using HMAC-SHA256 over `${header}.${payload}`
 */
function mintSessionToken(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto
    .createHmac("sha256", secret)
    .update(dataToSign)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${dataToSign}.${signature}`;
}

/**
 * Verify a session token using HMAC-SHA256
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
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return null; // Expired
    }
    return payload;
  } catch {
    return null;
  }
}

exports.mintSessionToken = mintSessionToken;
exports.verifySessionToken = verifySessionToken;

/**
 * Main Lambda Handler: GET /auth/callback?code=...
 */
exports.handler = async (event) => {
  const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
  const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
  const SESSION_SECRET = process.env.SESSION_SECRET;
  const ADMIN_GITHUB_LOGINS = process.env.ADMIN_GITHUB_LOGINS || "";
  const FRONTEND_URL = (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/+$/, "");

  if (!SESSION_SECRET) {
    console.error("SESSION_SECRET configuration is missing");
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: { message: "Authentication service misconfigured" } }),
    };
  }

  // 1. Extract authorization code from query parameters
  let code = null;
  if (event.queryStringParameters && event.queryStringParameters.code) {
    code = event.queryStringParameters.code;
  } else if (event.rawQueryString) {
    const params = new URLSearchParams(event.rawQueryString);
    code = params.get("code");
  }

  if (!code) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: { message: "Missing required 'code' query parameter" } }),
    };
  }

  try {
    // 2. Exchange code for GitHub access token (POST https://github.com/login/oauth/access_token)
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code: code,
      }),
    });

    if (!tokenRes.ok) {
      console.error("GitHub access token exchange returned HTTP status", tokenRes.status);
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: { message: "Failed to exchange code with GitHub" } }),
      };
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      console.error("GitHub OAuth response did not contain access_token (error:", tokenData.error, ")");
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: { message: tokenData.error_description || "Invalid or expired GitHub authorization code" },
        }),
      };
    }

    // 3. Fetch user profile from GitHub API (GET https://api.github.com/user)
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "AuditLock-OAuth-Handler",
        Accept: "application/vnd.github.v3+json",
      },
    });

    if (!userRes.ok) {
      console.error("GitHub user profile request failed with HTTP status", userRes.status);
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: { message: "Failed to retrieve GitHub user profile" } }),
      };
    }

    const userData = await userRes.json();
    const githubLogin = userData.login;

    if (!githubLogin) {
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: { message: "GitHub user profile missing login identifier" } }),
      };
    }

    // Discard accessToken immediately - never stored or logged

    // 4. Determine user role based on ADMIN_GITHUB_LOGINS allow-list
    const adminList = ADMIN_GITHUB_LOGINS.split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);

    const isMatch = adminList.includes(githubLogin.toLowerCase());
    const role = isMatch ? "admin" : "user";

    // 5. Mint session token (HMAC-SHA256, 12-hour expiry)
    const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60; // 12 hours from now
    const sessionPayload = {
      githubLogin,
      role,
      exp,
    };

    const sessionToken = mintSessionToken(sessionPayload, SESSION_SECRET);

    // 6. Respond with 302 redirect to URL fragment: ${FRONTEND_URL}/#token=<token>
    const redirectUrl = `${FRONTEND_URL}/#token=${encodeURIComponent(sessionToken)}`;

    return {
      statusCode: 302,
      headers: {
        Location: redirectUrl,
        "Cache-Control": "no-store, no-cache, must-revalidate",
        Pragma: "no-cache",
      },
      body: "",
    };
  } catch (err) {
    console.error("Unhandled error during OAuth callback flow:", err.message);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: { message: "Authentication process encountered an unexpected error" } }),
    };
  }
};
