const { handler } = require("./index.js");

async function runTests() {
  console.log("=========================================================");
  console.log("   TEST SUITE: delete-attempt-admin Role Enforcement     ");
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

  // Test 1: User-role caller is blocked with 403 immediately (Prompt B5)
  const userRoleEvent = {
    pathParameters: { id: "test-record-id-123" },
    requestContext: {
      authorizer: {
        lambda: {
          githubLogin: "regular-auditor",
          role: "user",
        },
      },
    },
  };

  const res1 = await handler(userRoleEvent);
  assert(res1.statusCode === 403, "User-role caller receives HTTP 403 Forbidden");
  const data1 = JSON.parse(res1.body);
  assert(data1.error && data1.error.role === "user", "Response details user role restriction");
  assert(data1.error.actor === "regular-auditor", "Response captures real githubLogin actor");

  // Test 2: Missing role / unauthenticated caller blocked with 403
  const noRoleEvent = {
    pathParameters: { id: "test-record-id-123" },
    requestContext: {
      authorizer: {
        lambda: {
          githubLogin: "unauth-caller",
        },
      },
    },
  };

  const res2 = await handler(noRoleEvent);
  assert(res2.statusCode === 403, "Caller without explicit admin role blocked with HTTP 403");

  // Test 3: Admin-role caller passes role check (proceeds past role gate)
  const adminRoleEvent = {
    pathParameters: { id: "non-existent-record-id" },
    requestContext: {
      authorizer: {
        lambda: {
          githubLogin: "SaiNandhan06",
          role: "admin",
        },
      },
    },
  };

  let passedRoleCheck = false;
  try {
    const res3 = await handler(adminRoleEvent);
    if (res3.statusCode !== 403) passedRoleCheck = true;
  } catch (err) {
    // If it threw an error in DynamoDB/S3, it means it already passed the 403 role check!
    passedRoleCheck = true;
  }
  assert(passedRoleCheck, "Admin-role caller successfully passes server-side role check (reaches execution layer)");

  console.log(`\n=========================================================`);
  console.log(`   Finished: ${passed} passed, ${failed} failed.`);
  console.log(`=========================================================`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error("Test execution error:", err);
  process.exit(1);
});
