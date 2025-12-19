import http from "http";
import fs from "fs";
import path from "path";
import { writeFile, unlink } from "fs/promises";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function text(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(body);
}

function guessExt(fileName, contentType) {
  const name = (fileName || "").toLowerCase();

  // If name already has a supported extension, keep it
  const ext = path.extname(name);
  if ([".m4a", ".mp3", ".wav", ".webm", ".mp4", ".ogg", ".flac"].includes(ext)) return ext;

  const ct = (contentType || "").toLowerCase();

  // Map common audio types to extensions
  if (ct.includes("audio/wav")) return ".wav";
  if (ct.includes("audio/x-wav")) return ".wav";
  if (ct.includes("audio/mpeg")) return ".mp3";
  if (ct.includes("audio/mp3")) return ".mp3";
  if (ct.includes("audio/webm")) return ".webm";
  if (ct.includes("video/webm")) return ".webm";
  if (ct.includes("audio/mp4")) return ".m4a";
  if (ct.includes("video/mp4")) return ".mp4";
  if (ct.includes("audio/ogg")) return ".ogg";
  if (ct.includes("audio/flac")) return ".flac";

  // If we can’t tell, default to m4a (works for most mobile uploads)
  return ".m4a";
}

async function readMultipartFile(req) {
  // Wrap Node req into a Web Request so we can use formData()
  const request = new Request("http://localhost" + req.url, {
    method: req.method,
    headers: req.headers,
    body: req,
    duplex: "half",
  });

  const formData = await request.formData();
  const file = formData.get("file");

  if (!file) {
    return { error: "No file provided (expected form field name 'file')" };
  }

  const fileName = file.name || "audio";
  const contentType = file.type || req.headers["content-type"] || "application/octet-stream";
  const ext = guessExt(fileName, contentType);

  const buf = Buffer.from(await file.arrayBuffer());

  return { buf, fileName, contentType, ext };
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const buf = Buffer.concat(chunks);
  return buf;
}

async function transcribeBuffer({ buf, fileName, contentType, ext, rid }) {
  // Write a temp file with a REAL extension (NOT .bin)
  const safeBase = (fileName || "audio").replace(/[^\w.-]+/g, "_").replace(/\.+/g, ".");
  const finalName = safeBase.endsWith(ext) ? safeBase : safeBase + ext;

  const tmpPath = `/tmp/${Date.now()}-${rid}-${finalName}`;
  await writeFile(tmpPath, buf);

  try {
    const model = process.env.TRANSCRIBE_MODEL || "gpt-4o-transcribe";
    console.log(`[${rid}] TRANSCRIBE start`, {
      model,
      bytes: buf.length,
      contentType,
      tmpPath,
      finalName,
    });

    // toFile() makes sure OpenAI sees a proper filename and type
    const upload = await toFile(fs.createReadStream(tmpPath), finalName, {
      type: contentType || "application/octet-stream",
    });

    const resp = await openai.audio.transcriptions.create({
      model,
      file: upload,
    });

    const outText = resp?.text || "";
    console.log(`[${rid}] TRANSCRIBE success`, { chars: outText.length });

    return { ok: true, text: outText };
  } finally {
    try {
      await unlink(tmpPath);
      console.log(`[${rid}] cleaned temp file`, tmpPath);
    } catch {}
  }
}

const server = http.createServer(async (req, res) => {
  const rid = Math.random().toString(16).slice(2, 8);

  try {
    console.log(`[${rid}] REQ`, { method: req.method, url: req.url, ct: req.headers["content-type"] });

    // Health check
    if (req.method === "GET" || req.method === "HEAD") {
      if (req.url === "/" || req.url === "/health") return text(res, 200, "TruthSense Transcriber OK");
      return json(res, 404, { error: "Not found" });
    }

    // Accept both routes
    const isTranscribeRoute =
      req.method === "POST" && (req.url === "/transcribe" || req.url === "/process");

    if (!isTranscribeRoute) {
      return json(res, 404, { error: "Not found" });
    }

    const ct = (req.headers["content-type"] || "").toLowerCase();

    let buf, fileName, contentType, ext;

    if (ct.includes("multipart/form-data")) {
      const parsed = await readMultipartFile(req);
      if (parsed.error) return json(res, 400, { error: parsed.error });

      ({ buf, fileName, contentType, ext } = parsed);
    } else {
      // Raw upload fallback
      buf = await readRawBody(req);
      if (!buf || buf.length === 0) return json(res, 400, { error: "Empty request body" });

      fileName = "audio";
      contentType = req.headers["content-type"] || "application/octet-stream";
      ext = guessExt(fileName, contentType);
    }

    const result = await transcribeBuffer({ buf, fileName, contentType, ext, rid });

    return json(res, 200, result);
  } catch (err) {
    console.error("PROCESS ERROR", {
      message: err?.message,
      stack: err?.stack,
    });
    return json(res, 500, { ok: false, error: err?.message || "Unknown error" });
  }
});

server.listen(process.env.PORT || 10000, () => {
  console.log("BOOT listening on", process.env.PORT || 10000);
  console.log("BOOT OPENAI_API_KEY present?", !!process.env.OPENAI_API_KEY);
  console.log("BOOT TRANSCRIBE_MODEL =", process.env.TRANSCRIBE_MODEL || "gpt-4o-transcribe");
});
