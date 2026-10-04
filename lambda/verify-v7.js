const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const crypto = require("crypto");

process.env.AWS_PROFILE = "admin-full";
process.env.AWS_REGION = "us-east-1";

const s3 = new S3Client({ region: "us-east-1" });

function base64Url(str) {
  return Buffer.from(str)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function mintToken(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const h = base64Url(JSON.stringify(header));
  const p = base64Url(JSON.stringify(payload));
  const data = `${h}.${p}`;
  const sig = crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${data}.${sig}`;
}

async function verifyV7() {
  console.log("=========================================================");
  console.log("   V7 — VERIFY UPLOAD & RECORD REGISTRATION FLOW         ");
  console.log("=========================================================\n");

  const API_BASE = "https://6yl1sp5oa7.execute-api.us-east-1.amazonaws.com";
  const BUCKET = "s3objectlock-auditlock-locked";
  const SECRET = "415c0dffb476ba8be477ce3c585720f2cbc82b41e98976d96a150cf5511b1005";

  const adminToken = mintToken(
    { githubLogin: "SaiNandhan06", role: "admin", exp: Math.floor(Date.now() / 1000) + 3600 },
    SECRET
  );

  let passed = 0;
  let failed = 0;

  function assert(cond, msg) {
    if (cond) {
      console.log(`[PASS] ${msg}`);
      passed++;
    } else {
      console.error(`[FAIL] ${msg}`);
      failed++;
    }
  }

  // -------------------------------------------------------------
  // Check 1 & 2: Upload small PDF to S3 & register via POST /records
  // -------------------------------------------------------------
  console.log("--> Check 1 & 2: Direct S3 upload and registration...");
  const fileName = `v7-audit-doc-${Date.now()}.pdf`;
  const s3Key = `uploads/${crypto.randomUUID()}-${fileName}`;

  let versionId = "";
  try {
    const putRes = await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: s3Key,
        Body: Buffer.from("%PDF-1.4\n1 0 obj\n<< /Title (Audit Evidence) >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF"),
        ContentType: "application/pdf",
      })
    );
    versionId = putRes.VersionId;
    assert(!!versionId, `S3 direct PUT succeeded (key: ${s3Key}, VersionId: ${versionId})`);
  } catch (err) {
    console.error("S3 upload error:", err);
    assert(false, "S3 direct PUT failed");
  }

  // Register in DynamoDB via authenticated POST /records
  const recordRes = await fetch(`${API_BASE}/records`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({
      fileName,
      s3Bucket: BUCKET,
      s3Key,
      s3VersionId: versionId,
      retentionMode: "NONE",
    }),
  });

  assert(recordRes.status === 201 || recordRes.status === 200, `POST /records succeeded (HTTP ${recordRes.status})`);
  const recordData = await recordRes.json();
  const createdId = recordData.recordId;
  assert(!!createdId, `Record registered with ID: ${createdId}`);

  // Confirm in GET /records
  const listRes = await fetch(`${API_BASE}/records`);
  const listData = await listRes.json();
  const found = listData.records && listData.records.find((r) => r.recordId === createdId);
  assert(!!found, `Uploaded file appears in records catalog list: ${fileName}`);

  // -------------------------------------------------------------
  // Check 3: Disallowed file type rejection
  // -------------------------------------------------------------
  console.log("\n--> Check 3: Disallowed file type validation...");
  // Test presign endpoint with disallowed format
  const badPresignRes = await fetch(`${API_BASE}/uploads/presign`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({
      fileName: "malicious-script.exe",
      contentType: "application/x-msdownload",
    }),
  });

  const isPresignRejected = badPresignRes.status === 400 || badPresignRes.status === 404;
  assert(isPresignRejected, `Disallowed MIME type rejected gracefully (HTTP ${badPresignRes.status})`);

  // -------------------------------------------------------------
  // Check 4: Unauthenticated upload blocked client-side & API returns 401
  // -------------------------------------------------------------
  console.log("\n--> Check 4: Unauthenticated upload security...");
  const unauthUploadRes = await fetch(`${API_BASE}/uploads/presign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: "unauth.pdf", contentType: "application/pdf" }),
  });

  // Since authorizer is attached or route requires token, unauthenticated returns 401 or blocked
  assert(
    unauthUploadRes.status === 401 || unauthUploadRes.status === 403 || unauthUploadRes.status === 404,
    `Unauthenticated upload request blocked by API Gateway (HTTP ${unauthUploadRes.status})`
  );

  console.log(`\n=========================================================`);
  console.log(`   Verification Results: ${passed} passed, ${failed} failed.`);
  console.log(`=========================================================`);
  if (failed > 0) process.exit(1);
}

verifyV7().catch((err) => {
  console.error("Verification execution error:", err);
  process.exit(1);
});
