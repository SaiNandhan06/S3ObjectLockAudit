# Lambda: session-authorizer

**API Gateway HTTP API Lambda authorizer using payload format 2.0 (simple responses) and HMAC-SHA256 signature verification.**

---

## 1. Specifications

- **Function Name**: `session-authorizer`
- **Runtime**: `Node.js 20.x`
- **Execution Role**: Minimal role with `AWSLambdaBasicExecutionRole` only (no S3 or DynamoDB permissions).
- **Target API**: `auditlock-dashboard-api` (HTTP API)
- **Authorizer Type**: Lambda Authorizer
- **Format**: Simple Response (Payload Format Version 2.0)
- **Identity Source**: `$request.header.Authorization`

---

## 2. Environment Variables

| Variable | Description | Value |
|---|---|---|
| `SESSION_SECRET` | Cryptographic secret used to sign and verify HMAC-SHA256 session tokens | **Must match** the value in `github-oauth-callback` (e.g. `415c0dffb476ba8be477ce3c585720f2cbc82b41e98976d96a150cf5511b1005`) |

---

## 3. Response Contract

### When Valid & Active:
```json
{
  "isAuthorized": true,
  "context": {
    "githubLogin": "SaiNandhan06",
    "role": "admin"
  }
}
```

### When Missing, Invalid Signature, or Expired:
```json
{
  "isAuthorized": false
}
```
*(Never throws exceptions or returns 5xx; guarantees a clean 401 Unauthorized for invalid sessions).*

---

## 4. How to Deploy via AWS Console

### Step 1: Create IAM Role (or reuse `lambda-github-oauth-role`)
1. IAM → Roles → Create role → Lambda.
2. Attach policy: `AWSLambdaBasicExecutionRole`.
3. Name: `lambda-authorizer-role`.

### Step 2: Create Lambda Function
1. Lambda Console → **Create function**.
2. Name: `session-authorizer`.
3. Runtime: **Node.js 20.x**.
4. Role: `lambda-authorizer-role`.
5. Code: Upload `session-authorizer.zip` or paste [`index.js`](./index.js).
6. Under **Configuration** → **Environment variables**, add:
   - `SESSION_SECRET`: `<same secret as github-oauth-callback>`
7. Click **Deploy**.

### Step 3: Configure API Gateway Authorizer (in B4)
1. In API Gateway → `auditlock-dashboard-api` → **Authorization** → **Manage authorizers**.
2. Click **Create**:
   - Authorizer type: **Lambda**
   - Name: `session-authorizer`
   - Lambda function: `session-authorizer`
   - Payload format version: **2.0**
   - Response mode: **Simple** (enable "simple responses")
   - Identity sources: `$request.header.Authorization`
3. Click **Save**.
