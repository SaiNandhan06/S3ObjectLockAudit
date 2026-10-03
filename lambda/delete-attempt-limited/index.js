// POST /records/{id}/delete-attempt
// Execution Role: lambda-dashboard-role (no bypass permissions)
// Environment variables: RECORDS_TABLE=AuditRecords, EVENTS_TABLE=RetentionEvents, ATTEMPT_BYPASS=false

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
const ATTEMPT_BYPASS = false; // Limited delete never requests bypass

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

  // 2. Validate path parameter
  const recordId = event.pathParameters && event.pathParameters.id;
  if (!recordId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: { message: "Missing record id in path" } }),
    };
  }

  // 3. Retrieve record metadata from DynamoDB
  const recordResult = await ddb.send(new GetCommand({ TableName: RECORDS_TABLE, Key: { recordId } }));
  const record = recordResult.Item;
  if (!record) {
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: { message: "Record not found" } }),
    };
  }

  // 4. Log the delete attempt with real githubLogin actor
  await logEvent(recordId, "DELETE_ATTEMPTED", githubLogin, "PENDING", `bypassRequested=${ATTEMPT_BYPASS}`);

  // 5. Attempt delete on S3 without bypass (expected to fail with AccessDenied while locked)
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
      "DELETE_SUCCEEDED",
      githubLogin,
      "ALLOWED",
      "S3 accepted the delete request"
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
