const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = 3000;
const PUBLIC_DIR = path.resolve(__dirname);
const API_GATEWAY_HOST = "6yl1sp5oa7.execute-api.us-east-1.amazonaws.com";

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

const server = http.createServer((req, res) => {
  // 1. CORS Preflight & Local Reverse Proxy for /api/*
  if (req.method === "OPTIONS") {
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "*",
    });
    res.end();
    return;
  }

  // Reverse proxy /api/* to avoid local browser CORS restrictions
  if (req.url.startsWith("/api/")) {
    const targetPath = req.url.replace(/^\/api/, "");
    const options = {
      hostname: API_GATEWAY_HOST,
      port: 443,
      path: targetPath,
      method: req.method,
      headers: {
        ...req.headers,
        host: API_GATEWAY_HOST,
      },
    };

    delete options.headers["referer"];
    delete options.headers["origin"];

    const proxyReq = https.request(options, (proxyRes) => {
      const responseHeaders = {
        ...proxyRes.headers,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "*",
      };

      res.writeHead(proxyRes.statusCode, responseHeaders);
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on("error", (err) => {
      console.error("Proxy error:", err);
      res.writeHead(502, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify({ error: { message: "Bad Gateway to API Gateway", detail: err.message } }));
    });

    req.pipe(proxyReq, { end: true });
    return;
  }

  // 2. Static file serving
  let reqPath = req.url.split("?")[0];
  if (reqPath === "/") reqPath = "/index.html";

  const filePath = path.join(PUBLIC_DIR, reqPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`AuditLock Dashboard server listening at http://localhost:${PORT}`);
  console.log(`API Gateway proxy enabled at http://localhost:${PORT}/api/`);
});
