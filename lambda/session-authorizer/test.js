const { handler } = require("./index.js");
const crypto = require("crypto");

function base64UrlEncode(str) {
  return Buffer.from(str)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function mintToken(payload, secret) {
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

async function runTests() {
  console.log("=================================================");
  console.log("   TEST SUITE: session-authorizer Lambda         ");
  console.log("=================================================\n");

  const SECRET = "authorizer-shared-test-secret-value-32chars";
  process.env.SESSION_SECRET = SECRET;

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

  const validPayload = {
    githubLogin: "SaiNandhan06",
    role: "admin",
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const validToken = mintToken(validPayload, SECRET);

  // Test 1: Real authorizer event (Payload 2.0) with valid token
  const event1 = {
    version: "2.0",
    type: "REQUEST",
    headers: {
      authorization: `Bearer ${validToken}`,
      host: "6yl1sp5oa7.execute-api.us-east-1.amazonaws.com",
    },
  };
  const res1 = await handler(event1);
  assert(res1.isAuthorized === true, "Valid token authorizer event returns isAuthorized: true");
  assert(res1.context && res1.context.githubLogin === "SaiNandhan06", "Context contains correct githubLogin");
  assert(res1.context && res1.context.role === "admin", "Context contains correct role");

  // Test 2: Case-insensitive 'Authorization' header
  const event2 = {
    headers: {
      Authorization: `Bearer ${validToken}`,
    },
  };
  const res2 = await handler(event2);
  assert(res2.isAuthorized === true, "Uppercase Authorization header supported");

  // Test 3: Fallback via identitySource array
  const event3 = {
    identitySource: [`Bearer ${validToken}`],
  };
  const res3 = await handler(event3);
  assert(res3.isAuthorized === true, "identitySource array supported");

  // Test 4: Missing Authorization header
  const eventMissing = { headers: {} };
  const resMissing = await handler(eventMissing);
  assert(resMissing.isAuthorized === false, "Missing Authorization header returns isAuthorized: false");

  // Test 5: Malformed header (missing 'Bearer ' prefix)
  const eventMalformedHeader = {
    headers: { authorization: `Basic ${validToken}` },
  };
  const resMalformedHeader = await handler(eventMalformedHeader);
  assert(resMalformedHeader.isAuthorized === false, "Missing 'Bearer' prefix returns isAuthorized: false");

  // Test 6: Malformed token string
  const eventBadToken = {
    headers: { authorization: "Bearer invalid.token" },
  };
  const resBadToken = await handler(eventBadToken);
  assert(resBadToken.isAuthorized === false, "Malformed token string returns isAuthorized: false");

  // Test 7: Tampered signature (signed with different secret)
  const tamperedToken = mintToken(validPayload, "attacker-secret-xyz");
  const eventTampered = {
    headers: { authorization: `Bearer ${tamperedToken}` },
  };
  const resTampered = await handler(eventTampered);
  assert(resTampered.isAuthorized === false, "Signature signed with different secret returns isAuthorized: false");

  // Test 8: Deliberately expired token
  const expiredPayload = {
    githubLogin: "SaiNandhan06",
    role: "admin",
    exp: Math.floor(Date.now() / 1000) - 300, // Expired 5 mins ago
  };
  const expiredToken = mintToken(expiredPayload, SECRET);
  const eventExpired = {
    headers: { authorization: `Bearer ${expiredToken}` },
  };
  const resExpired = await handler(eventExpired);
  assert(resExpired.isAuthorized === false, "Expired token returns isAuthorized: false");

  // Test 9: Null / garbage event (robustness against crash)
  let threwException = false;
  try {
    const resGarbage = await handler(null);
    assert(resGarbage.isAuthorized === false, "Null event returns isAuthorized: false without throwing");
  } catch {
    threwException = true;
  }
  assert(!threwException, "Handler never throws an uncaught exception on garbage input");

  console.log(`\n=================================================`);
  console.log(`   Finished: ${passed} passed, ${failed} failed.`);
  console.log(`=================================================`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
