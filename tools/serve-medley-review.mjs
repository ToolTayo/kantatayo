import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EVIDENCE_REPORT_FILES, RUNTIME_REPORT_FILES } from "./medley-review-core.mjs";

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.dirname(TOOL_DIR);
const PORT = Number(process.env.KANTACUE_MEDLEY_REVIEW_PORT || 8766);
const ROUTES = new Map([
  ["/tools/medley-review.html", path.join(TOOL_DIR, "medley-review.html")],
  ["/tools/medley-review.css", path.join(TOOL_DIR, "medley-review.css")],
  ["/tools/medley-review.js", path.join(TOOL_DIR, "medley-review.js")],
  ["/tools/medley-review-core.mjs", path.join(TOOL_DIR, "medley-review-core.mjs")],
  ["/data/medleys.sample.json", path.join(ROOT_DIR, "data", "medleys.sample.json")],
  ["/data/songs.sample.json", path.join(ROOT_DIR, "data", "songs.sample.json")],
  ...[...RUNTIME_REPORT_FILES, ...EVIDENCE_REPORT_FILES, "medley-expansion-research-v5.json"].map((file) => [
    `/tools/${file}`,
    path.join(TOOL_DIR, file)
  ])
]);
const TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"]
]);

export async function handleMedleyReviewRequest(request, response) {
  const headers = {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; base-uri 'none'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-src https://www.youtube-nocookie.com https://www.youtube.com; frame-ancestors 'none'",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": 'autoplay=(self "https://www.youtube-nocookie.com" "https://www.youtube.com"), fullscreen=(self "https://www.youtube-nocookie.com" "https://www.youtube.com"), camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  };
  const method = request.method || "GET";
  if (method !== "GET" && method !== "HEAD") {
    response.writeHead(405, { ...headers, Allow: "GET, HEAD" });
    response.end();
    return;
  }
  const requestHost = request.headers?.host;
  if (requestHost) {
    let hostname;
    try { hostname = new URL(`http://${requestHost}`).hostname.toLowerCase(); } catch {
      response.writeHead(400, headers);
      response.end();
      return;
    }
    if (!new Set(["localhost", "127.0.0.1", "[::1]"]).has(hostname)) {
      response.writeHead(403, headers);
      response.end("Loopback host only");
      return;
    }
  }
  let pathname;
  try {
    pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  } catch {
    response.writeHead(400, headers);
    response.end();
    return;
  }
  const file = ROUTES.get(pathname);
  if (!file) {
    response.writeHead(404, headers);
    response.end("Not found");
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, { ...headers, "Content-Type": TYPES.get(path.extname(file)) || "application/octet-stream", "Content-Length": body.byteLength });
    response.end(method === "HEAD" ? undefined : body);
  } catch {
    response.writeHead(404, headers);
    response.end("Review source unavailable");
  }
}

export function createMedleyReviewServer() {
  return createServer(handleMedleyReviewRequest);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    console.error("KANTACUE_MEDLEY_REVIEW_PORT must be an integer between 1 and 65535.");
    process.exitCode = 1;
  } else {
    const server = createMedleyReviewServer();
    server.listen(PORT, "127.0.0.1", () => {
      console.log(`Local medley review workspace: http://127.0.0.1:${PORT}/tools/medley-review.html`);
      console.log("Loopback only; read-only static files; no production catalog writes.");
    });
  }
}
