import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const rootPrefix = root.endsWith(sep) ? root : root + sep;
const port = Number(process.env.KANTATAYO_PORT || 8765);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };

createServer(async (request, response) => {
  try {
    const requestPath = decodeURIComponent((request.url || "/").split("?")[0]);
    const relative = requestPath === "/" ? "index.html" : requestPath.replace(/^[/\\]+/, "");
    const file = normalize(join(root, relative));
    if (file !== root && !file.startsWith(rootPrefix)) { response.writeHead(403); response.end("Forbidden"); return; }
    const body = await readFile(file);
    response.writeHead(200, { "Content-Type": types[extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
    response.end(body);
  } catch { response.writeHead(404); response.end("Not found"); }
}).listen(port, "127.0.0.1", () => console.log(`KantaCue local server: http://127.0.0.1:${port}/`));
