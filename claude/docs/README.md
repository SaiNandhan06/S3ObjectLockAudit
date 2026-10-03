# S3 Object Lock for Write-Once Audit Records
**A working demonstration that a stored record can be made genuinely undeletable — enforced by AWS itself, not by application code — while still supporting an authorized override and an independent legal hold.**

---

## 1. Problem statement

Financial and audit records often must be kept provably tamper-proof for a defined retention period (commonly 7 years for financial/audit compliance). Storing the file isn't enough — an auditor needs evidence that **no one**, including the organization's own administrators, could have quietly altered or deleted it during that window.

This project proves that guarantee using **Amazon S3 Object Lock**: once a record is locked, S3 itself refuses to delete or overwrite it until the lock expires. The system around it tracks that state, logs every attempt (denied or allowed) to an audit trail, and gives authenticated users a dashboard to see it all.

## 2. What it actually demonstrates

- A locked file **cannot** be deleted by a normal caller — S3 refuses it, not the application.
- An **authorized** caller can override a Governance-mode lock early — logged, never silent.
- A **Legal Hold** blocks deletion independently of retention — proven by holding an object *past* its own retention expiry and showing deletion is still denied.
- Every one of those events is captured twice: once in a DynamoDB audit trail the dashboard reads, and once in AWS CloudTrail as independent, tamper-evident confirmation.
- Real people log in with **GitHub OAuth**; only an allow-listed admin account can perform the override.

## 3. Architecture

```
                 ┌─────────────────────────┐
  Browser  ───►  │  Static frontend (S3 +  │
                 │  CloudFront, HTTPS)     │
                 └───────────┬─────────────┘
                             │  Authorization: Bearer <session token>
                 ┌───────────▼─────────────┐
                 │   API Gateway (HTTP API) │
                 │   auditlock-dashboard-api│
                 │   + Lambda authorizer    │
                 └───────────┬─────────────┘
          ┌──────────────────┼───────────────────────┬────────────────┐
          │                  │                        │                │
   ┌──────▼──────┐   ┌───────▼────────┐      ┌────────▼───────┐ ┌──────▼───────┐
   │ create-record│   │ list-records   │      │ get-record-     │ │ delete-attempt│
   │ presign-upload│  │                │      │ detail          │ │ (limited/admin)│
   └──────┬───────┘   └───────┬────────┘      └────────┬────────┘ └──────┬───────┘
          │                   │                        │                 │
          └─────────┬─────────┴────────────┬───────────┘                 │
                     │                      │                             │
             ┌───────▼────────┐    ┌────────▼─────────┐          ┌───────▼────────┐
             │  AuditRecords  │    │ RetentionEvents   │          │  S3 bucket:     │
             │  (DynamoDB)    │    │  (DynamoDB,       │◄─────────┤ s3objectlock-   │
             │  metadata      │    │  append-only log) │          │ auditlock-locked│
             └────────────────┘    └───────────────────┘          │ (Object Lock +  │
                                                                     │  Versioning)    │
                                                                     └────────┬────────┘
                                                                              │
                                                                     ┌────────▼────────┐
                                                                     │   CloudTrail     │
                                                                     │  Event history   │
                                                                     │ (independent      │
                                                                     │  evidence)        │
                                                                     └──────────────────┘

   GitHub OAuth: browser → github.com → github-oauth-callback (exchanges
   code, fetches GitHub profile, mints a signed session token) → browser
   stores the token and sends it as a Bearer header on every API call.
```

## 4. Services used, and why each one

| Service | Role in this project | Why this one |
|---|---|---|
| **Amazon S3 (Object Lock)** | Stores the records; enforces WORM behavior | The actual mechanism the whole project proves — S3 denies the delete, not our code |
| **Amazon S3 (static site) + CloudFront** | Hosts the frontend | Free-tier-friendly, HTTPS without running a server |
| **AWS Lambda** | All backend logic — metadata, presigned uploads, delete attempts, OAuth, authorization | Pay-per-invocation, zero idle cost |
| **Amazon API Gateway (HTTP API)** | Routes HTTP requests to the right Lambda | Cheaper than REST API; HTTP API fits a project with no need for usage-plan API keys |
| **Amazon DynamoDB** | `AuditRecords` (metadata) and `RetentionEvents` (append-only audit log) | On-demand pricing — no idle cost, scales to zero |
| **AWS IAM** | Two Lambda execution roles (`lambda-dashboard-role`, `lambda-delete-admin-role`) that create the actual privilege separation; two standalone IAM users for direct CLI proof | The real enforcement boundary for the bypass demonstration |
| **AWS CloudTrail (Event history)** | Independent, tamper-evident confirmation of every lock/delete/hold action | Free, always-on — no custom Trail needed at this scale |
| **AWS Budgets** | Cost guardrail | Alerts before spend becomes a surprise |
| **GitHub OAuth** | Authenticates real dashboard users | Simple, free identity provider; no user database to manage |

## 5. Deployed environment

| Item | Value |
|---|---|
| Region | `us-east-1` |
| Object-Lock bucket | `s3objectlock-auditlock-locked` (Object Lock + Versioning enabled) |
| DynamoDB tables | `AuditRecords` (PK `recordId`), `RetentionEvents` (PK `recordId`, SK `eventId`) |
| API base URL | `https://6yl1sp5oa7.execute-api.us-east-1.amazonaws.com` |
| Lambda execution roles | `lambda-dashboard-role` (read/write DynamoDB, read/write S3, no bypass), `lambda-delete-admin-role` (adds `s3:DeleteObject`, `s3:DeleteObjectVersion`, `s3:BypassGovernanceRetention`) |
| CLI test identities | IAM users `regular-uploader` and `admin-full` — used for direct CLI proof only, not part of the dashboard's authentication |
| Frontend URL | _fill in once Part C of `06_FRONTEND_AUTH_BUILD_PROMPTS.md` is deployed_ |

## 6. API reference

Base URL above. Routes marked 🔒 require `Authorization: Bearer <session token>` once auth is wired up (see `06_FRONTEND_AUTH_BUILD_PROMPTS.md`); until then they're open.

| Method | Route | Lambda | Purpose |
|---|---|---|---|
| POST 🔒 | `/uploads/presign` | `create-presigned-upload` | Get a short-lived S3 upload URL |
| POST 🔒 | `/records` | `create-record` | Register a file's metadata, log `RECORD_CREATED` |
| GET | `/records` | `list-records` | Dashboard list view |
| GET | `/records/{id}` | `get-record-detail` | Record + live S3 status + full event timeline |
| POST 🔒 | `/records/{id}/delete-attempt` | `delete-attempt-limited` | Attempt delete with no bypass rights — expect `DENIED` while locked |
| POST 🔒 | `/records/{id}/delete-attempt-admin` | `delete-attempt-admin` | Attempt delete with bypass rights — expect `DELETED`, admin-role only |
| GET | `/auth/callback` | `github-oauth-callback` | GitHub OAuth redirect target — not called directly |

**Example — register a record:**
```json
POST /records
{
  "fileName": "document.pdf",
  "s3Bucket": "s3objectlock-auditlock-locked",
  "s3Key": "document.pdf",
  "s3VersionId": "<S3_VERSION_ID>",
  "retentionMode": "GOVERNANCE",
  "retentionUntil": "2026-10-10T00:00:00Z",
  "isDemoObject": true
}
```
**Example — a denied delete:**
```json
{ "outcome": "DENIED", "reason": "AccessDenied: Access Denied because object protected by object lock. (requestId: ...)" }
```

## 7. Features

- ✅ Object Lock in Governance mode, applied per-object (never a silent bucket-wide default)
- ✅ Authorized bypass, proven via a separate privileged execution role
- ✅ Legal Hold, proven independent of retention (blocks deletion even after retention expires)
- ✅ Append-only DynamoDB audit log for every retention-relevant action, success and failure alike
- ✅ Live reconciliation against S3 on every record view — the dashboard never trusts a stale cached status
- ✅ CloudTrail Event history as an independent, second source of evidence
- ⬜ Presigned-upload frontend flow (prompts ready — see `06_FRONTEND_AUTH_BUILD_PROMPTS.md`)
- ⬜ GitHub OAuth login with role-based access (admin vs. regular user) (prompts ready)
- ⬜ Server-side role enforcement on the admin override endpoint, not just a hidden UI button (prompts ready)

## 8. Plan and approach

This was built in two phases:

1. **Infrastructure and backend proof (done):** AWS Console + CLI, console-first so every AWS concept was learned hands-on rather than abstracted behind IaC. Budget alert → plain bucket → Object-Lock bucket → IAM contrast testing → Legal Hold → DynamoDB + Lambda + API Gateway dashboard backend.
2. **Frontend and authentication (in progress):** a static, framework-free frontend with GitHub OAuth, a custom Lambda authorizer (since GitHub doesn't issue the OIDC token API Gateway's native JWT authorizer expects), and server-side role enforcement so the admin override can never be reached by hiding/unhiding a UI button alone.

Cost discipline throughout: on-demand DynamoDB, pay-per-invocation Lambda, HTTP API over REST API, CloudTrail's free Event history instead of a custom Trail, and no VPC/NAT/always-on compute anywhere in the design.

## 9. How to use and verify it

**Prerequisites:** AWS CLI configured, or just the AWS Console; a GitHub account for login once auth is deployed.

**Verify the core guarantee right now, via the API:**
```bash
# 1. Register a record for a file already in the locked bucket
curl -X POST https://6yl1sp5oa7.execute-api.us-east-1.amazonaws.com/records \
  -H "Content-Type: application/json" \
  -d '{"fileName":"test.txt","s3Bucket":"s3objectlock-auditlock-locked","s3Key":"test.txt","s3VersionId":"<VERSION_ID>","retentionMode":"GOVERNANCE","retentionUntil":"2026-10-10T00:00:00Z"}'

# 2. Confirm it's denied while locked
curl -X POST https://6yl1sp5oa7.execute-api.us-east-1.amazonaws.com/records/<recordId>/delete-attempt

# 3. Confirm the authorized override succeeds
curl -X POST https://6yl1sp5oa7.execute-api.us-east-1.amazonaws.com/records/<recordId>/delete-attempt-admin

# 4. See the full timeline
curl https://6yl1sp5oa7.execute-api.us-east-1.amazonaws.com/records/<recordId>
```

**Once the frontend is deployed**, the same flow happens through the UI: log in with GitHub → upload → view the record's live status and timeline → attempt delete (denied) → log in as the admin account → override (deleted).

**Cross-check evidence independently:** CloudTrail → Event history → filter by Event name (`PutObjectRetention`, `DeleteObject`, `PutObjectLegalHold`) and match timestamps against the `RetentionEvents` table.

## 10. Project documents

| File | What it's for |
|---|---|
| `01_PROJECT_OVERVIEW.md` – `04_STEP_BY_STEP_GUIDE.md` | Original infra planning docs (T045 scope) |
| `05_FULL_BUILD_GUIDE.md` | The complete console build guide actually followed, backend included |
| `06_FRONTEND_AUTH_BUILD_PROMPTS.md` | Sequenced build/verify prompts for the remaining frontend + GitHub OAuth work |
| `README.md` | This file |

## 11. Cleanup

See `05_FULL_BUILD_GUIDE.md` Part 7 for the full teardown sequence (empty and delete both buckets, delete the DynamoDB tables, delete the Lambdas and API, delete the IAM users and roles). The AWS Budget alert can be left running at no cost.
