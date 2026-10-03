# Frontend + GitHub OAuth — Agent Build Prompts
**Builds on the already-deployed backend documented in `README.md`. Every build prompt (B) is followed by a verification prompt (V).**

Standing header — prefix every prompt below with this:

> **Standing context:** You are extending an existing S3 Object Lock audit project. Region `us-east-1`. Object-Lock bucket `s3objectlock-auditlock-locked`. DynamoDB tables `AuditRecords` and `RetentionEvents`. API base URL `https://6yl1sp5oa7.execute-api.us-east-1.amazonaws.com`. Existing Lambdas: `create-record`, `list-records`, `get-record-detail`, `delete-attempt-limited` (role `lambda-dashboard-role`), `delete-attempt-admin` (role `lambda-delete-admin-role`). Read `README.md` first. Do not modify the existing retention/delete logic's *behavior* — only add the auth context it reads from. Never put AWS credentials or GitHub client secrets in any frontend code. Finish by reporting: files touched, what you verified, and anything a human must configure manually (GitHub App settings, env vars) that you can't do yourself.

---

## Part A — Manual setup (you do this, not an agent)

1. GitHub → Settings → **Developer settings** → **OAuth Apps** → **New OAuth App**.
   - Application name: anything.
   - Homepage URL: your frontend's URL (fill in once Part C is deployed — you can edit this later).
   - **Authorization callback URL:** `https://6yl1sp5oa7.execute-api.us-east-1.amazonaws.com/auth/callback`
2. Save it. Copy the **Client ID**, and generate + copy a **Client secret**.
3. Decide your admin allow-list now: pick your own GitHub username as the one admin account for this demo.

You'll hand the Client ID, Client secret, and allow-list to the agent as environment variables in B2 below — never commit the secret to a repo.

---

## B1 — Presigned upload endpoint

```
Add a new Lambda, create-presigned-upload, role lambda-dashboard-role (it only
needs s3:PutObject on s3objectlock-auditlock-locked — add that permission if
missing).

Route: POST /uploads/presign
Body: { fileName, contentType }
- Validate contentType is one of: application/pdf, text/plain, image/png, image/jpeg.
  Reject anything else with 400.
- Validate fileName has no path traversal characters (no "..", no leading "/").
- Generate a key: uploads/<uuid>-<sanitized fileName>
- Use @aws-sdk/s3-request-presigner's getSignedUrl with a PutObjectCommand,
  expiring in 5 minutes.
- Return { uploadUrl, s3Bucket: "s3objectlock-auditlock-locked", s3Key, expiresIn: 300 }.

Wire the route into the existing API Gateway API (auditlock-dashboard-api).
Do not attach the authorizer yet — that happens in B4, once it exists.
```

## V1 — Verify presign

```
1. Call POST /uploads/presign with a valid body. Confirm 201/200, a working
   presigned URL, and a key under uploads/ with no path-traversal characters.
2. PUT a small test file directly to the returned uploadUrl (no AWS credentials
   involved in this step) and confirm it lands in the bucket at the returned key.
3. Call with an invalid contentType (e.g. application/zip) — confirm 400.
4. Call with a fileName containing ".." — confirm 400.
5. Confirm the URL stops working after 5 minutes (or state that you verified the
   expiry parameter is set correctly if waiting 5 minutes isn't practical).
6. Confirm the Lambda's IAM role has no permissions beyond what's needed for this
   endpoint (least privilege) — list its attached policy.

Report PASS/FAIL per check.
```

---

## B2 — GitHub OAuth callback Lambda

```
Add a new Lambda, github-oauth-callback, role: a new minimal role with no AWS
resource permissions beyond AWSLambdaBasicExecutionRole (it never touches S3 or
DynamoDB — it only talks to GitHub and mints a token).

Env vars: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, SESSION_SECRET (a long random
string you generate yourself — this signs the session token), ADMIN_GITHUB_LOGINS
(comma-separated, e.g. "yourusername"), FRONTEND_URL (the deployed frontend's
origin, from Part C — a placeholder is fine until that exists).

Route: GET /auth/callback?code=...
1. Exchange the code for a GitHub access token: POST
   https://github.com/login/oauth/access_token with client_id, client_secret,
   code, Accept: application/json header.
2. Using that access token, GET https://api.github.com/user for the profile
   (need the login field at minimum).
3. Determine role: "admin" if the GitHub login is in ADMIN_GITHUB_LOGINS,
   otherwise "user".
4. Mint a session token: a signed, time-limited token (HMAC-SHA256 over
   {githubLogin, role, exp} using SESSION_SECRET — a compact custom format is
   fine, it doesn't need to be a full JWT library, just signed and verifiable).
   Expire it after 12 hours.
5. Respond with a 302 redirect to `${FRONTEND_URL}/#token=<session token>` —
   using the URL fragment, not the query string, so the token never gets logged
   by API Gateway or any proxy.

Never log the GitHub client secret or any user's access token. Never store the
GitHub access token anywhere — fetch the profile once, then discard it; only
your own session token persists (in the browser, not server-side).
```

## V2 — Verify the OAuth callback

```
1. Manually walk through the GitHub login flow in a browser: visit
   https://github.com/login/oauth/authorize?client_id=...&scope=read:user,
   approve, confirm GitHub redirects to the callback URL with a code, and that
   this Lambda then redirects to FRONTEND_URL with a token in the fragment.
2. Decode the returned token's payload (not the signature) and confirm it
   contains the correct githubLogin and role ("admin" for your allow-listed
   username).
3. Log in as a second GitHub account not on the allow-list (or temporarily edit
   ADMIN_GITHUB_LOGINS to exclude yourself) and confirm role comes back "user".
4. Confirm CloudWatch logs for this Lambda contain no client secret, no GitHub
   access token, and no full session token in plaintext.
5. Confirm the token is rejected (in V3 below) after artificially shortening its
   expiry for a test, or state you've confirmed the exp field is set correctly.

Report PASS/FAIL per check.
```

---

## B3 — Lambda Authorizer

```
Add a new Lambda, session-authorizer, role: AWSLambdaBasicExecutionRole only.
Env vars: SESSION_SECRET (same value as github-oauth-callback — these must
match).

This is an API Gateway HTTP API Lambda authorizer using the "simple response"
format (payload format version 2.0).

- Read the Authorization header: expect "Bearer <token>".
- Verify the signature using SESSION_SECRET and check it hasn't expired.
- Missing, malformed, or invalid-signature token -> { isAuthorized: false }.
- Expired token -> { isAuthorized: false }.
- Valid token -> { isAuthorized: true, context: { githubLogin, role } }.

Do not throw on a bad token — always return a well-formed isAuthorized: false
response, never a 5xx, so the frontend gets a clean 401 instead of a crash.
```

## V3 — Verify the authorizer

```
1. Call it directly (Lambda console Test) with a valid token payload shaped like
   a real authorizer event — confirm isAuthorized: true and the correct context.
2. Test with no Authorization header — confirm isAuthorized: false, no exception
   thrown.
3. Test with a token signed with a DIFFERENT secret (simulating tampering) —
   confirm isAuthorized: false.
4. Test with a deliberately expired token — confirm isAuthorized: false.
5. Confirm this Lambda has no DynamoDB or S3 permissions at all — it only
   validates signatures.

Report PASS/FAIL per check.
```

---

## B4 — Attach the authorizer, protect the right routes

```
In API Gateway (auditlock-dashboard-api):
1. Create a Lambda authorizer using session-authorizer, identity source
   $request.header.Authorization, payload format 2.0, enable "simple responses".
2. Attach it to: POST /records, POST /uploads/presign,
   POST /records/{id}/delete-attempt, POST /records/{id}/delete-attempt-admin.
3. Leave GET /records and GET /records/{id} unauthenticated for now (read-only,
   lower risk) UNLESS the project wants everything gated — if so, attach the
   authorizer there too and note the decision in README.md.
4. Deploy the $default stage.
```

## V4 — Verify route protection

```
1. Call POST /records without an Authorization header — confirm 401.
2. Call it with a valid session token — confirm it still works as before
   (reuse a record creation test from the existing backend).
3. Call POST /records/{id}/delete-attempt-admin as a "user"-role token (not
   admin) and confirm it is still reachable at the API Gateway layer (the
   authorizer only checks that the token is VALID, not the role) — this is
   expected; role enforcement happens inside the Lambda in B5, not here.
   Confirm this gap explicitly so it isn't mistaken for already being closed.
4. Confirm GET /records behavior matches whatever was decided in step 4.3 above.

Report PASS/FAIL per check, and explicitly flag item 3 as the reason B5 is
not optional.
```

---

## B5 — Enforce role server-side (close the gap from V4.3)

```
Update delete-attempt-admin AND delete-attempt-limited:
- Read event.requestContext.authorizer.lambda.githubLogin and .role from the
  authorizer context (HTTP API Lambda authorizer simple-response context).
- Replace the current placeholder actor value ("api-caller") with the real
  githubLogin in every logEvent() call.
- In delete-attempt-admin specifically: if role !== "admin", return 403
  immediately, before attempting any S3 call. The frontend hiding the admin
  button is a UX nicety, not a security control — this check is the real one.
- In delete-attempt-limited: no role restriction needed (any authenticated user
  may attempt the limited delete, since it's expected to be denied by S3 anyway
  unless something's misconfigured).

Do not change the S3 call logic, the DynamoDB schema, or the response shapes —
only the actor source and the added role check.
```

## V5 — Verify role enforcement

```
1. As a "user"-role token, call delete-attempt-admin — confirm 403, and confirm
   NO delete attempt reached S3 (no new DELETE_ATTEMPTED log entry for this call
   in RetentionEvents — the request should be rejected before that point).
2. As the admin-role token, call delete-attempt-admin on a locked test object —
   confirm it still succeeds as before.
3. Check a recent RetentionEvents entry and confirm the actor field is now a
   real GitHub login, not "api-caller".
4. Re-run the original denial/bypass contrast test (limited vs admin) end to end
   through the authenticated API to confirm nothing regressed.

Report PASS/FAIL per check.
```

---

## B6 — Frontend scaffold + GitHub login

```
Build a static frontend: plain HTML/CSS/vanilla JS, no build step, no framework
— deployable as-is to an S3 static website bucket. Single page app via simple
show/hide of sections, not a router library.

Files: index.html, app.js, style.css.

Login:
- A "Log in with GitHub" button linking to
  https://github.com/login/oauth/authorize?client_id=<CLIENT_ID>&scope=read:user
- On page load, check location.hash for "token=..."; if present, store it in
  sessionStorage (not localStorage — this should not persist across browser
  restarts for a security-sensitive admin session), strip it from the URL via
  history.replaceState, and show the logged-in view.
- Decode the token's payload (base64, no verification needed client-side —
  the backend already verified it) to display the user's GitHub login and role.
- A "Log out" button that clears sessionStorage and reloads.
- Every API call attaches Authorization: Bearer <token> from sessionStorage.
- On any 401 response from the API, clear the session and show the login view.
```

## V6 — Verify login UX

```
1. Open the page logged out — confirm only the login button is visible, no API
   calls are attempted.
2. Complete the GitHub login flow — confirm the token is picked up from the URL
   fragment, the fragment is removed from the visible URL, and the logged-in
   view shows the correct GitHub login and role.
3. Refresh the page while logged in — confirm the session persists (still in
   sessionStorage) without a re-login.
4. Close and reopen the tab — confirm the session is gone (sessionStorage is
   tab-scoped) and the login view shows again.
5. Manually corrupt the stored token in devtools, trigger an API call, confirm
   the app detects the resulting 401 and returns to the login view instead of
   showing a broken state.

Report PASS/FAIL per check.
```

---

## B7 — Upload flow

```
Add an upload form: file picker + upload button.
1. On submit, call POST /uploads/presign with the file's name and MIME type.
2. PUT the raw file to the returned uploadUrl directly (not through the API).
3. After the PUT succeeds, call POST /records with the returned s3Bucket/s3Key
   plus a placeholder retentionMode "NONE" (this project doesn't apply retention
   automatically on upload — that stays a deliberate, separate action per the
   existing project rules) and s3VersionId left blank if not yet known, OR fetch
   the version id via a small addition to create-presigned-upload if you want it
   populated immediately (note which approach you took).
4. Show upload progress and a clear success/error state.
5. On success, refresh the records list.
```

## V7 — Verify upload

```
1. Upload a small PDF end to end through the UI — confirm it appears in the
   records list afterward.
2. Confirm the file is actually present in the S3 bucket at the expected key.
3. Attempt to upload a disallowed file type — confirm the UI shows a clear
   rejection without a raw/ugly error.
4. Attempt an upload while logged out — confirm it's blocked client-side AND
   that the API itself returns 401 if called directly without a token.

Report PASS/FAIL per check.
```

---

## B8 — Records list, detail, and delete

```
Records list view:
- GET /records, render as a table: file name, retention mode, retain-until,
  legal hold, upload date.
- Click a row to open detail.

Detail view:
- GET /records/{id}. Show the record, the LIVE S3 status (mode, retain-until,
  legal hold — from liveStatus, not the cached record fields), and the full
  event timeline from events, oldest first, with type/actor/outcome/timestamp.
- A "Attempt delete" button -> POST /records/{id}/delete-attempt. Show the
  returned outcome (DENIED or DELETED) plainly, including the reason text for
  a denial — don't hide it, that's the point of the whole project.
- An "Admin override delete" button, rendered ONLY when the logged-in user's
  role is "admin" -> POST /records/{id}/delete-attempt-admin. Same outcome
  display.
- After either delete call, refresh the detail view's event timeline.
```

## V8 — Verify records UI

```
1. As a "user"-role login, open a locked record, click "Attempt delete", confirm
   the UI clearly shows DENIED with the real S3 error reason text.
2. Confirm the "Admin override delete" button is NOT present for this user.
3. Log in as the admin account, open the same (or an equivalent) locked record,
   confirm the admin button IS present, click it, confirm DELETED is shown.
4. Confirm the event timeline updates after each action without a full page
   reload being required (or state that a manual refresh is required, if that's
   the actual behavior).
5. Confirm the live S3 status shown matches reality (spot-check one record
   against aws s3api get-object-retention).

Report PASS/FAIL per check.
```

---

## B9 — Deploy the frontend

```
1. Create an S3 bucket for the frontend (separate from the audit-record
   buckets), enable static website hosting, upload index.html/app.js/style.css.
2. Put a CloudFront distribution in front of it for a free HTTPS URL (S3 website
   endpoints are HTTP-only, and GitHub OAuth callback flows should run over
   HTTPS) — simplest option: origin access via the S3 website endpoint, default
   CloudFront certificate.
3. Update the GitHub OAuth App's Homepage URL and the github-oauth-callback
   Lambda's FRONTEND_URL env var to the real CloudFront URL.
4. Document the final URL in README.md.
```

## V9 — Verify deployment

```
1. Load the CloudFront URL in a browser — confirm it's HTTPS and the page
   renders.
2. Complete the full login -> upload -> list -> delete-attempt -> admin-delete
   flow against the deployed URL, not localhost.
3. Confirm the S3 bucket hosting the frontend has public access configured only
   as far as necessary for website hosting (or is private with CloudFront OAC,
   if you chose that route) — not broadly public beyond what's needed.
4. Confirm cost: check that nothing provisioned here (CloudFront, S3) is outside
   free-tier-friendly, pay-per-use pricing.

Report PASS/FAIL per check, plus the final live URL.
```

---

## Final — V10: full end-to-end acceptance

```
Starting from a logged-out browser on the deployed URL:
1. Log in with GitHub as a non-admin account.
2. Upload a file.
3. View it in the list and open its detail.
4. Attempt a delete — confirm DENIED with a real, readable S3 error.
5. Log out, log back in as the admin account.
6. Open the same record, use the admin override — confirm DELETED.
7. Confirm RetentionEvents in DynamoDB shows the full sequence with correct
   actors (real GitHub logins, not placeholders) for every step.
8. Confirm CloudTrail Event history shows the matching DeleteObject calls.

This is the project's complete story end to end. Report PASS/FAIL per step,
and list anything that had to be worked around to get here.
```
