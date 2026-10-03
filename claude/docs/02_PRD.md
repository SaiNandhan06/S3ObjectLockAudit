# T045 — Object Lock & Bucket Infrastructure — PRD
**v1.0 · Scope: T045 only · Parent project ID 24CC3014-P045**

> ⚠️ Read `01_PROJECT_OVERVIEW.md` §0–2 first. This PRD covers infrastructure only — no API, no database, no UI. Those belong to T186 and T327's own documents.

---

## 1. Mission

Deliver a correctly configured, evidenced S3 Object Lock setup — buckets, retention defaults, IAM roles, CloudTrail — that T186's backend and T327's dashboard/demo can build on without needing to understand or re-derive any of it themselves.

## 2. Scope

**In scope:** AWS Budget alert, CloudTrail setup, plain bucket, Object-Lock bucket (versioning + lock at creation), bucket-level default retention (Governance), IAM role design and provisioning (uploader, compliance-officer, governance-bypass-admin, app-service-role), CLI-level proof of denied delete / authorized bypass / Legal Hold behavior, the handoff interface document.

**Out of scope:** any REST API or application code (T186), the `records`/`retention_events` database (T186), the dashboard UI (T327), executing the Phase 4 Compliance-mode demo (T327 — T045 only ensures its prerequisites exist), the final production-policy narrative (T327 writes it, citing T045's evidence).

## 3. Functional requirements

### FR-1 Safety prerequisites (Phase 0)
- **FR-1.1** An AWS Budget alert (e.g. $5 threshold) is active before any bucket is created.
- **FR-1.2** CloudTrail is enabled in the sandbox account/region before any Object Lock testing begins.
- **FR-1.3** A sandbox naming convention (`sandbox-...`) is agreed and used for every resource T045 creates.
- **FR-1.4** Two retention numbers are documented and kept distinct: the short test period actually used, and the real 7-year policy that is only ever documented, never run.

### FR-2 Plain bucket (Phase 1)
- **FR-2.1** A plain S3 bucket exists with versioning enabled, Object Lock disabled.
- **FR-2.2** Its name and region are published to T186 via the handoff interface.
- **FR-2.3** No test data of consequence lives here permanently — it's for T186's API development, not for T045's own evidence.

### FR-3 Object-Lock bucket (Phase 2)
- **FR-3.1** A **separate, newly created** bucket has Object Lock enabled at creation, with versioning enabled.
- **FR-3.2** Bucket-level default retention is Governance mode, with a short test duration (minutes) sourced from an environment/config value — never hardcoded as a multi-year figure outside the documented policy.
- **FR-3.3** A test object uploaded to this bucket, with no per-object override, inherits the bucket default — confirmed via `get-object-retention`.
- **FR-3.4** A delete attempt on that object before expiry is denied by S3. The exact AWS error (code, message, request ID) is captured as evidence.
- **FR-3.5** An IAM role (`governance-bypass-admin`) holding `s3:BypassGovernanceRetention` can successfully delete the same object early; a role without that permission cannot. Both outcomes are captured.
- **FR-3.6** CloudTrail shows entries for the lock application and the bypass action.

### FR-4 IAM (Phase 2, ongoing)
- **FR-4.1** Four roles exist with least-privilege policies: `uploader`, `compliance-officer`, `governance-bypass-admin`, `app-service-role` (see architecture doc §4 for exact permissions).
- **FR-4.2** No role other than `governance-bypass-admin` carries `s3:BypassGovernanceRetention`.
- **FR-4.3** Role ARNs are published to T186 and T327 via the handoff interface as soon as each is stable.

### FR-5 Legal Hold (Phase 3)
- **FR-5.1** A hold can be applied to an object independent of its retention period, via `PutObjectLegalHold`.
- **FR-5.2** Deletion is denied while the hold is active, **even on an object whose retention has already expired** — this specific case is tested explicitly, not assumed.
- **FR-5.3** An authorized role can remove the hold; deletion then succeeds if retention also permits it. Both the apply and the remove actions appear in CloudTrail.

### FR-6 Phase 4 prerequisites only (not execution)
- **FR-6.1** Confirm the Object-Lock bucket's *default* retention remains Governance — Compliance mode must never be a bucket-level default.
- **FR-6.2** Confirm the `governance-bypass-admin` role T327 will use for its differentiated delete-attempt tests is correctly provisioned and its ARN is published.
- **FR-6.3** T045 does not create, lock, or delete the Phase 4 demo object itself — that action and its evidence belong entirely to T327.

### FR-7 Handoff
- **FR-7.1** A single, current handoff document (see overview §7) lists both bucket names, all four role ARNs, and the CloudTrail trail name/ARN.
- **FR-7.2** The handoff document is updated the same day any of those values changes — a stale bucket name or role ARN silently breaks T186's or T327's work.

## 4. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | Every retention-affecting action T045 performs (lock config, bypass, hold) is captured with actor, timestamp, and outcome |
| NFR-2 | All T045 test retention periods are minutes-to-hours; no multi-day period is ever used outside `docs/final-policy.md`, which T327 owns |
| NFR-3 | The Object-Lock bucket never holds ordinary development files; the plain bucket never holds a locked object |
| NFR-4 | IAM policies are least-privilege, scoped to specific bucket ARNs, never wildcarded |
| NFR-5 | The sandbox environment is destroyable once all test retentions have naturally expired, with near-zero ongoing cost |

## 5. Evidence format (T045's deliverable, not a database)

T045 does not build or own a database — evidence is captured as raw, timestamped CLI/console output, stored under `docs/evidence/t045/`. Each artifact should record: the exact AWS CLI command run, the full response (including error code/message for denials), and the timestamp. This is what T327 will cite in the final policy document, so completeness here matters more than formatting.

## 6. Acceptance criteria — T045 scope

1. ✅ AWS Budget alert was active before the first bucket was created.
2. ✅ CloudTrail was enabled (via the always-on Event history) before Object Lock testing began — no custom Trail was needed.
3. ✅ The plain bucket exists, versioning on, Object Lock off.
4. ✅ The Object-Lock bucket was created with Object Lock enabled at creation (not added after) and versioning on.
5. ✅ A test object's `get-object-retention` output matched the retention applied to it (set per-object; no bucket-level default was configured — see §8 Implementation notes).
6. ✅ A delete attempt before expiry returned `AccessDenied`, captured in full terminal output.
7. ✅ The `admin-full` identity's delete succeeded before expiry; the `regular-uploader` identity's delete on an equivalent object failed. Both captured side by side.
8. ✅ A Legal Hold blocked deletion on an object whose retention had already expired, using the *same* privileged identity that succeeded at a plain bypass — proving the two mechanisms are independent. Captured.
9. ✅ Confirmed via `get-object-lock-configuration` that the bucket carries no default retention rule at all (stronger than "confirmed Governance" — there's no default to drift away from).
10. ⬜ Pending — real bucket names and access key IDs need to be filled into the handoff table before sharing with T186/T327.
11. ✅ CloudTrail Event history entries exist for `PutObjectRetention`, `DeleteObject` (both outcomes), and `PutObjectLegalHold`, cross-checked against the CLI evidence timestamps.

## 7. Implementation notes — where the actual build differs from the original plan

These are deliberate, reasoned deviations made while building this solo for learning purposes. They don't reduce what's proven; they just simplify who/what a continuing engineer will find in the AWS account.

- **IAM roles consolidated to two users.** The original 4-role design (`uploader`, `compliance-officer`, `governance-bypass-admin`, `app-service-role`) was built as two IAM users instead: `regular-uploader` (scoped basic S3 actions, no bypass) and `admin-full` (`AmazonS3FullAccess`, covering bypass and hold management). If T186 or T327 need the finer-grained separation for a production-style setup, split `admin-full` back into the original three roles per the architecture doc.
- **No bucket-level default retention.** Every retention was applied per-object at upload/edit time instead of via a bucket-wide default. This was a deliberate choice for a solo learner: it keeps every lock a conscious, individually-reviewed action rather than something that silently applies to every future upload. FR-3.2 above should be read as "retention is applied per object" rather than "a bucket default is configured."
- **CloudTrail Event history instead of a custom Trail.** The always-on, free 90-day Event history was sufficient evidence for this project's timeline, avoiding the cost and setup of a dedicated Trail (which would have created a second S3 bucket for log storage). If the final report needs retention of evidence beyond 90 days, export the relevant Event history entries to a file now rather than creating a Trail later.
- **No Terraform/CDK was written.** All resources were created by hand via the AWS Console and CLI (CloudShell) for learning purposes. The repository layout in the architecture doc (§2) describes where IaC *would* live if the team codifies this later — it doesn't exist yet.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Object Lock enabled on the wrong / actively-developed bucket | Prove IaC changes in a throwaway bucket first; only apply to the named Object-Lock bucket once reviewed |
| Bucket default accidentally set to Compliance | Not applicable as built — no bucket-level default retention was configured at all. If one is added later, require a second reviewer before apply. |
| Retention period set to years instead of minutes in dev config | Retention duration was set explicitly per-object with a near-term timestamp each time, never a bucket-wide literal |
| Stale handoff document blocks T186/T327 | FR-7.2 — update same day, treat it as part of "done," not an afterthought |
| IAM role over-scoped (wildcard resource/action) | `admin-full` intentionally carries broad S3 access as a learning-build simplification — acceptable for a sandbox account, but should be split into least-privilege roles before any production-style use |
