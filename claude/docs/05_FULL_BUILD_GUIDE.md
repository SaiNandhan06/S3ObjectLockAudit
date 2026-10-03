# S3 Object Lock + Dashboard API — Full Console Build Guide
**One-stop, step-by-step, console-based. Follow top to bottom.**

This merges everything into one document: the AWS infrastructure (budget alert, buckets, Object Lock, IAM, Legal Hold), the backend API (Lambda + API Gateway + DynamoDB), and how to pull your CloudTrail evidence at the end. Expected total cost for the whole build: a few cents.

---

## ⚠️ Before you start

One step in this project (Compliance-mode locking) is permanent and cannot be undone by anyone, including AWS root, until its timer expires. We never actually use that mode in this guide's hands-on steps — everything here uses **Governance mode**, which an authorized user can override. Keep retention periods short (minutes) throughout. If you ever add a Compliance-mode step later, treat it as a separate, deliberate, one-time action — never a default.

---

## Part 1 — Safety setup

### 1.1 Create a $5 budget alert
1. Search bar → **Budgets** → Create budget → **Customize (advanced)** → Budget type: **Cost budget**.
2. Name it, Period: Monthly, Renewal: Recurring, Method: Fixed, Amount: **5**.
3. Budget scope: **All AWS services**.
4. Add an alert threshold at 80% (of $5), enter your email.
5. Review → **Create budget**.

### 1.2 CloudTrail — use the free built-in option
CloudTrail already runs in the background on every AWS account for free, keeping 90 days of account activity ("management events") with **no setup required**. That's all this project needs — don't create a paid custom Trail (it would spin up a second S3 bucket for log storage that bills forever unless you remember to delete it).

To confirm it's there: search **CloudTrail** → **Event history** (left menu). You'll already see activity. You'll come back here at the end to pull evidence.

### 1.3 Decide your test retention period
Write this down, don't skip it: use **short test retentions (a few minutes)** throughout this guide. The real production figure (commonly 7 years for audit records) only ever belongs in a written policy document — never actually applied during testing.

---

## Part 2 — S3 buckets

### 2.1 Plain bucket (no Object Lock) — practice first
1. Search **S3** → **General purpose buckets** → **Create bucket**.
2. Name: `yourname-auditlock-plain-dev` (must be globally unique — bucket names can never be changed later, so get it right now).
3. Leave Object Ownership and Block Public Access on their defaults.
4. **Bucket Versioning → Enable.**
5. Leave Object Lock disabled on this one.
6. Create bucket. Try uploading a test file, overwriting it, and toggling "Show versions" to confirm the old version is still there.

### 2.2 Object-Lock bucket — the real one
**This bucket creation is safe by itself.** Turning on the Object Lock *capability* is permanent, but it doesn't lock anything until you apply retention to a specific object later.

1. Create bucket again. Name: `yourname-auditlock-locked-dev`. Same region.
2. Same ownership/public-access defaults.
3. **Bucket Versioning → Enable** (hard requirement for Object Lock).
4. Under **Advanced settings**, find **Object Lock → Enable**. Read and check the permanence acknowledgment.
5. Create bucket.

**Do not** configure a bucket-level default retention. Apply retention per-object instead, deliberately, each time — that way nothing locks automatically just because you uploaded something.

### 2.3 Lock one test file and prove denial
1. Upload a small `.txt` file to the Object-Lock bucket.
2. Open the file → find the **"Object lock legal hold and retention"** section → Edit.
3. Turn Retention on, choose **Governance** mode, set "Retain until" ~10–15 minutes from now.
   - If the console only offers a date (not a time), use **CloudShell** (the `>_` icon in the console's top bar) instead:
     ```
     aws s3api put-object-retention --bucket yourname-auditlock-locked-dev --key YOUR-FILE \
       --retention '{"Mode":"GOVERNANCE","RetainUntilDate":"2026-10-03T15:30:00Z"}'
     ```
4. Save. **This is the real, irreversible-until-expiry moment** — expected and fine for one small test file.
5. Select the file → Delete. Confirm AWS refuses it. Screenshot the error — this is your first piece of evidence.

---

## Part 3 — IAM: a limited user and a privileged user

1. Search **IAM** → **Users** → **Create user** → name `regular-uploader`. Skip console access. Attach a custom policy granting only `s3:PutObject`, `s3:GetObject`, `s3:ListBucket`, `s3:DeleteObject`, scoped to the Object-Lock bucket's ARN. **Deliberately exclude** `s3:BypassGovernanceRetention` and `s3:GetBucketObjectLockConfiguration`.
2. Create user again, name `admin-full`. Attach the AWS-managed policy **AmazonS3FullAccess** (covers everything, including bypass).
3. For each user → **Security credentials** tab → **Create access key** → choose **Command Line Interface (CLI)** → save both keys somewhere safe.
4. In CloudShell:
   ```
   aws configure --profile regular-uploader
   aws configure --profile admin-full
   ```
   (paste each user's keys when prompted)

### Prove the contrast
```
aws s3api list-object-versions --bucket yourname-auditlock-locked-dev --prefix YOUR-FILE --profile admin-full
# copy the VersionId

# expect FAIL
aws s3api delete-object --bucket yourname-auditlock-locked-dev --key YOUR-FILE --version-id VERSION_ID --profile regular-uploader

# expect SUCCEED
aws s3api delete-object --bucket yourname-auditlock-locked-dev --key YOUR-FILE --version-id VERSION_ID --profile admin-full
```
Save the full terminal output of both — this contrast is your strongest single piece of evidence.

---

## Part 4 — Legal Hold (prove it's independent of retention)

1. Upload a new object, apply a short (2–3 min) Governance retention to it, then:
   ```
   aws s3api put-object-legal-hold --bucket yourname-auditlock-locked-dev --key YOUR-FILE2 --legal-hold Status=ON --profile admin-full
   ```
2. **Wait until the retention time has genuinely passed.** Then try deleting it — even with `admin-full`. It should **still fail**, because a Legal Hold has no bypass at all, unlike Governance retention. (Testing this while retention is still active proves nothing — the wait matters.)
3. Remove the hold:
   ```
   aws s3api put-object-legal-hold --bucket yourname-auditlock-locked-dev --key YOUR-FILE2 --legal-hold Status=OFF --profile admin-full
   ```
4. Delete again — now it should succeed.

---

## Part 5 — Dashboard backend: DynamoDB + Lambda + API Gateway

### 5.1 DynamoDB tables
1. Search **DynamoDB** → **Tables** → **Create table**. Name: `AuditRecords`. Partition key: `recordId` (String). Leave on-demand capacity (pay-per-request, no idle cost).
2. Create table again. Name: `RetentionEvents`. Partition key: `recordId` (String), Sort key: `eventId` (String).

**Why two tables:** `AuditRecords` is one row per file (its bucket/key/version/retention state). `RetentionEvents` is an append-only log — every lock, delete attempt (denied *and* allowed), and hold change gets its own row, keyed by which record it belongs to.

### 5.2 Two Lambda execution roles
IAM → Roles → Create role → trusted entity: **Lambda**.
- `lambda-dashboard-role`: `dynamodb:GetItem`, `PutItem`, `Query`, `Scan` on both tables; `s3:GetObjectRetention`, `GetObjectLegalHold`, `PutObject` on the Object-Lock bucket. No delete, no bypass.
- `lambda-delete-admin-role`: same, plus `s3:DeleteObject`, `s3:BypassGovernanceRetention`, `s3:GetBucketObjectLockConfiguration` on that bucket.

Attach `AWSLambdaBasicExecutionRole` (AWS-managed) to both, so each function's logs reach CloudWatch.

### 5.3 The four Lambda functions

For each: Lambda → **Create function** → Author from scratch → Runtime **Node.js 20.x** → paste the code below into the inline editor → set its environment variables → attach the right execution role.

> The AWS SDK v3 (`@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `@aws-sdk/client-s3`) comes pre-installed in this runtime — nothing to `npm install`.

#### Function 1 — `create-record`
Registers a file's metadata and writes the first log entry. Role: `lambda-dashboard-role`. Env vars: `RECORDS_TABLE=AuditRecords`, `EVENTS_TABLE=RetentionEvents`.

```javascript
// POST /records
// Body: { fileName, s3Bucket, s3Key, s3VersionId, retentionMode, retentionUntil, isDemoObject }
// Assumes the file is already uploaded to S3 — this just registers it.

const { randomUUID } = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);

const RECORDS_TABLE = process.env.RECORDS_TABLE;
const EVENTS_TABLE = process.env.EVENTS_TABLE;

// Reusable pattern for "the DynamoDB logs storage part" — call this every
// time something retention-relevant happens. Success and failure both
// get logged the same way.
async function logEvent(recordId, eventType, actor, outcome, detail) {
  const eventId = `${new Date().toISOString()}#${randomUUID().slice(0, 8)}`;
  await ddb.send(new PutCommand({
    TableName: EVENTS_TABLE,
    Item: { recordId, eventId, eventType, actor, outcome, detail: detail || "", occurredAt: new Date().toISOString() },
  }));
}

exports.handler = async (event) => {
  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) {
    return { statusCode: 400, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: { message: "Invalid JSON body" } }) };
  }

  const { fileName, s3Bucket, s3Key, s3VersionId, retentionMode, retentionUntil, isDemoObject } = body;
  if (!fileName || !s3Bucket || !s3Key || !s3VersionId) {
    return { statusCode: 400, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: { message: "fileName, s3Bucket, s3Key, s3VersionId are required" } }) };
  }

  const recordId = randomUUID();
  const record = {
    recordId, fileName, s3Bucket, s3Key, s3VersionId,
    uploadDate: new Date().toISOString(),
    retentionMode: retentionMode || "NONE",
    retentionUntil: retentionUntil || null,
    legalHold: false,
    isDemoObject: !!isDemoObject,
  };

  try {
    await ddb.send(new PutCommand({ TableName: RECORDS_TABLE, Item: record }));
    await logEvent(recordId, "RECORD_CREATED", "system", "ALLOWED",
      `Registered ${s3Key} in ${s3Bucket} (mode=${record.retentionMode})`);
    return { statusCode: 201, headers: { "Content-Type": "application/json" }, body: JSON.stringify(record) };
  } catch (err) {
    console.error("create-record failed", err);
    return { statusCode: 500, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: { message: "Failed to create record" } }) };
  }
};
```

#### Function 2 — `list-records`
Powers the dashboard's main list. Role: `lambda-dashboard-role`. Env vars: `RECORDS_TABLE=AuditRecords`.

```javascript
// GET /records

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand } = require("@aws-sdk/lib-dynamodb");

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);
const RECORDS_TABLE = process.env.RECORDS_TABLE;

exports.handler = async () => {
  try {
    // Scan is fine at this project's scale (a handful of test records).
    // At real scale, add a GSI (partition key "entityType"="RECORD",
    // sort key "uploadDate") and use Query instead.
    const result = await ddb.send(new ScanCommand({ TableName: RECORDS_TABLE }));

    const records = (result.Items || [])
      .map((item) => ({
        recordId: item.recordId,
        fileName: item.fileName,
        retentionMode: item.retentionMode,
        retentionUntil: item.retentionUntil || null,
        legalHold: !!item.legalHold,
        uploadDate: item.uploadDate,
        isDemoObject: !!item.isDemoObject,
      }))
      .sort((a, b) => (a.uploadDate < b.uploadDate ? 1 : -1));

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ records }) };
  } catch (err) {
    console.error("list-records failed", err);
    return { statusCode: 500, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: { message: "Failed to list records" } }) };
  }
};
```

#### Function 3 — `get-record-detail`
One record + its full log + a **live** S3 check (never trusts DynamoDB alone). Role: `lambda-dashboard-role`. Env vars: `RECORDS_TABLE=AuditRecords`, `EVENTS_TABLE=RetentionEvents`.

```javascript
// GET /records/{id}

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, GetObjectRetentionCommand, GetObjectLegalHoldCommand } = require("@aws-sdk/client-s3");

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);
const s3 = new S3Client({});

const RECORDS_TABLE = process.env.RECORDS_TABLE;
const EVENTS_TABLE = process.env.EVENTS_TABLE;

exports.handler = async (event) => {
  const recordId = event.pathParameters && event.pathParameters.id;
  if (!recordId) {
    return { statusCode: 400, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: { message: "Missing record id in path" } }) };
  }

  try {
    const recordResult = await ddb.send(new GetCommand({ TableName: RECORDS_TABLE, Key: { recordId } }));
    const record = recordResult.Item;
    if (!record) {
      return { statusCode: 404, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: { message: "Record not found" } }) };
    }

    // S3 is the source of truth for live lock status, not DynamoDB —
    // something could have changed directly via CLI/console since this
    // record was written.
    let liveRetention = null;
    try {
      const r = await s3.send(new GetObjectRetentionCommand({
        Bucket: record.s3Bucket, Key: record.s3Key, VersionId: record.s3VersionId }));
      liveRetention = r.Retention || null;
    } catch (e) { liveRetention = null; }

    let liveLegalHold = "OFF";
    try {
      const h = await s3.send(new GetObjectLegalHoldCommand({
        Bucket: record.s3Bucket, Key: record.s3Key, VersionId: record.s3VersionId }));
      liveLegalHold = h.LegalHold ? h.LegalHold.Status : "OFF";
    } catch (e) { liveLegalHold = "OFF"; }

    const eventsResult = await ddb.send(new QueryCommand({
      TableName: EVENTS_TABLE,
      KeyConditionExpression: "recordId = :rid",
      ExpressionAttributeValues: { ":rid": recordId },
      ScanIndexForward: true,
    }));

    return {
      statusCode: 200, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        record,
        liveStatus: {
          mode: liveRetention ? liveRetention.Mode : "NONE",
          retainUntilDate: liveRetention ? liveRetention.RetainUntilDate : null,
          legalHold: liveLegalHold,
        },
        events: eventsResult.Items || [],
      }),
    };
  } catch (err) {
    console.error("get-record-detail failed", err);
    return { statusCode: 500, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: { message: "Failed to load record" } }) };
  }
};
```

#### Function 4 — `delete-attempt` (deploy TWICE, see below)
```javascript
// POST /records/{id}/delete-attempt
// Deploy this as TWO separate Lambda functions with two different
// execution roles — that contrast IS your evidence:
//   delete-attempt-limited  -> lambda-dashboard-role      -> ATTEMPT_BYPASS="false" -> expect DELETE_DENIED
//   delete-attempt-admin    -> lambda-delete-admin-role   -> ATTEMPT_BYPASS="true"  -> expect BYPASS_USED

const { randomUUID } = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, DeleteObjectCommand } = require("@aws-sdk/client-s3");

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);
const s3 = new S3Client({});

const RECORDS_TABLE = process.env.RECORDS_TABLE;
const EVENTS_TABLE = process.env.EVENTS_TABLE;
const ATTEMPT_BYPASS = process.env.ATTEMPT_BYPASS === "true";

async function logEvent(recordId, eventType, actor, outcome, detail) {
  const eventId = `${new Date().toISOString()}#${randomUUID().slice(0, 8)}`;
  await ddb.send(new PutCommand({
    TableName: EVENTS_TABLE,
    Item: { recordId, eventId, eventType, actor, outcome, detail: detail || "", occurredAt: new Date().toISOString() },
  }));
}

exports.handler = async (event) => {
  const recordId = event.pathParameters && event.pathParameters.id;
  if (!recordId) {
    return { statusCode: 400, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: { message: "Missing record id in path" } }) };
  }

  const recordResult = await ddb.send(new GetCommand({ TableName: RECORDS_TABLE, Key: { recordId } }));
  const record = recordResult.Item;
  if (!record) {
    return { statusCode: 404, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: { message: "Record not found" } }) };
  }

  const actor = (event.requestContext && event.requestContext.authorizer &&
    event.requestContext.authorizer.principalId) || "api-caller";

  await logEvent(recordId, "DELETE_ATTEMPTED", actor, "PENDING", `bypassRequested=${ATTEMPT_BYPASS}`);

  try {
    await s3.send(new DeleteObjectCommand({
      Bucket: record.s3Bucket, Key: record.s3Key, VersionId: record.s3VersionId,
      BypassGovernanceRetention: ATTEMPT_BYPASS,
    }));

    await logEvent(recordId, ATTEMPT_BYPASS ? "BYPASS_USED" : "DELETE_SUCCEEDED", actor, "ALLOWED",
      "S3 accepted the delete request");

    return { statusCode: 200, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome: "DELETED", bypassUsed: ATTEMPT_BYPASS }) };
  } catch (err) {
    const requestId = err.$metadata ? err.$metadata.requestId : "n/a";
    const detail = `${err.name || "Error"}: ${err.message || ""} (requestId: ${requestId})`;
    await logEvent(recordId, "DELETE_DENIED", actor, "DENIED", detail);

    return { statusCode: 200, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome: "DENIED", reason: detail }) };
  }
};
```

### 5.4 Wire up API Gateway
1. Search **API Gateway** → **Create API** → **HTTP API** (cheaper and simpler than REST API here).
2. Add routes and attach each to its Lambda:

   | Route | Lambda |
   |---|---|
   | `POST /records` | `create-record` |
   | `GET /records` | `list-records` |
   | `GET /records/{id}` | `get-record-detail` |
   | `POST /records/{id}/delete-attempt` | `delete-attempt-limited` |
   | `POST /records/{id}/delete-attempt-admin` | `delete-attempt-admin` |

3. Auto-deploy to the `$default` stage — API Gateway gives you a public invoke URL immediately.

### 5.5 Test it end to end
1. `POST /records` with a file already sitting in your Object-Lock bucket — note the returned `recordId`.
2. `GET /records` — confirm it appears.
3. `GET /records/{id}` — confirm live S3 status and the `RECORD_CREATED` event show up.
4. `POST /records/{id}/delete-attempt` — expect `{"outcome":"DENIED", ...}`.
5. `POST /records/{id}/delete-attempt-admin` — expect `{"outcome":"DELETED", ...}`.
6. `GET /records/{id}` again (on a *different* locked+held test record) to see the full event timeline accumulate.

Test each Lambda individually first via the console's **Test** button before going through API Gateway — much faster to debug.

---

## Part 6 — Pulling your CloudTrail evidence

Search **CloudTrail** → **Event history**. Filter by **Event name** and search each in turn:

- `PutObjectRetention` — the lock being applied
- `DeleteObject` — **both** attempts: the denied one (look for `errorCode: AccessDenied` in the event detail) and the successful bypass one
- `PutObjectLegalHold` — the hold being applied and removed

Click any entry to see the full JSON — requester identity, timestamp, outcome. Match these against your DynamoDB `RetentionEvents` rows and your saved terminal/API output from Parts 3–5 so everything lines up into one consistent evidence trail.

---

## Part 7 — Cleanup

1. Confirm every test object's retention and any holds have expired/been removed.
2. Empty both S3 buckets (toggle "Show versions", select all, delete), then delete the buckets.
3. Delete the DynamoDB tables.
4. Delete the 5 Lambda functions and API Gateway API.
5. IAM → delete `regular-uploader` and `admin-full` users, and the two Lambda execution roles.
6. The budget alert can stay — it costs nothing to leave running.

---

## What you'll have proven, end to end

A file that's genuinely undeletable by an unauthorized caller, deletable by an authorized one, independently protected by Legal Hold even past its retention expiry — all backed by a working API, a DynamoDB audit trail, and CloudTrail evidence tying every action to a timestamp and an identity. That's the complete story this project exists to tell.
