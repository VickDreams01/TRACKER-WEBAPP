import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
const root = resolve(import.meta.dirname, "../frontend");
createServer(async (req, res) => {
  const path = decodeURIComponent(
    new URL(req.url, "http://localhost").pathname,
  );
  const file = resolve(
    root,
    "." + (path === "/" ? "/parcel-tracker.html" : path),
  );
  if (!file.startsWith(root + "/")) {
    res.writeHead(403).end();
    return;
  }
  try {
    const content = await readFile(file);
    res
      .writeHead(200, {
        "Content-Type":
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
          }[extname(file)] || "application/octet-stream",
        "Cache-Control": "no-store",
      })
      .end(content);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(Number(process.env.PORT || 8080), "127.0.0.1", () =>
  console.log("Tracker: http://localhost:" + (process.env.PORT || 8080)),
);
