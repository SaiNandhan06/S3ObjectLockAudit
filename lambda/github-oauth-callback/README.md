# Lambda: github-oauth-callback

**Exchanges temporary GitHub authorization codes for profiles, determines administrative privileges, and mints 12-hour signed session tokens redirected via URL fragments.**

---

## 1. Specifications

- **Function Name**: `github-oauth-callback`
- **Runtime**: `Node.js 20.x`
- **Execution Role**: Minimal role with **only** `AWSLambdaBasicExecutionRole` (managed policy). It requires no permissions on S3, DynamoDB, or other AWS resources.
- **Route**: `GET /auth/callback`
- **Target API**: `auditlock-dashboard-api` (HTTP API)
- **Authorizer**: None (this is the public authentication entry point).

---

## 2. Environment Variables

| Variable | Description | Example / Recommended Value |
|---|---|---|
| `GITHUB_CLIENT_ID` | OAuth App Client ID from GitHub | Obtained from GitHub Developer settings |
| `GITHUB_CLIENT_SECRET` | OAuth App Client Secret from GitHub | Generated in GitHub Developer settings *(never commit)* |
| `SESSION_SECRET` | 64+ char random secret key for HMAC-SHA256 | e.g., generated with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ADMIN_GITHUB_LOGINS` | Comma-separated allow-list of GitHub usernames granted `admin` role | e.g. `SaiNandhan06` |
| `FRONTEND_URL` | Deployed frontend origin (or localhost during dev) | `http://localhost:3000` or CloudFront HTTPS URL |

---

## 3. Execution Flow

1. Browser redirects user to `https://github.com/login/oauth/authorize?client_id=...&scope=read:user`.
2. User approves, GitHub redirects to `GET /auth/callback?code=...`.
3. Lambda exchanges `code` via `POST https://github.com/login/oauth/access_token`.
4. Retrieves authenticated user profile via `GET https://api.github.com/user` (`login` field).
5. Determines role: `admin` if username matches `ADMIN_GITHUB_LOGINS`, otherwise `user`.
6. Discards GitHub access token immediately (never stored or logged).
7. Mints signed session token:
   - Format: `base64url(header).base64url(payload).signature`
   - Algorithm: HMAC-SHA256
   - Expiration: 12 hours (43,200 seconds)
8. Returns `HTTP 302 Redirect` to `${FRONTEND_URL}/#token=<session-token>`.
   *(Using URL fragment ensures token is tab-scoped, not logged in API Gateway or server access logs).*

---

## 4. How to Deploy via AWS Console

### Step 1: Create IAM Execution Role
1. Open **IAM** → **Roles** → **Create role**.
2. Trusted entity type: **AWS service** → Use case: **Lambda**.
3. Attach policy: **`AWSLambdaBasicExecutionRole`** only.
4. Role name: `lambda-github-oauth-role` (or use existing basic role).
5. Click **Create role**.

### Step 2: Create Lambda Function
1. Open **AWS Lambda** → **Create function**.
2. Function name: `github-oauth-callback`
3. Runtime: **Node.js 20.x**
4. Execution role: Select `lambda-github-oauth-role`.
5. Code: Upload `github-oauth-callback.zip` or paste [`index.js`](./index.js) into the editor.
6. Under **Configuration** → **Environment variables**, set:
   - `GITHUB_CLIENT_ID`
   - `GITHUB_CLIENT_SECRET`
   - `SESSION_SECRET`
   - `ADMIN_GITHUB_LOGINS`
   - `FRONTEND_URL`
7. Click **Deploy**.

### Step 3: Wire Route in API Gateway
1. Open **API Gateway** → **`auditlock-dashboard-api`**.
2. In left menu, click **Routes** → **Create**:
   - Method: `GET`
   - Route path: `/auth/callback`
3. Click on the route `GET /auth/callback` → **Attach integration**:
   - Integration target: **Lambda function**
   - Function: `github-oauth-callback`
4. Click **Attach integration**.
