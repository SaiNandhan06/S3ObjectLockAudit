const { randomUUID } = require("crypto");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const REGION = process.env.AWS_REGION || "us-east-1";
const BUCKET_NAME = process.env.BUCKET_NAME || "s3objectlock-auditlock-locked";
const EXPIRES_IN = parseInt(process.env.EXPIRES_IN || "300", 10);

const s3Client = new S3Client({ region: REGION });

const ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "image/png",
  "image/jpeg",
]);

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

exports.handler = async (event) => {
  // Support CORS preflight
  const httpMethod = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || event.httpMethod || "";
  if (httpMethod.toUpperCase() === "OPTIONS") {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ message: "OK" }),
    };
  }

  let body;
  try {
    body = typeof event.body === "string" ? JSON.parse(event.body || "{}") : (event.body || {});
  } catch (err) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: { message: "Invalid JSON body" } }),
    };
  }

  const { fileName, contentType } = body;

  // 1. Validate contentType
  if (!contentType || typeof contentType !== "string" || !ALLOWED_CONTENT_TYPES.has(contentType)) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: {
          message: `Invalid or missing contentType. Allowed types: ${Array.from(ALLOWED_CONTENT_TYPES).join(", ")}`,
        },
      }),
    };
  }

  // 2. Validate fileName for path traversal
  if (!fileName || typeof fileName !== "string") {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: { message: "fileName is required and must be a string" },
      }),
    };
  }

  // Reject path traversal characters ("..", leading "/", or backslashes)
  if (fileName.includes("..") || fileName.startsWith("/") || fileName.includes("\\")) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: { message: "Invalid fileName: path traversal characters (no '..', no leading '/') are not allowed" },
      }),
    };
  }

  // Strip any remaining path elements and sanitize characters
  const baseName = fileName.replace(/^.*[\\/]/, "").trim();
  const sanitizedFileName = baseName.replace(/[^a-zA-Z0-9._-]/g, "_");

  if (!sanitizedFileName || sanitizedFileName === "." || sanitizedFileName === "..") {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: { message: "Invalid fileName after sanitization" },
      }),
    };
  }

  // 3. Generate key: uploads/<uuid>-<sanitized fileName>
  const fileUuid = randomUUID();
  const s3Key = `uploads/${fileUuid}-${sanitizedFileName}`;

  try {
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(s3Client, command, {
      expiresIn: EXPIRES_IN,
    });

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        uploadUrl,
        s3Bucket: BUCKET_NAME,
        s3Key,
        expiresIn: EXPIRES_IN,
      }),
    };
  } catch (err) {
    console.error("Failed to generate presigned upload URL:", err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: { message: "Failed to generate presigned upload URL", detail: err.message },
      }),
    };
  }
};
