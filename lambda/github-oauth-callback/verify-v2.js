const { handler, mintSessionToken, verifySessionToken } = require("./index.js");

async function runV2Verification() {
  console.log("=================================================");
  console.log("   V2 — VERIFY GITHUB OAUTH CALLBACK CHECKS     ");
  console.log("=================================================\n");

  const results = {};
  const MOCK_SECRET = "auditlock-session-secret-production-quality-key-256";
  const ADMIN_USER = "SaiNandhan06";
  const REGULAR_USER = "external-auditor-jane";
  const FRONTEND_ORIGIN = "http://localhost:3000";

  process.env.SESSION_SECRET = MOCK_SECRET;
  process.env.ADMIN_GITHUB_LOGINS = ADMIN_USER;
  process.env.FRONTEND_URL = FRONTEND_ORIGIN;
  process.env.GITHUB_CLIENT_ID = "Iv1.test_client_id";
  process.env.GITHUB_CLIENT_SECRET = "ghs_very_secret_oauth_client_key_999";

  const originalFetch = global.fetch;

  // -------------------------------------------------------------------------
  // Check 1: OAuth Flow Simulation & 302 Fragment Redirect
  // -------------------------------------------------------------------------
  console.log("--> Check 1: Validating OAuth code exchange and 302 URL fragment redirect...");
  let capturedToken = null;
  let redirectLocation = null;

  try {
    global.fetch = async (url, options) => {
      if (url === "https://github.com/login/oauth/access_token") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "gho_test_user_access_token_12345", token_type: "bearer" }),
        };
      }
      if (url === "https://api.github.com/user") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ login: ADMIN_USER, id: 10101 }),
        };
      }
      return originalFetch(url, options);
    };

    const res1 = await handler({ queryStringParameters: { code: "valid-gh-auth-code" } });

    if (res1.statusCode === 302 && res1.headers && res1.headers.Location) {
      redirectLocation = res1.headers.Location;
      const urlParts = redirectLocation.split("#token=");
      if (urlParts.length === 2 && urlParts[0].replace(/\/+$/, "") === FRONTEND_ORIGIN.replace(/\/+$/, "")) {
        capturedToken = decodeURIComponent(urlParts[1]);
        results.check1 = {
          status: "PASS",
          detail: `HTTP 302 Redirect to ${FRONTEND_ORIGIN}/#token=<token>. Fragment confirmed (no query parameter leak).`,
        };
        console.log(`[PASS] Check 1: 302 Redirect verified to URL fragment: ${redirectLocation.slice(0, 45)}...\n`);
      } else {
        results.check1 = { status: "FAIL", detail: `Location did not use #token= fragment: ${redirectLocation}` };
        console.log(`[FAIL] Check 1: Unexpected location: ${redirectLocation}\n`);
      }
    } else {
      results.check1 = { status: "FAIL", detail: `Expected 302, got ${res1.statusCode}` };
      console.log(`[FAIL] Check 1: HTTP status ${res1.statusCode}\n`);
    }
  } catch (err) {
    results.check1 = { status: "FAIL", detail: err.message };
  }

  // -------------------------------------------------------------------------
  // Check 2: Decode Token Payload & Confirm Admin Role for Allow-listed User
  // -------------------------------------------------------------------------
  console.log("--> Check 2: Decoding token payload for allow-listed user...");
  try {
    const verifiedAdmin = verifySessionToken(capturedToken, MOCK_SECRET);
    if (verifiedAdmin && verifiedAdmin.githubLogin === ADMIN_USER && verifiedAdmin.role === "admin") {
      results.check2 = {
        status: "PASS",
        detail: `Verified payload: githubLogin='${verifiedAdmin.githubLogin}', role='${verifiedAdmin.role}'. Admin privileges granted.`,
      };
      console.log(`[PASS] Check 2: Payload verified: githubLogin=${verifiedAdmin.githubLogin}, role=${verifiedAdmin.role}\n`);
    } else {
      results.check2 = { status: "FAIL", detail: `Payload invalid: ${JSON.stringify(verifiedAdmin)}` };
      console.log(`[FAIL] Check 2: ${JSON.stringify(verifiedAdmin)}\n`);
    }
  } catch (err) {
    results.check2 = { status: "FAIL", detail: err.message };
  }

  // -------------------------------------------------------------------------
  // Check 3: Non-Allowlisted Account Receives 'user' Role
  // -------------------------------------------------------------------------
  console.log("--> Check 3: Non-allowlisted user receives 'user' role...");
  try {
    global.fetch = async (url, options) => {
      if (url === "https://github.com/login/oauth/access_token") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "gho_regular_user_access_token_67890", token_type: "bearer" }),
        };
      }
      if (url === "https://api.github.com/user") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ login: REGULAR_USER, id: 20202 }),
        };
      }
      return originalFetch(url, options);
    };

    const resUser = await handler({ queryStringParameters: { code: "valid-regular-gh-code" } });
    const userToken = decodeURIComponent(resUser.headers.Location.split("#token=")[1]);
    const verifiedUser = verifySessionToken(userToken, MOCK_SECRET);

    if (verifiedUser && verifiedUser.githubLogin === REGULAR_USER && verifiedUser.role === "user") {
      results.check3 = {
        status: "PASS",
        detail: `Non-allowlisted username '${REGULAR_USER}' received role='user'. Admin override restricted.`,
      };
      console.log(`[PASS] Check 3: Non-allowlisted account successfully restricted to role='user'\n`);
    } else {
      results.check3 = { status: "FAIL", detail: `Role was not 'user': ${JSON.stringify(verifiedUser)}` };
      console.log(`[FAIL] Check 3: Unexpected role: ${JSON.stringify(verifiedUser)}\n`);
    }
  } catch (err) {
    results.check3 = { status: "FAIL", detail: err.message };
  }

  // -------------------------------------------------------------------------
  // Check 4: Confirm Logs Contain No Secrets, Access Tokens, or Plaintext Tokens
  // -------------------------------------------------------------------------
  console.log("--> Check 4: Verifying CloudWatch logs security and sanitization...");
  const logEntries = [];
  const captureLog = (...args) => logEntries.push(args.join(" "));
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;

  console.log = captureLog;
  console.error = captureLog;
  console.warn = captureLog;

  try {
    await handler({ queryStringParameters: { code: "audit-log-hygiene-code" } });
  } finally {
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
  }

  const allLogs = logEntries.join("\n");
  const leakedSecret = allLogs.includes(process.env.GITHUB_CLIENT_SECRET);
  const leakedAccessToken = allLogs.includes("gho_regular_user_access_token_67890") || allLogs.includes("gho_test_user_access_token_12345");
  const leakedSessionToken = capturedToken && allLogs.includes(capturedToken);

  if (!leakedSecret && !leakedAccessToken && !leakedSessionToken) {
    results.check4 = {
      status: "PASS",
      detail: "CloudWatch logs inspected: GITHUB_CLIENT_SECRET, GitHub access_token, and full session tokens are completely absent from plaintext logs.",
    };
    console.log(`[PASS] Check 4: Logs confirmed clean. Zero credentials or tokens leaked.\n`);
  } else {
    results.check4 = {
      status: "FAIL",
      detail: `Leak detected: secret=${leakedSecret}, accessToken=${leakedAccessToken}, sessionToken=${leakedSessionToken}`,
    };
    console.log(`[FAIL] Check 4: Credential leak in logs\n`);
  }

  // -------------------------------------------------------------------------
  // Check 5: Token Expiration Verification (12-Hour Expiry & Rejection)
  // -------------------------------------------------------------------------
  console.log("--> Check 5: Validating 12-hour expiry timestamp and rejection of expired tokens...");
  const verifiedAdmin = verifySessionToken(capturedToken, MOCK_SECRET);
  const now = Math.floor(Date.now() / 1000);
  const diffSeconds = verifiedAdmin.exp - now;
  const is12Hours = diffSeconds >= 43190 && diffSeconds <= 43210;

  // Shorten expiry artificially to simulate expired token
  const expiredPayload = {
    githubLogin: ADMIN_USER,
    role: "admin",
    exp: now - 10, // Expired 10 seconds ago
  };
  const artificiallyExpiredToken = mintSessionToken(expiredPayload, MOCK_SECRET);
  const rejectionResult = verifySessionToken(artificiallyExpiredToken, MOCK_SECRET);

  if (is12Hours && rejectionResult === null) {
    results.check5 = {
      status: "PASS",
      detail: `Token exp field set to +12 hours (${diffSeconds}s). Artificially expired token confirmed rejected (returned null).`,
    };
    console.log(`[PASS] Check 5: 12-hour lifetime verified; expired token strictly rejected.\n`);
  } else {
    results.check5 = {
      status: "FAIL",
      detail: `is12Hours=${is12Hours} (diff=${diffSeconds}s), rejectionResult=${rejectionResult}`,
    };
    console.log(`[FAIL] Check 5: Expiration logic mismatch\n`);
  }

  // Restore fetch
  global.fetch = originalFetch;

  console.log("=================================================");
  console.log("                   SUMMARY                       ");
  console.log("=================================================");
  console.log(JSON.stringify(results, null, 2));

  return results;
}

runV2Verification().catch(console.error);
