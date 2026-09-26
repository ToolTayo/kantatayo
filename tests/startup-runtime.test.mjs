import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createReadStream, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { loadCatalog } from "../src/catalog.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8"
};

let server;
let baseUrl;

before(async () => {
  server = createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", "http://localhost");
    const relativePath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
    const filePath = resolve(root, `.${relativePath}`);
    if (!filePath.startsWith(`${root}${sep}`) || !isFile(filePath)) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream"
    });
    createReadStream(filePath).pipe(response);
  });

  await new Promise((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolveClosed) => server.close(resolveClosed));
});

test("production startup asset graph serves executable modules and a usable catalog", async () => {
  const indexResponse = await fetch(`${baseUrl}/index.html`);
  assert.equal(indexResponse.status, 200);
  assert.match(indexResponse.headers.get("content-type") || "", /text\/html/);
  const indexHtml = await indexResponse.text();
  const entryMatch = indexHtml.match(/<script\s+type="module"\s+src="([^"]+)"/i);
  assert.ok(entryMatch, "index.html must declare a module entry point");

  const pending = [new URL(entryMatch[1], `${baseUrl}/index.html`).href];
  const visited = new Set();
  while (pending.length > 0) {
    const moduleUrl = pending.shift();
    if (visited.has(moduleUrl)) continue;
    visited.add(moduleUrl);

    const moduleResponse = await fetch(moduleUrl);
    assert.equal(moduleResponse.status, 200, `module failed to load: ${moduleUrl}`);
    assert.match(moduleResponse.headers.get("content-type") || "", /javascript/, `module was not served as JavaScript: ${moduleUrl}`);
    const source = await moduleResponse.text();
    assert.doesNotMatch(source.trimStart(), /^<!doctype html/i, `module received an HTML fallback: ${moduleUrl}`);

    for (const specifier of getRelativeImports(source)) {
      pending.push(new URL(specifier, moduleUrl).href);
    }
  }

  assert.ok(visited.size >= 10, "the startup graph should include the application modules");

  const catalog = await loadCatalog(`${baseUrl}/data/songs.sample.json`, { logger: silentLogger });
  assert.equal(catalog.songs.length, 361);
  assert.equal(catalog.songs.filter((song) => song.youtubeVideoId).length, 361);
});

function getRelativeImports(source) {
  const imports = [];
  const pattern = /\bimport\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1].startsWith(".")) imports.push(match[1]);
  }
  return imports;
}

function isFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

const silentLogger = { error() {}, warn() {} };
