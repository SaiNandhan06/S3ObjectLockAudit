# T045 — Infrastructure & IAM Guide
**Give this file to any agent working on T045's scope.**

> ⚠️ This is infrastructure work: Terraform/CDK + AWS CLI. There is no backend service and no UI in this document — that's T186 and T327. If a task here starts to look like writing a REST handler or a React component, stop; it belongs elsewhere.

---

## 1. Tooling

| Layer | Choice | Why |
|---|---|---|
| IaC | Terraform (or AWS CDK) | Bucket creation-time flags for Object Lock must be exactly right and reproducible — don't hand-click this more than once |
| Verification | AWS CLI | Every proof T045 needs (denial, bypass, hold) is a CLI call away — no application code required |
| Evidence | Plain timestamped text/JSON files under `docs/evidence/t045/` | T045 has no database; T186 owns that |

**A build-tooling reality worth knowing:** LocalStack's free tier does not reliably enforce real Object Lock semantics. Since the entire point of T045's work is that *AWS itself* refuses the delete, this must be built and verified against a real, budget-alarmed AWS sandbox account from Phase 2 onward. Phase 1 (the plain bucket) is fine to prototype locally if useful, but treat that as optional.

## 2. Repository layout (T045's slice)

```
audit-lock/
└── infra/
    ├── terraform/
    │   ├── budget-alert.tf        # Phase 0 — apply first, before any bucket
    │   ├── cloudtrail.tf          # Phase 0 — apply before Object Lock testing
    │   ├── plain-bucket.tf        # Phase 1
    │   ├── object-lock-bucket.tf  # Phase 2 — review before every apply, this one is not casual
    │   └── iam.tf                 # uploader / compliance-officer / governance-bypass-admin / app-service-role
    ├── scripts/
    │   ├── verify-governance-denial.sh
    │   ├── verify-bypass.sh
    │   ├── verify-legal-hold.sh
    │   └── teardown-sandbox.sh    # checks all retentions expired before deleting anything
    └── handoff.md                 # the published bucket names / role ARNs / trail ARN — keep current
```

## 3. Bucket configuration — the parts that must be exactly right

### 3.1 Plain bucket (Phase 1)
- Versioning: **Enabled**
- Object Lock: **not configured** (cannot be added later if you change your mind — this is fine here since it's meant to stay plain)

### 3.2 Object-Lock bucket (Phase 2)
- Object Lock **must** be enabled via the bucket-creation call/resource itself (e.g. Terraform `aws_s3_bucket` with `object_lock_enabled = true` at creation, or the CLI's `--object-lock-enabled-for-bucket` flag on `create-bucket`). There is no separate "enable later" API — if you create the bucket without this flag, you must create a new bucket.
- Versioning: **Enabled** (hard AWS prerequisite for Object Lock).
- Default retention (`aws_s3_bucket_object_lock_configuration` or `put-object-lock-configuration`): `Mode = GOVERNANCE`, `Days` or `Years` set to your short test duration — express it as the smallest unit that gets you close to your agreed test period (e.g. use a `Days: 1` config with a script that deletes early via CLI for true minute-level testing, since S3's native default-retention config is day-granularity; per-object overrides via `put-object-retention` at upload time support exact timestamps and are the more precise tool for short test windows).
- **Never** set `Mode = COMPLIANCE` on the bucket default. Compliance mode is only ever applied per-object, and only by T327, on the `demo/` prefix.

## 4. IAM roles — exact permissions (original design) vs. what was actually built

| Role | Permissions | Notes |
|---|---|---|
| `uploader` | `s3:PutObject`, `s3:GetObject`, `s3:ListBucket` on both bucket ARNs | handed to T186 for the upload API's execution context |
| `compliance-officer` | above + `s3:GetObjectRetention`, `s3:GetObjectLegalHold`, `s3:PutObjectLegalHold` on the Object-Lock bucket ARN | handed to T186 (hold endpoints) and T327 (dashboard reads) |
| `governance-bypass-admin` | above + `s3:BypassGovernanceRetention` on the Object-Lock bucket ARN **only** | used for T045's own bypass proof, and later by T327 for Phase 4's differentiated delete-attempt tests |
| `app-service-role` | least-privilege union of the above, scoped to both bucket ARNs by resource | the runtime role T186's backend actually assumes |

**What was actually built for the solo learning pass:** two IAM **users** instead of four roles — `regular-uploader` (scoped `PutObject`/`GetObject`/`ListBucket`/`DeleteObject` on the Object-Lock bucket ARN, deliberately missing `BypassGovernanceRetention` and `GetBucketObjectLockConfiguration`) and `admin-full` (`AmazonS3FullAccess` managed policy, which covers bypass and hold management since it's `s3:*`). This proved every required behavior correctly; splitting `admin-full` back into the three finer-grained roles above is the natural next step if this moves toward a production-style setup, since `AmazonS3FullAccess` is far broader than any of them individually need.

Every policy should name the specific bucket ARN(s), never `*`, once you do split it out. None of these roles need `cloudtrail:*` — CloudTrail is read-only evidence, not something T045's roles need to write to.

**Console note worth knowing:** the S3 console automatically attempts a bypass delete on every delete action — there's no separate "bypass" checkbox. Whether it succeeds depends purely on the caller's IAM permissions. For a console (not CLI) bypass to succeed, the caller needs **both** `s3:BypassGovernanceRetention` and `s3:GetBucketObjectLockConfiguration` — the CLI only strictly requires the former, plus the explicit `--bypass-governance-retention` flag.

## 5. Verification flows — CLI-level, no application code needed

### 5.1 Prove the bucket default applied correctly
```
aws s3api put-object --bucket <lock-bucket> --key test/governance-check.txt --body test.txt
aws s3api get-object-retention --bucket <lock-bucket> --key test/governance-check.txt
```
Confirm the returned mode and retain-until match what you configured. Capture this output.

### 5.2 Prove denial (the core piece of evidence)
```
aws s3api delete-object --bucket <lock-bucket> --key test/governance-check.txt --version-id <id>
```
Expect an `AccessDenied` error referencing Object Lock. **This failure is the desired, correct result — capture it in full**, including the request ID.

### 5.3 Prove the bypass, and prove it's restricted
```
# with governance-bypass-admin credentials — expect success
aws s3api delete-object --bucket <lock-bucket> --key test/governance-check.txt --version-id <id> --bypass-governance-retention

# with uploader credentials on an equivalent object — expect AccessDenied
aws s3api delete-object --bucket <lock-bucket> --key test/bypass-negative-check.txt --version-id <id> --bypass-governance-retention
```
Capture both outcomes side by side — the contrast between them *is* the evidence.

### 5.4 Prove Legal Hold overrides even expired retention
```
aws s3api put-object-legal-hold --bucket <lock-bucket> --key test/hold-check.txt --legal-hold Status=ON
# wait until this object's retention period has actually expired, then:
aws s3api delete-object --bucket <lock-bucket> --key test/hold-check.txt --version-id <id>
# expect AccessDenied — retention expired, but the hold is independent and still active
aws s3api put-object-legal-hold --bucket <lock-bucket> --key test/hold-check.txt --legal-hold Status=OFF
aws s3api delete-object --bucket <lock-bucket> --key test/hold-check.txt --version-id <id>
# now expect success
```
This is the one test that's easy to skip by accident (testing the hold only while retention is still active proves nothing about independence) — don't skip it.

### 5.5 Confirm CloudTrail captured all of the above
```
aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=PutObjectRetention
aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=DeleteObject
aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=PutObjectLegalHold
```
Cross-check event timestamps and request IDs against your captured CLI evidence from 5.1–5.4. (Equivalently, the console's CloudTrail → **Event history** screen with an "Event name" filter shows the same data without needing the CLI — that's the path actually used for this build, since no dedicated Trail was created; see §1's tooling note.)

### 5.6 Confirm the bucket default is still Governance before handing off to T327
```
aws s3api get-object-lock-configuration --bucket <lock-bucket>
```
Confirm `Rule.DefaultRetention.Mode = GOVERNANCE`. This is your Phase 4 handoff gate — T327 should never inherit a bucket whose default silently drifted to Compliance.

## 6. Handoff document — keep this current

`infra/handoff.md` should always contain, as of the latest apply:

```
PLAIN_BUCKET_NAME        = ...
LOCK_BUCKET_NAME         = ...
DEFAULT_RETENTION_MODE   = GOVERNANCE
DEFAULT_RETENTION_TEST_DURATION = ...
UPLOADER_ROLE_ARN        = ...
COMPLIANCE_OFFICER_ROLE_ARN = ...
GOVERNANCE_BYPASS_ADMIN_ROLE_ARN = ...
APP_SERVICE_ROLE_ARN     = ...
CLOUDTRAIL_TRAIL_ARN     = ...
```
Treat a stale value here as a shipped bug — T186 or T327 will silently build against the wrong resource.

## 7. Instructions for agents working this scope

1. Read `01_PROJECT_OVERVIEW.md` and this file first.
2. Everything you do here is Terraform/CDK + AWS CLI. If you find yourself writing a Lambda handler, an Express route, or a React component, stop — that's T186 or T327's document, not this one.
3. Never set the Object-Lock bucket's default mode to Compliance. Never write IaC that does this, even as an example or a commented-out option.
4. Every verification command's output gets saved under `docs/evidence/t045/`, not just run-and-discard.
5. Update `infra/handoff.md` the same day any bucket name or role ARN changes.
6. Update the status table in `01_PROJECT_OVERVIEW.md` §8 at the end of your task.
7. End every task with a short report: what was applied, what CLI evidence was captured, and what's still needed from a real AWS sandbox account versus what could be reviewed from the Terraform plan alone.
