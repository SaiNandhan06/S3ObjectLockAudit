# S3 Object Lock for Write-Once Audit Records

**A working demonstration that stored records can be made provably tamper-proof and undeletable — enforced natively by AWS S3 Object Lock, backed by an append-only DynamoDB audit log, and managed via a modern web dashboard.**

---

## 1. Overview & Core Demonstration

Financial and audit records often must be kept provably tamper-proof for compliance retention windows. Storing files in traditional buckets is insufficient — auditors need mathematical proof that **no one**, including administrators, could have quietly altered or deleted records.

This project proves that guarantee using **Amazon S3 Object Lock**:
- **WORM Protection**: Locked objects cannot be deleted by standard callers; S3 rejects delete requests with `AccessDenied: object protected by object lock`.
- **Authorized Governance Bypass**: Privileged callers holding `s3:BypassGovernanceRetention` can override locks when authorized — logged explicitly, never silent.
- **Independent Legal Hold**: Blocks deletion even after retention windows expire, proving the two mechanisms are independent.
- **Append-Only DynamoDB Audit Trail**: Every action (allowed and denied) is captured in `RetentionEvents` and cross-verified in AWS CloudTrail Event history.
- **Interactive User Dashboard**: A modern glassmorphic web dashboard providing live S3 reconciliation, role-based delete attempt controls, and presigned direct S3 uploads.

---

## 2. Repository Structure

```
S3ObjectLockAudit/
├── dashboard/                  # Single-page web dashboard application
│   ├── index.html              # Modern semantic UI markup
│   ├── style.css               # Glassmorphic dark design system
│   ├── app.js                  # API client, upload flow, live reconciliation
│   ├── server.js               # Local development server with reverse proxy
│   └── README.md               # Frontend setup and deployment guide
│
├── lambda/                     # Backend AWS Lambda functions
│   └── create-presigned-upload/
│       ├── index.js            # POST /uploads/presign handler
│       ├── test.js             # Automated test suite (11 test cases)
│       ├── package.json        # Dependencies (@aws-sdk/s3-request-presigner)
│       └── README.md           # Deployment and testing guide
│
├── claude/                     # Original specifications and guides
│   └── docs/
│       ├── 01_PROJECT_OVERVIEW.md
│       ├── 02_PRD.md
│       ├── 03_ARCHITECTURE_AND_CODE_GUIDE.md
│       ├── 04_STEP_BY_STEP_GUIDE.md
│       ├── 05_FULL_BUILD_GUIDE.md
│       ├── 06_FRONTEND_AUTH_BUILD_PROMPTS.md
│       └── README.md
│
└── README.md                   # Project overview & architecture
```

---

## 3. Architecture & AWS Services

- **Amazon S3 (`s3objectlock-auditlock-locked`)**: Object Lock + Bucket Versioning enabled; stores write-once records under `uploads/`.
- **AWS Lambda**:
  - `create-presigned-upload`: Generates 5-minute pre-signed PUT URLs for direct browser uploads.
  - `create-record`: Registers record metadata and initial `RECORD_CREATED` event.
  - `list-records`: Scans and sorts records for catalog view.
  - `get-record-detail`: Fetches record metadata, live S3 status, and event timeline.
  - `delete-attempt-limited`: Tests deletion without bypass rights (expects `DENIED`).
  - `delete-attempt-admin`: Tests deletion with `s3:BypassGovernanceRetention` (expects `DELETED`).
- **Amazon API Gateway (HTTP API)**: `auditlock-dashboard-api` (`https://6yl1sp5oa7.execute-api.us-east-1.amazonaws.com`).
- **Amazon DynamoDB**:
  - `AuditRecords`: Partition key `recordId` (string).
  - `RetentionEvents`: Partition key `recordId` (string), Sort key `eventId` (string).
- **IAM Execution Roles**:
  - `lambda-dashboard-role`: Basic S3 read/write and DynamoDB access.
  - `lambda-delete-admin-role`: Adds `s3:DeleteObject`, `s3:DeleteObjectVersion`, and `s3:BypassGovernanceRetention`.

---

## 4. Running the Dashboard Locally

```bash
# Clone the repository
git clone https://github.com/SaiNandhan06/S3ObjectLockAudit.git
cd S3ObjectLockAudit

# Start the dashboard server
node dashboard/server.js
```

Open your browser at `http://localhost:3000`.

---

## 5. API Reference & Authentication

Base URL: `https://6yl1sp5oa7.execute-api.us-east-1.amazonaws.com`

Routes marked with 🔒 require `Authorization: Bearer <session token>` (enforced by `session-authorizer`). Read-only endpoints (`GET /records` and `GET /records/{id}`) are deliberately left unauthenticated for open, third-party audit transparency and evidence reconciliation.

| Method | Route | Lambda | Auth Required | Description |
|---|---|---|:---:|---|
| `POST` | `/uploads/presign` | `create-presigned-upload` | 🔒 Yes | Request 5-min presigned S3 upload URL |
| `POST` | `/records` | `create-record` | 🔒 Yes | Register record in `AuditRecords` |
| `GET` | `/records` | `list-records` | No (Open) | List all tracked audit records |
| `GET` | `/records/{id}` | `get-record-detail` | No (Open) | Get record, live S3 status, and event timeline |
| `POST` | `/records/{id}/delete-attempt` | `delete-attempt-limited` | 🔒 Yes | Attempt delete without bypass rights (expects DENIED) |
| `POST` | `/records/{id}/delete-attempt-admin` | `delete-attempt-admin` | 🔒 Yes | Attempt delete with bypass rights (admin-only) |
| `GET` | `/auth/callback` | `github-oauth-callback` | No (OAuth) | GitHub OAuth redirect callback target |

---

## 6. Route Protection Setup (B4)

In AWS API Gateway (`auditlock-dashboard-api`):
1. **Create Lambda Authorizer**:
   - Navigation: **Authorization** → **Manage authorizers** → **Create**.
   - Type: **Lambda**
   - Name: `session-authorizer`
   - Lambda Function: `session-authorizer`
   - Payload format version: **2.0**
   - Authorizer response mode: **Simple** (enable simple responses)
   - Identity sources: `$request.header.Authorization`
2. **Attach Authorizer to Routes**:
   - Under **Routes**, select each route → **Attach authorizer** → select `session-authorizer`:
     - `POST /records`
     - `POST /uploads/presign`
     - `POST /records/{id}/delete-attempt`
     - `POST /records/{id}/delete-attempt-admin`
3. **Leave Open**:
   - `GET /records`
   - `GET /records/{id}`
   - `GET /auth/callback`
4. **Deploy**:
   - Deploy changes to the `$default` stage.

---

## 7. Frontend Deployment (B9 — S3 Static Website + CloudFront)

### Dedicated Frontend S3 Bucket
- **Bucket Name**: `auditlock-dashboard-frontend-148737622933`
- **Region**: `us-east-1`
- **Static Website Hosting**: Enabled (`index.html` as index and error document)
- **Bucket Policy**: Public read (`s3:GetObject`) for static web assets
- **Live S3 Website URL**:
  `http://auditlock-dashboard-frontend-148737622933.s3-website-us-east-1.amazonaws.com`

### CloudFront Distribution Setup (Free HTTPS & Custom Domain)
Because S3 static website endpoints are HTTP-only and modern OAuth callbacks require HTTPS, CloudFront provides the global SSL distribution:

1. **Create CloudFront Distribution**:
   - **Origin Domain**: `auditlock-dashboard-frontend-148737622933.s3-website-us-east-1.amazonaws.com` (Use the S3 website endpoint as origin)
   - **Viewer Protocol Policy**: **Redirect HTTP to HTTPS**
   - **Allowed HTTP Methods**: `GET, HEAD, OPTIONS`
   - **Default Root Object**: `index.html`
   - **Price Class**: *Use only North America and Europe* (Free-tier friendly)
2. **Configure GitHub OAuth App & Lambda Callback**:
   - **GitHub OAuth App**: Set **Homepage URL** to your CloudFront URL (`https://<distribution-id>.cloudfront.net`).
   - **Lambda `github-oauth-callback`**: Set environment variable `FRONTEND_URL=https://<distribution-id>.cloudfront.net`.


