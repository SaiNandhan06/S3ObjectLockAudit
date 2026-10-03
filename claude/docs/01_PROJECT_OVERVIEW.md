# T045 — Object Lock & Bucket Infrastructure — Scope Overview
**Parent project:** S3 Object Lock for Write-Once Audit Records · ID 24CC3014-P045 · Category: Compliance

**This document, and the three that accompany it, cover T045's scope only.** T186 (backend API + metadata DB) and T327 (dashboard, the Phase 4 compliance demo, final documentation) are separate teams with separate work. If a task looks like building a REST endpoint or a UI screen, it does not belong here — it belongs to them.

---

## ⚠️ The one thing to internalize before anything else

This infrastructure will, once you reach Phase 4, support locking an object in **Compliance mode** — a state that cannot be undone by anyone, including AWS root, until a timer expires. T045 doesn't execute that demo (T327 does), but T045 builds the bucket, the IAM roles, and the guardrails it depends on. Get those wrong and the mistake becomes someone else's permanent problem.

**Default to Governance mode everywhere. Compliance mode is a per-object override that T327 deliberately invokes once — never a bucket default, never something T045 applies broadly.**

---

## 1. What T045 owns

- Creating both S3 buckets: the plain bucket (Phase 1) and the Object-Lock-enabled bucket (Phase 2) — versioning and Object Lock must be set **at creation**, with no retrofit possible
- Setting the Object-Lock bucket's default retention (Governance mode, short test duration)
- Designing and provisioning IAM roles and policies: uploader, compliance-officer, governance-bypass-admin, and the backend's own execution role
- Proving, with captured evidence, that: a delete is denied under Governance mode, an authorized bypass succeeds while an unauthorized one is denied, and a Legal Hold blocks deletion even once retention has separately expired
- Enabling and verifying CloudTrail before any Object Lock testing begins
- Setting the AWS Budget alert before any bucket exists
- Handing off a clean, documented infrastructure interface to T186 and T327 — see §7

## 2. What T045 explicitly does NOT own

- Any backend API, endpoint, or application code (T186)
- The metadata database / `records` / `retention_events` tables (T186)
- The dashboard UI (T327)
- **Executing** the Phase 4 Compliance-mode demo end to end (T327 owns the demo itself; T045's job ends at making sure the bucket, guardrails, and bypass-role setup it depends on are already correct)
- Writing the final production-policy narrative (T327 writes it; T045 supplies the raw evidence it cites)

If you're an agent and a prompt asks you to build something in this list, stop and flag it rather than doing it — it belongs to a different team's document set.

## 3. The problem, briefly

Financial/audit records must be provably tamper-proof for years. S3 Object Lock makes an object WORM — S3 itself refuses to delete or overwrite it during its retention period, which is the proof an auditor actually needs. T045's job is to stand up the AWS infrastructure that makes that guarantee real and provable.

## 4. Minimum vocabulary

| Term | Meaning |
|---|---|
| **Versioning** | Required prerequisite for Object Lock; every overwrite creates a new version |
| **Retention period** | Fixed window during which a version can't be deleted or overwritten |
| **Governance mode** | Bypassable by a user holding `s3:BypassGovernanceRetention` — T045's working default |
| **Compliance mode** | Bypassable by no one, ever, until expiry — T327's one deliberate per-object demo, never a T045-configured default |
| **Legal Hold** | Independent, no-expiration lock; removed explicitly, not by a countdown |

## 5. T045's slice of the architecture

```
   Plain bucket                Object-Lock bucket
   versioning ON               versioning ON, Object Lock ON (set at creation)
   Object Lock OFF             Default retention: Governance, short test duration
   (Phase 1)                   Per-object override: Compliance — T327's Phase 4 only, demo/ prefix
        |                              |
        |          IAM roles: uploader / compliance-officer /
        |          governance-bypass-admin / app-service-role
        |                              |
        +---------------+--------------+
                         |
                    CloudTrail
              immutable log of every lock, hold,
              bypass and delete-attempt action
                         |
        ── everything above this line is T045's scope ──
        ── everything below (API, DB, UI) is T186 / T327 ──
```

## 6. Build order for T045

```
Phase 0  Safety setup — budget alert, CloudTrail, sandbox naming, agreed test retention periods   [T045, full]
Phase 1  Create the plain bucket + versioning, hand the name to T186                                [T045, bucket only — no APIs]
Phase 2  Create the Object-Lock bucket, Governance default, IAM roles, prove denial + bypass         [T045, full]
Phase 3  Legal Hold — apply/remove, prove it overrides an already-expired retention                  [T045, full]
Phase 4  Prerequisites only: bypass role ready, guardrails confirmed, bucket default still Governance [T045 supports — T327 executes the demo itself]
Phase 5  Dashboard + final policy doc                                                                [not T045 — T327]
```

## 7. The handoff interface — what T186 and T327 actually need from you

| Item | Actual value (fill in) | Consumed by |
|---|---|---|
| Plain bucket name | `<fill in>` | T186 (upload API) |
| Object-Lock bucket name | `<fill in>` | T186 (upload API), T327 (compliance demo) |
| Default retention config | **None set at bucket level** — retention is applied per-object, Governance mode, at upload/edit time | T186, T327 — their code should apply retention explicitly per object, not assume a bucket default exists |
| `regular-uploader` user (replaces the `uploader` role) | Access key ID: `<fill in>` | T186 |
| `admin-full` user (replaces `compliance-officer` + `governance-bypass-admin`) | Access key ID: `<fill in>` | T186 (bypass/hold endpoints), T327 (Phase 4 differentiated delete attempts) |
| CloudTrail | No custom trail — use **Event history** in the console, filter by Event name | T327 (evidence reporting) |

Publish real values here as soon as each is stable — T186 and T327 are blocked without them. Access keys are secrets: share them through whatever secure channel your team actually uses, not by pasting them into this file.

## 8. Current status (T045 tasks only)

| Phase | Status | Notes |
|---|---|---|
| 0 — Safety setup | ✅ Done | Budget alert active ($5 threshold). Used the free built-in CloudTrail **Event history** instead of a paid custom Trail — no separate log bucket created. |
| 1 — Plain bucket | ✅ Done | Versioning confirmed working (old version retrievable after overwrite). |
| 2 — Object-Lock bucket, Governance, IAM | ✅ Done | Bucket created with Object Lock enabled at creation + versioning. **No bucket-level default retention was set** — retention is applied per-object at upload/edit time instead, deliberately, so nothing locks automatically. Denial proven; authorized bypass proven. |
| 3 — Legal Hold | ✅ Done | Confirmed a hold blocks deletion even after the object's own retention had already expired, using the same privileged identity that succeeded at a plain bypass — proves the two mechanisms are independent. |
| 4 — Prerequisites for T327's demo | ✅ Done | Confirmed via `get-object-lock-configuration` that the bucket has no default retention rule (still effectively "Governance-only" posture). Bypass-capable identity's access key is ready for T327's differentiated delete tests. |
| Handoff to T186/T327 | ⬜ Pending | See §7 below — table needs real values filled in (bucket names, key IDs) before sharing. |

**Build notes for whoever picks this up next:** IAM was simplified from the original 4-role design (uploader / compliance-officer / governance-bypass-admin / app-service-role) down to two IAM **users** for a solo learning build: `regular-uploader` (scoped S3 actions, no bypass) and `admin-full` (`AmazonS3FullAccess`, covers bypass + hold + everything else). If T186/T327 need the finer-grained roles for their own IAM setup, split `admin-full`'s permissions back out per the original architecture doc §4 table. Nothing here was codified into Terraform/CDK yet — every resource was created by hand via the console and AWS CLI (CloudShell). Turning this into reproducible IaC is a good next task if the team wants it.

## 9. Rules that must never bend

1. Never enable Object Lock on a bucket still under active development.
2. Never test with multi-day/year retention. Minutes or hours only.
3. Never make Compliance mode a bucket default — Governance is T045's default, always.
4. Never forget Object Lock requires versioning **and** must be set at bucket creation — no retrofit exists.
5. Never skip logging a *denied* delete — that denial is the evidence this whole project exists to produce.
6. Never build backend or dashboard code under this scope — flag it and hand it to T186/T327 instead.
