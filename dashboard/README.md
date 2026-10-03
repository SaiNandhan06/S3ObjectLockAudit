# AuditLock — User Dashboard

**A high-fidelity static web interface for S3 Object Lock compliance verification, audit record lifecycle tracking, and role-based delete attempt testing.**

---

## 1. Features Implemented

- **Modern Glassmorphic Dark UI**: Custom-designed theme featuring curated gradients, real-time connection status indicators, and responsive metrics cards.
- **Live AWS S3 Status Reconciliation**: Calls `GET /records/{id}` and compares stored DynamoDB metadata against the live S3 Object Lock state (`liveRetention.Mode`, `liveRetention.RetainUntilDate`, `liveLegalHold`).
- **Role-Based Privilege Enforcement**:
  - Seamlessly handles GitHub OAuth session tokens (`#token=...` in the URL fragment stored in `sessionStorage`).
  - Evaluates role client-side: when logged in as a standard `USER`, only the standard delete attempt button is available.
  - When authenticated as `ADMIN`, the **Admin Override Delete (Bypass Governance)** action is dynamically unlocked.
  - Fast Role Emulation: Includes a quick role toggle for immediate verification without requiring an OAuth provider callback during local testing.
- **Direct S3 Presigned Upload (B7 Flow)**:
  - Drag-and-drop file picker validating allowed MIME types: `.pdf`, `.txt`, `.png`, `.jpeg`.
  - Requests a pre-signed PUT URL from `POST /uploads/presign`.
  - Streams the file directly from the browser to the Object-Lock bucket `s3objectlock-auditlock-locked`.
  - Registers the newly uploaded file in `AuditRecords` via `POST /records`.
- **Append-Only DynamoDB Audit Trail**: Visualizes all historical events (`RECORD_CREATED`, `DELETE_ATTEMPTED`, `DELETE_DENIED`, `BYPASS_USED`) with actor, outcome badges, timestamps, and exact error details.

---

## 2. Directory Structure

```
dashboard/
├── index.html       # Single-page application markup with semantic structure & unique IDs
├── style.css        # Vanilla CSS design system with tokens, glassmorphism & micro-animations
├── app.js           # API client, session management, direct upload, and event timelines
├── server.js        # Local development server with built-in API Gateway reverse proxy
└── README.md        # Documentation and deployment guide
```

---

## 3. Running Locally

To launch the dashboard locally:

```bash
# From the project root:
node dashboard/server.js
```

Open your browser at:
```
http://localhost:3000
```

> **Note on Local Development & CORS:**
> `dashboard/server.js` serves the static assets and automatically proxies requests starting with `/api/*` to `https://6yl1sp5oa7.execute-api.us-east-1.amazonaws.com` with wildcard CORS headers. This eliminates browser CORS friction during development.

---

## 4. Production Deployment to S3 + CloudFront (B9)

1. **Create an S3 static website bucket** (e.g. `auditlock-dashboard-web`):
   ```bash
   aws s3 mb s3://auditlock-dashboard-web --region us-east-1
   aws s3 website s3://auditlock-dashboard-web --index-document index.html
   ```

2. **Upload frontend assets**:
   ```bash
   aws s3 cp dashboard/index.html s3://auditlock-dashboard-web/index.html
   aws s3 cp dashboard/style.css s3://auditlock-dashboard-web/style.css
   aws s3 cp dashboard/app.js s3://auditlock-dashboard-web/app.js
   ```

3. **CloudFront Distribution**:
   - Create a CloudFront distribution pointing to the S3 website endpoint for free HTTPS.
   - Configure the GitHub OAuth App Homepage URL and callback redirect to the CloudFront domain.
