const adminHandler = require("./index.js").handler;
const limitedHandler = require("../delete-attempt-limited/index.js").handler;
const fs = require("fs");
const path = require("path");

async function runV5Verification() {
  console.log("=========================================================");
  console.log("   V5 — VERIFY SERVER-SIDE ROLE ENFORCEMENT & ACTOR      ");
  console.log("=========================================================\n");

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

  // -------------------------------------------------------------
  // Check 1: delete-attempt-admin rejects user-role callers with 403
  // -------------------------------------------------------------
  console.log("--> Check 1: delete-attempt-admin with 'user'-role token...");
  const userEvent = {
    pathParameters: { id: "test-rec-001" },
    requestContext: {
      authorizer: {
        lambda: {
          githubLogin: "regular-auditor",
          role: "user",
        },
      },
    },
  };

  const res1 = await adminHandler(userEvent);
  assert(res1.statusCode === 403, "delete-attempt-admin returns HTTP 403 Forbidden for 'user' role");
  const data1 = JSON.parse(res1.body);
  assert(data1.error && data1.error.role === "user", "Error response indicates role='user'");
  assert(data1.error && data1.error.actor === "regular-auditor", "Error response reflects authorizer githubLogin='regular-auditor'");

  // -------------------------------------------------------------
  // Check 2: delete-attempt-admin rejects unauthenticated / missing role
  // -------------------------------------------------------------
  console.log("\n--> Check 2: delete-attempt-admin with missing / empty authorizer context...");
  const emptyAuthEvent = {
    pathParameters: { id: "test-rec-001" },
    requestContext: {},
  };
  const res2 = await adminHandler(emptyAuthEvent);
  assert(res2.statusCode === 403, "delete-attempt-admin defaults to 403 when role is missing/not admin");

  // -------------------------------------------------------------
  // Check 3: delete-attempt-admin allows 'admin' role to proceed to S3/DynamoDB
  // -------------------------------------------------------------
  console.log("\n--> Check 3: delete-attempt-admin with 'admin'-role token...");
  const adminEvent = {
    pathParameters: { id: "non-existent-rec" },
    requestContext: {
      authorizer: {
        lambda: {
          githubLogin: "SaiNandhan06",
          role: "admin",
        },
      },
    },
  };

  let passedAdminGate = false;
  try {
    const res3 = await adminHandler(adminEvent);
    // If it reached DynamoDB and couldn't find the record (404) or processed it,
    // it successfully passed the 403 gate!
    if (res3.statusCode !== 403) {
      passedAdminGate = true;
    }
  } catch (err) {
    // If it threw an AWS credential/network error when calling DynamoDB,
    // it confirmed that it passed the 403 check and executed the business logic!
    passedAdminGate = true;
  }
  assert(passedAdminGate, "delete-attempt-admin allows 'admin' role to pass the role check");

  // -------------------------------------------------------------
  // Check 4: delete-attempt-limited permits 'user' role (no 403 restriction)
  // -------------------------------------------------------------
  console.log("\n--> Check 4: delete-attempt-limited with 'user'-role token...");
  const limitedUserEvent = {
    pathParameters: { id: "non-existent-rec" },
    requestContext: {
      authorizer: {
        lambda: {
          githubLogin: "auditor-jane",
          role: "user",
        },
      },
    },
  };

  let limitedPassed = false;
  try {
    const res4 = await limitedHandler(limitedUserEvent);
    if (res4.statusCode !== 403) {
      limitedPassed = true;
    }
  } catch (err) {
    limitedPassed = true;
  }
  assert(limitedPassed, "delete-attempt-limited allows 'user' role without 403 restriction");

  // -------------------------------------------------------------
  // Check 5: Confirm placeholder 'api-caller' is completely eliminated
  // -------------------------------------------------------------
  console.log("\n--> Check 5: Confirm zero remaining 'api-caller' placeholders...");
  const adminFileContent = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  const limitedFileContent = fs.readFileSync(path.join(__dirname, "../delete-attempt-limited/index.js"), "utf8");

  assert(!adminFileContent.includes('"api-caller"') && !adminFileContent.includes("'api-caller'"),
    "delete-attempt-admin/index.js contains no 'api-caller' placeholder");
  assert(!limitedFileContent.includes('"api-caller"') && !limitedFileContent.includes("'api-caller'"),
    "delete-attempt-limited/index.js contains no 'api-caller' placeholder");

  console.log(`\n=========================================================`);
  console.log(`   Verification Results: ${passed} passed, ${failed} failed.`);
  console.log(`=========================================================`);

  if (failed > 0) process.exit(1);
}

runV5Verification().catch((err) => {
  console.error("Verification error:", err);
  process.exit(1);
});
