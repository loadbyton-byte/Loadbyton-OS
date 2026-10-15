// Self-hosted OCR sidecar. POST the raw file (Content-Type: application/pdf or image/*) to /ocr; the answer is {"text","pages"}.
// It shells out to poppler's pdftoppm and Tesseract, so document content never leaves the installation. Listens on an internal network only.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const MAX = 8 * 1024 * 1024, LANGS = process.env.OCR_LANGS || "eng+ara", MAX_PAGES = Number(process.env.OCR_MAX_PAGES || 5);
const run = (cmd, args, input) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
  let out = ""; const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("timeout")); }, 60_000);
  p.stdout.on("data", (d) => { out += d; if (out.length > 5_000_000) p.kill("SIGKILL"); });
  p.on("error", reject);
  p.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}`)); });
  p.stdin.end(input);
});
const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/bmp": "bmp", "image/tiff": "tif" };

async function recognise(buf, mime) {
  const dir = await mkdtemp(path.join(tmpdir(), "ocr-"));
  try {
    if (mime === "application/pdf") {
      await writeFile(path.join(dir, "in.pdf"), buf);
      await run("pdftoppm", ["-r", "200", "-l", String(MAX_PAGES), "-png", path.join(dir, "in.pdf"), path.join(dir, "p")]);
      const pages = (await readdir(dir)).filter((f) => f.startsWith("p") && f.endsWith(".png")).sort();
      const texts = [];
      for (const f of pages) texts.push((await run("tesseract", [path.join(dir, f), "stdout", "-l", LANGS])).trim());
      return { text: texts.filter(Boolean).join("\n"), pages: pages.length };
    }
    if (!ext[mime]) throw Object.assign(new Error("unsupported type"), { status: 415 });
    const f = path.join(dir, `in.${ext[mime]}`);
    await writeFile(f, buf);
    return { text: (await run("tesseract", [f, "stdout", "-l", LANGS])).trim(), pages: 1 };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") { res.writeHead(200).end("ok"); return; }
  if (req.method !== "POST" || req.url !== "/ocr") { res.writeHead(404).end(); return; }
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX) { res.writeHead(413).end(); req.destroy(); return; } chunks.push(c); }
  try {
    const out = await recognise(Buffer.concat(chunks), String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase());
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
  } catch (e) { res.writeHead(e.status || 422, { "content-type": "application/json" }).end(JSON.stringify({ error: "could not read this file" })); }
}).listen(Number(process.env.PORT || 8080), "0.0.0.0");
