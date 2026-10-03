// POST /records/{id}/delete-attempt-admin
// Execution Role: lambda-delete-admin-role (has s3:BypassGovernanceRetention)
// Environment variables: RECORDS_TABLE=AuditRecords, EVENTS_TABLE=RetentionEvents, ATTEMPT_BYPASS=true

const { randomUUID } = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, DeleteObjectCommand } = require("@aws-sdk/client-s3");

const REGION = process.env.AWS_REGION || "us-east-1";
const ddbClient = new DynamoDBClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(ddbClient);
const s3 = new S3Client({ region: REGION });

const RECORDS_TABLE = process.env.RECORDS_TABLE || "AuditRecords";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "RetentionEvents";
const ATTEMPT_BYPASS = process.env.ATTEMPT_BYPASS !== "false"; // Default true for admin override

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

async function logEvent(recordId, eventType, actor, outcome, detail) {
  const eventId = `${new Date().toISOString()}#${randomUUID().slice(0, 8)}`;
  await ddb.send(
    new PutCommand({
      TableName: EVENTS_TABLE,
      Item: {
        recordId,
        eventId,
        eventType,
        actor: actor || "unknown",
        outcome,
        detail: detail || "",
        occurredAt: new Date().toISOString(),
      },
    })
  );
}

exports.handler = async (event) => {
  // Support CORS preflight
  const httpMethod =
    (event.requestContext && event.requestContext.http && event.requestContext.http.method) ||
    event.httpMethod ||
    "";
  if (httpMethod.toUpperCase() === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ message: "OK" }) };
  }

  // 1. Read authorizer context (HTTP API Lambda authorizer simple-response context)
  const authorizer =
    (event.requestContext && event.requestContext.authorizer && event.requestContext.authorizer.lambda) ||
    (event.requestContext && event.requestContext.authorizer) ||
    {};

  const githubLogin = authorizer.githubLogin || "unknown";
  const role = authorizer.role || "user";

  // 2. SERVER-SIDE ROLE ENFORCEMENT (Prompt B5)
  // If role is not admin, reject immediately with 403 BEFORE attempting any S3 or DynamoDB action.
  if (role !== "admin") {
    console.warn(`Access denied: User '${githubLogin}' attempted admin override without 'admin' role.`);
    return {
      statusCode: 403,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: {
          message: "Forbidden: Admin override role required to bypass governance retention.",
          actor: githubLogin,
          role,
        },
      }),
    };
  }

  // 3. Validate path parameter
  const recordId = event.pathParameters && event.pathParameters.id;
  if (!recordId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: { message: "Missing record id in path" } }),
    };
  }

  // 4. Retrieve record metadata from DynamoDB
  const recordResult = await ddb.send(new GetCommand({ TableName: RECORDS_TABLE, Key: { recordId } }));
  const record = recordResult.Item;
  if (!record) {
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: { message: "Record not found" } }),
    };
  }

  // 5. Log the delete attempt with real githubLogin actor
  await logEvent(recordId, "DELETE_ATTEMPTED", githubLogin, "PENDING", `bypassRequested=${ATTEMPT_BYPASS}`);

  // 6. Attempt privileged bypass delete on S3
  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: record.s3Bucket,
        Key: record.s3Key,
        VersionId: record.s3VersionId,
        BypassGovernanceRetention: ATTEMPT_BYPASS,
      })
    );

    await logEvent(
      recordId,
      ATTEMPT_BYPASS ? "BYPASS_USED" : "DELETE_SUCCEEDED",
      githubLogin,
      "ALLOWED",
      "S3 accepted the delete request via authorized governance bypass"
    );

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ outcome: "DELETED", bypassUsed: ATTEMPT_BYPASS, actor: githubLogin }),
    };
  } catch (err) {
    const requestId = err.$metadata ? err.$metadata.requestId : "n/a";
    const detail = `${err.name || "Error"}: ${err.message || ""} (requestId: ${requestId})`;
    await logEvent(recordId, "DELETE_DENIED", githubLogin, "DENIED", detail);

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ outcome: "DENIED", reason: detail, actor: githubLogin }),
    };
  }
};
