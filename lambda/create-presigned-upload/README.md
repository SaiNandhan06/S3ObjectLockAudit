# Lambda: create-presigned-upload

**Generates short-lived, authenticated presigned PUT URLs for direct browser uploads into `s3objectlock-auditlock-locked`.**

---

## 1. Specifications

- **Function Name**: `create-presigned-upload`
- **Runtime**: `Node.js 20.x`
- **Execution Role**: `lambda-dashboard-role`
- **Required Permission**: `s3:PutObject` on `arn:aws:s3:::s3objectlock-auditlock-locked/*` (included in `lambda-dashboard-role`).
- **Route**: `POST /uploads/presign`
- **Target API**: `auditlock-dashboard-api` (HTTP API)
- **Authorizer**: Do **not** attach the authorizer yet (per prompt instructions; will be attached in B4).

---

## 2. Request & Response Contract

### Request: `POST /uploads/presign`
```json
{
  "fileName": "audit-report.pdf",
  "contentType": "application/pdf"
}
```

#### Validation Rules:
1. `contentType` must be one of:
   - `application/pdf`
   - `text/plain`
   - `image/png`
   - `image/jpeg`
   *(Anything else returns HTTP 400).*
2. `fileName` must contain no path traversal sequences (no `..`, no leading `/`, no backslashes). *(Returns HTTP 400 on violation).*
3. S3 Key generated: `uploads/<uuid>-<sanitized-fileName>`.
4. URL expiry: `300` seconds (5 minutes).

### Response: HTTP 200
```json
{
  "uploadUrl": "https://s3objectlock-auditlock-locked.s3.us-east-1.amazonaws.com/uploads/951dfa97-5f65-4caf-9ebc-6e0b8638a69a-audit-report.pdf?...",
  "s3Bucket": "s3objectlock-auditlock-locked",
  "s3Key": "uploads/951dfa97-5f65-4caf-9ebc-6e0b8638a69a-audit-report.pdf",
  "expiresIn": 300
}
```

---

## 3. How to Deploy to AWS

### Option A: AWS Console (2 minutes)
1. **Lambda Console** → **Create function**:
   - Function name: `create-presigned-upload`
   - Runtime: **Node.js 20.x**
   - Architecture: `x86_64`
   - Permissions: Use existing role → `lambda-dashboard-role`
2. **Code**:
   - Paste the code from `lambda/create-presigned-upload/index.js` into the inline code editor (or upload `create-presigned-upload.zip`).
   - Click **Deploy**.
3. **API Gateway (auditlock-dashboard-api)**:
   - Go to **API Gateway** → `auditlock-dashboard-api`.
   - In left menu, click **Routes** → **Create**:
     * Method: `POST`
     * Path: `/uploads/presign`
   - Click on the newly created route `POST /uploads/presign` → **Attach integration**:
     * Integration type: **Lambda function**
     * Function: `create-presigned-upload`
     * Leave authorizer blank for now.
   - Click **Attach integration**.
   - If auto-deploy is enabled on `$default`, it goes live immediately. Otherwise, deploy the stage `$default`.

---

## 4. Verification (V1 Checklist)

To verify the presigned upload endpoint:

```bash
# 1. Request presigned URL
curl -X POST https://6yl1sp5oa7.execute-api.us-east-1.amazonaws.com/uploads/presign \
  -H "Content-Type: application/json" \
  -d '{"fileName":"audit-test.pdf","contentType":"application/pdf"}'

# 2. PUT a file directly to the returned uploadUrl (no AWS credentials)
curl -X PUT "<uploadUrl>" \
  -H "Content-Type: application/pdf" \
  --data-binary "Mock PDF content for audit lock test"

# 3. Test negative validation - invalid contentType (expect 400)
curl -i -X POST https://6yl1sp5oa7.execute-api.us-east-1.amazonaws.com/uploads/presign \
  -H "Content-Type: application/json" \
  -d '{"fileName":"archive.zip","contentType":"application/zip"}'

# 4. Test negative validation - path traversal (expect 400)
curl -i -X POST https://6yl1sp5oa7.execute-api.us-east-1.amazonaws.com/uploads/presign \
  -H "Content-Type: application/json" \
  -d '{"fileName":"../../etc/passwd","contentType":"text/plain"}'
```
