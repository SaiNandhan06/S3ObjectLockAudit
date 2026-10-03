# T045 — Step-by-Step Guide
**Scope: bucket infrastructure, Object Lock, IAM, Legal Hold. Nothing here builds an API or a UI — that's T186 and T327.**

Follow in order. Each item: what to do, and what proves it's done.

---

## Phase 0 — Safety setup (before any bucket exists)

- [x] **0.1** Set an AWS Budget alert ($5 threshold). *(Done — active.)*
- [ ] **0.2** Enable Cost Explorer. *(Optional for a solo build — not yet done.)*
- [x] **0.3** ~~Enable CloudTrail~~ Confirmed the free, always-on **Event history** is available and sufficient — no dedicated Trail created. *(Done.)*
- [x] **0.4** Agreed: short test retentions of a few minutes; the real 7-year figure exists only in writing, never applied. *(Done.)*
- [ ] **0.5** Sandbox naming convention — informal for a solo build; formalize (`sandbox-...` prefix) before handing off to T186/T327 if this becomes a shared account.

**Gate before Phase 1:** cleared.

---

## Phase 1 — Plain bucket only

- [x] **1.1** Created the plain S3 bucket via the console, versioning enabled, Object Lock not configured.
- [x] **1.2** Confirmed versioning works: overwrote a test key, listed versions, old version still retrievable.
- [ ] **1.3** Publish the bucket name to the handoff table in `01_PROJECT_OVERVIEW.md` §7 — real value still needs filling in.

You are not building upload/download APIs here — that's T186, against the bucket you just published.

**Gate before Phase 2:** cleared.

---

## Phase 2 — Object-Lock bucket, Governance mode, IAM

- [x] **2.1** Created a **new**, separate bucket with Object Lock enabled **at creation** and versioning enabled.
- [x] **2.2** ~~Set bucket-level default retention~~ Deliberately did **not** set a bucket-level default — retention is applied per-object at upload/edit time instead (see PRD §7 Implementation notes for why).
- [x] **2.3** Provisioned IAM as two users instead of four roles: `regular-uploader` (no bypass) and `admin-full` (`AmazonS3FullAccess`). See architecture guide §4 for the mapping back to the original role design.
- [x] **2.4** Uploaded a test object, confirmed `get-object-retention` matched the retention applied to it. Captured.
- [x] **2.5** Attempted deletion before expiry with `regular-uploader` — confirmed `AccessDenied`, captured the full error.
- [x] **2.6** Confirmed `admin-full` could delete early while `regular-uploader` could not, on equivalent objects. Both outcomes captured side by side.
- [x] **2.7** Confirmed CloudTrail Event history shows the lock application and the bypass delete, cross-checked against captured CLI evidence.
- [ ] **2.8** Publish the bucket name and both users' access key IDs to the handoff table — real values still needed.

**Gate before Phase 3:** cleared — 2.5 and 2.6 evidence captured.

---

## Phase 3 — Legal Hold

- [x] **3.1** Applied a hold to a test object using `admin-full`.
- [x] **3.2** Waited until that object's own retention had genuinely expired, **then** attempted deletion with `admin-full` — confirmed it was still denied because the hold was active, proving the hold is independent of retention (not just "also strict").
- [x] **3.3** Removed the hold, confirmed deletion then succeeded.
- [x] **3.4** Confirmed both the apply and remove actions appear in CloudTrail Event history.

**Gate before Phase 4 handoff:** cleared.

---

## Phase 4 — Prerequisites only (T327 executes the actual demo)

- [x] **4.1** Confirmed via `get-object-lock-configuration` that the bucket carries no default retention rule at all — stronger than "still Governance," since there's no default to have drifted.
- [ ] **4.2** Publish `admin-full`'s access key ID to the handoff table so T327 can use it for differentiated delete-attempt tests against their Compliance-mode demo object.
- [x] **4.3** Did not create, lock, or attempt to delete any Compliance-mode object — that stays entirely with T327.

**Gate:** items 4.1 and 4.3 cleared; 4.2 (publishing the real value) is the one remaining step before this hands off cleanly to T327.

---

## Not in scope for T045

- Phase 1 upload/download/list APIs — T186
- Phase 2 delete-attempt and bypass **endpoints** — T186 (T045 proves the underlying AWS behavior via CLI; T186 wraps it in an API)
- Phase 3 Legal Hold **endpoints** — T186
- Phase 4 Compliance-mode demo execution — T327
- Phase 5 dashboard, evidence packaging, final policy document — T327

---

## Teardown (after grading / demo is complete, T045's resources only)

- [ ] Confirm every T045-created object's retention has naturally expired.
- [ ] Delete objects, then delete both buckets.
- [ ] Confirm in Cost Explorer that sandbox spend has returned to near-zero.
- [ ] Archive `docs/evidence/t045/` and `infra/handoff.md` outside the sandbox account before tearing it down.

---

## If you're an agent picking this up mid-project

1. Read `01_PROJECT_OVERVIEW.md` §8 for the real current status, not what's claimed elsewhere.
2. Read `03_ARCHITECTURE_AND_CODE_GUIDE.md` for exact bucket/IAM configuration and CLI verification commands.
3. Resume from the first unchecked box in the phase you're on.
4. If a request pulls you into API, database, or UI work, stop and say it belongs to T186 or T327.
