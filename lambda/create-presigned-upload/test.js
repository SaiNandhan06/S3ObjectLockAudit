const { handler } = require("./index.js");

async function runTests() {
  console.log("=== Running Presigned Upload Handler Tests ===\n");
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

  // Test 1: Valid PDF
  const res1 = await handler({
    body: JSON.stringify({ fileName: "audit-report.pdf", contentType: "application/pdf" }),
  });
  assert(res1.statusCode === 200, "Valid PDF returns 200");
  const data1 = JSON.parse(res1.body);
  assert(data1.uploadUrl && data1.uploadUrl.includes("s3objectlock-auditlock-locked"), "uploadUrl includes bucket");
  assert(data1.s3Bucket === "s3objectlock-auditlock-locked", "s3Bucket is correct");
  assert(data1.s3Key.startsWith("uploads/") && data1.s3Key.endsWith("-audit-report.pdf"), "s3Key format matches uploads/<uuid>-<fileName>");
  assert(data1.expiresIn === 300, "expiresIn is 300");

  // Test 2: Invalid ContentType (application/zip)
  const res2 = await handler({
    body: JSON.stringify({ fileName: "archive.zip", contentType: "application/zip" }),
  });
  assert(res2.statusCode === 400, "Disallowed contentType (application/zip) returns 400");

  // Test 3: Path Traversal with ".."
  const res3 = await handler({
    body: JSON.stringify({ fileName: "../../../etc/passwd", contentType: "text/plain" }),
  });
  assert(res3.statusCode === 400, "Path traversal with '..' returns 400");

  // Test 4: Path Traversal with leading "/"
  const res4 = await handler({
    body: JSON.stringify({ fileName: "/root/secret.txt", contentType: "text/plain" }),
  });
  assert(res4.statusCode === 400, "Leading '/' returns 400");

  // Test 5: Valid text/plain
  const res5 = await handler({
    body: JSON.stringify({ fileName: "notes.txt", contentType: "text/plain" }),
  });
  assert(res5.statusCode === 200, "Valid text/plain returns 200");

  // Test 6: Valid image/png
  const res6 = await handler({
    body: JSON.stringify({ fileName: "photo.png", contentType: "image/png" }),
  });
  assert(res6.statusCode === 200, "Valid image/png returns 200");

  // Test 7: Valid image/jpeg
  const res7 = await handler({
    body: JSON.stringify({ fileName: "photo.jpg", contentType: "image/jpeg" }),
  });
  assert(res7.statusCode === 200, "Valid image/jpeg returns 200");

  console.log(`\nTests finished: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
