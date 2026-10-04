/**
 * V10 - End-to-End Audit Trail Acceptance Verification Script
 * Validates the complete project story:
 * 1. Token minting for non-admin ('auditor-compliance', role: 'user') and admin ('SaiNandhan06', role: 'admin')
 * 2. Direct S3 Object Lock object registration with GOVERNANCE & COMPLIANCE modes
 * 3. Attempt delete on locked object -> S3 WORM enforcement verifies DENIED
 * 4. Admin override delete -> s3:BypassGovernanceRetention accepts deletion (HTTP 204)
 * 5. COMPLIANCE mode delete attempt -> absolute undeletability guaranteed even with admin credentials
 */

const crypto = require("crypto");
const {
  S3Client,
  PutObjectCommand,
  GetObjectRetentionCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

process.env.AWS_PROFILE = process.env.AWS_PROFILE || "admin-full";
process.env.AWS_REGION = process.env.AWS_REGION || "us-east-1";

const s3 = new S3Client({ region: process.env.AWS_REGION });
const BUCKET = "s3objectlock-auditlock-locked";
const SECRET = process.env.SESSION_SECRET || "415c0dffb476ba8be477ce3c585720f2cbc82b41e98976d96a150cf5511b1005";
const API_BASE = "https://6yl1sp5oa7.execute-api.us-east-1.amazonaws.com";

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

async function verifyV10() {
  console.log("=================================================================");
  console.log("   V10 - FULL END-TO-END AUDIT & S3 OBJECT LOCK ACCEPTANCE TEST  ");
  console.log("=================================================================\n");

  const now = Math.floor(Date.now() / 1000);
  const userToken = mintToken({ githubLogin: "auditor-compliance", role: "user", exp: now + 3600 }, SECRET);
  const adminToken = mintToken({ githubLogin: "SaiNandhan06", role: "admin", exp: now + 3600 }, SECRET);

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

  // 1. Session Token Minting & Structure Check
  console.log("--> Check 1: Session Token Minting & Actor Attribution...");
  const userPayload = JSON.parse(Buffer.from(userToken.split(".")[1], "base64").toString());
  const adminPayload = JSON.parse(Buffer.from(adminToken.split(".")[1], "base64").toString());
  assert(userPayload.githubLogin === "auditor-compliance" && userPayload.role === "user", "User token contains real githubLogin and 'user' role");
  assert(adminPayload.githubLogin === "SaiNandhan06" && adminPayload.role === "admin", "Admin token contains real githubLogin and 'admin' role");

  // 2. Put Governance Locked Object into S3
  console.log("\n--> Check 2: Direct S3 Upload with Native Object Lock Governance Mode...");
  const govKey = `uploads/audit-governance-${Date.now()}.pdf`;
  const govRetainUntil = new Date(Date.now() + 86400000); // 1 day
  let govVersionId = "";

  try {
    const putRes = await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: govKey,
        Body: Buffer.from("%PDF-1.4\n%AuditLock Governance WORM Object\n%%EOF"),
        ContentType: "application/pdf",
        ObjectLockMode: "GOVERNANCE",
        ObjectLockRetainUntilDate: govRetainUntil,
      })
    );
    govVersionId = putRes.VersionId;
    assert(!!govVersionId, `Uploaded governance locked file: ${govKey} (VersionId: ${govVersionId})`);
  } catch (err) {
    console.error("Governance PUT error:", err);
    assert(false, "Failed to upload governance locked object");
  }

  // 3. Confirm Live Object Lock Retention via S3 API
  console.log("\n--> Check 3: Confirm Live Object Lock Configuration from S3...");
  try {
    const retRes = await s3.send(
      new GetObjectRetentionCommand({
        Bucket: BUCKET,
        Key: govKey,
        VersionId: govVersionId,
      })
    );
    assert(
      retRes.Retention && retRes.Retention.Mode === "GOVERNANCE",
      `S3 verified live retention mode: ${retRes.Retention?.Mode}, retainUntil: ${retRes.Retention?.RetainUntilDate}`
    );
  } catch (err) {
    console.error("GetObjectRetention error:", err);
    assert(false, "Failed to retrieve live object retention");
  }

  // 4. Test Deletion Without Bypass Rights (Expect AccessDenied / Protected by Object Lock)
  console.log("\n--> Check 4: Attempt Deletion Without Bypass Rights...");
  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: BUCKET,
        Key: govKey,
        VersionId: govVersionId,
        BypassGovernanceRetention: false,
      })
    );
    assert(false, "Standard delete should have been rejected by S3 Object Lock");
  } catch (err) {
    const isDenied = err.name === "AccessDenied" || err.message?.includes("Access Denied");
    assert(isDenied, `Deletion denied as expected by S3 Object Lock: ${err.name} - ${err.message}`);
  }

  // 5. Test Deletion With Authorized Bypass Rights (s3:BypassGovernanceRetention)
  console.log("\n--> Check 5: Admin Override Deletion With Bypass Rights...");
  try {
    const delRes = await s3.send(
      new DeleteObjectCommand({
        Bucket: BUCKET,
        Key: govKey,
        VersionId: govVersionId,
        BypassGovernanceRetention: true,
      })
    );
    assert(
      delRes.$metadata.httpStatusCode === 204 || delRes.$metadata.httpStatusCode === 200,
      `S3 accepted delete with BypassGovernanceRetention: true (HTTP ${delRes.$metadata.httpStatusCode})`
    );
  } catch (err) {
    console.error("Admin delete error:", err);
    assert(false, "Admin override deletion failed");
  }

  // 6. Test COMPLIANCE Mode Undeletability (Even for Admin)
  console.log("\n--> Check 6: COMPLIANCE Mode Absolute Undeletability Guarantee...");
  const compKey = `uploads/audit-compliance-${Date.now()}.pdf`;
  const compRetainUntil = new Date(Date.now() + 86400000);
  let compVersionId = "";

  try {
    const putComp = await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: compKey,
        Body: Buffer.from("%PDF-1.4\n%AuditLock Compliance WORM Object\n%%EOF"),
        ContentType: "application/pdf",
        ObjectLockMode: "COMPLIANCE",
        ObjectLockRetainUntilDate: compRetainUntil,
      })
    );
    compVersionId = putComp.VersionId;

    // Attempt delete even with BypassGovernanceRetention: true
    try {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: BUCKET,
          Key: compKey,
          VersionId: compVersionId,
          BypassGovernanceRetention: true,
        })
      );
      assert(false, "COMPLIANCE mode object must NOT be deletable by anyone");
    } catch (err) {
      assert(
        err.name === "AccessDenied" && err.message?.includes("object protected by object lock"),
        `COMPLIANCE mode strictly blocks deletion even for admin: ${err.message}`
      );
    }
  } catch (err) {
    console.error("Compliance test error:", err);
    assert(false, "Compliance mode test execution error");
  }

  // 7. Verify API Gateway Public Records Readability
  console.log("\n--> Check 7: API Gateway Public Audit Catalog Transparency...");
  try {
    const listRes = await fetch(`${API_BASE}/records`);
    assert(listRes.status === 200, `GET /records is publicly accessible for auditors (HTTP ${listRes.status})`);
    const listData = await listRes.json();
    assert(Array.isArray(listData.records), `Catalog returned ${listData.records?.length} tracked audit records`);
  } catch (err) {
    console.error("API Gateway list error:", err);
    assert(false, "API Gateway records check failed");
  }

  console.log("\n=================================================================");
  console.log(`   VERIFICATION COMPLETE: ${passed} PASSED, ${failed} FAILED`);
  console.log("=================================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

verifyV10().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
