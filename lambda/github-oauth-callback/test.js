const { handler, mintSessionToken, verifySessionToken } = require("./index.js");

async function runTests() {
  console.log("=================================================");
  console.log("   TEST SUITE: github-oauth-callback Lambda      ");
  console.log("=================================================\n");

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      failed++;
    }
  }

  const TEST_SECRET = "super-secret-cryptographic-key-for-auditlock-2026";
  process.env.SESSION_SECRET = TEST_SECRET;
  process.env.ADMIN_GITHUB_LOGINS = "SaiNandhan06,testadmin";
  process.env.FRONTEND_URL = "https://d12345abcdef.cloudfront.net";

  // Test 1: Missing code returns 400
  const resMissingCode = await handler({ queryStringParameters: {} });
  assert(resMissingCode.statusCode === 400, "Missing code query param returns HTTP 400");

  // Test 2: Token Minting & Verification
  const payloadAdmin = {
    githubLogin: "SaiNandhan06",
    role: "admin",
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
  };
  const token = mintSessionToken(payloadAdmin, TEST_SECRET);
  assert(typeof token === "string" && token.split(".").length === 3, "Token generated in header.payload.signature format");

  const verifiedPayload = verifySessionToken(token, TEST_SECRET);
  assert(verifiedPayload !== null, "Valid token verifies successfully");
  assert(verifiedPayload.githubLogin === "SaiNandhan06", "Payload contains correct githubLogin");
  assert(verifiedPayload.role === "admin", "Payload contains correct role");

  // Test 3: Tampered Token Detection (wrong secret or altered payload)
  const tamperedToken = token.slice(0, -4) + "XXXX";
  const verifiedTampered = verifySessionToken(tamperedToken, TEST_SECRET);
  assert(verifiedTampered === null, "Tampered signature correctly rejected");

  const wrongSecretVerified = verifySessionToken(token, "different-wrong-secret");
  assert(wrongSecretVerified === null, "Token signed with different secret rejected");

  // Test 4: Expired Token Detection
  const expiredPayload = {
    githubLogin: "SaiNandhan06",
    role: "admin",
    exp: Math.floor(Date.now() / 1000) - 60, // Expired 1 min ago
  };
  const expiredToken = mintSessionToken(expiredPayload, TEST_SECRET);
  const verifiedExpired = verifySessionToken(expiredToken, TEST_SECRET);
  assert(verifiedExpired === null, "Expired token correctly rejected");

  // Test 5: Role Determination (Admin vs User)
  const adminLogins = process.env.ADMIN_GITHUB_LOGINS.split(",").map((s) => s.trim().toLowerCase());
  assert(adminLogins.includes("sainandhan06".toLowerCase()), "Allow-listed admin username resolves to admin");
  assert(!adminLogins.includes("regular-auditor".toLowerCase()), "Non-allowlisted username resolves to user");

  // Test 6: 12-Hour Expiry Window
  const expectedExpSeconds = 12 * 3600;
  const now = Math.floor(Date.now() / 1000);
  assert(payloadAdmin.exp - now >= expectedExpSeconds - 5, "Session token expires in 12 hours (43,200 seconds)");

  // Test 7: Full OAuth Callback Simulation with Mock GitHub APIs
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url, options) => {
      if (url === "https://github.com/login/oauth/access_token") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "gho_mock_access_token_12345", token_type: "bearer" }),
        };
      }
      if (url === "https://api.github.com/user") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ login: "SaiNandhan06", id: 12345 }),
        };
      }
      return originalFetch(url, options);
    };

    const mockEvent = {
      queryStringParameters: { code: "valid-github-temp-code" },
    };
    const resOAuth = await handler(mockEvent);

    assert(resOAuth.statusCode === 302, "Successful OAuth callback responds with HTTP 302 redirect");
    assert(
      resOAuth.headers.Location.startsWith("https://d12345abcdef.cloudfront.net/#token="),
      "Redirect Location points to FRONTEND_URL with token in URL fragment (#token=...)"
    );

    // Extract redirected token and verify
    const tokenUrlEncoded = resOAuth.headers.Location.split("#token=")[1];
    const extractedToken = decodeURIComponent(tokenUrlEncoded);
    const verifiedExtracted = verifySessionToken(extractedToken, TEST_SECRET);

    assert(verifiedExtracted !== null, "Redirected token is valid and verifiable");
    assert(verifiedExtracted.githubLogin === "SaiNandhan06", "Redirected token login matches GitHub profile");
    assert(verifiedExtracted.role === "admin", "Redirected token has admin role for allow-listed login");
  } finally {
    global.fetch = originalFetch;
  }

  // Test 8: Non-Admin User Simulation
  try {
    global.fetch = async (url, options) => {
      if (url === "https://github.com/login/oauth/access_token") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "gho_mock_access_token_67890", token_type: "bearer" }),
        };
      }
      if (url === "https://api.github.com/user") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ login: "auditor-external", id: 67890 }),
        };
      }
      return originalFetch(url, options);
    };

    const mockEventNonAdmin = {
      queryStringParameters: { code: "valid-non-admin-code" },
    };
    const resNonAdmin = await handler(mockEventNonAdmin);
    const extractedToken = decodeURIComponent(resNonAdmin.headers.Location.split("#token=")[1]);
    const verifiedExtracted = verifySessionToken(extractedToken, TEST_SECRET);

    assert(verifiedExtracted.role === "user", "Non-admin login correctly receives 'user' role");
  } finally {
    global.fetch = originalFetch;
  }

  console.log(`\n=================================================`);
  console.log(`   Finished: ${passed} passed, ${failed} failed.`);
  console.log(`=================================================`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error("Test execution encountered an error:", err);
  process.exit(1);
});
