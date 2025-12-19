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

function safeBaseName(name) {
  return (name || "audio")
    .replace(/[^\w.-]+/g, "_")
    .replace(/\.+/g, ".")
    .replace(/^_+/, "")
    .slice(0, 80);
}

function guessExt(fileName, contentType) {
  const name = (fileName || "").toLowerCase();
  const ext = path.extname(name);

  if ([".m4a", ".mp3", ".wav", ".webm", ".mp4", ".ogg", ".flac"].includes(ext)) return ext;

  const ct = (contentType || "").toLowerCase();
  if (ct.includes("audio/wav") || ct.includes("audio/x-wav")) return ".wav";
  if (ct.includes("audio/mpeg") || ct.includes("audio/mp3")) return ".mp3";
  if (ct.includes("audio/webm") || ct.includes("video/webm")) return ".webm";
  if (ct.includes("audio/mp4")) return ".m4a";
  if (ct.includes("video/mp4")) return ".mp4";
  if (ct.includes("audio/ogg")) return ".ogg";
  if (ct.includes("audio/flac")) return ".flac";

  // Default works for most mobile recordings
  return ".m4a";
}

async function readBodyBuffer(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readBodyBuffer(req);
  const raw = buf.toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readMultipart(req) {
  const request = new Request("http://localhost" + req.url, {
    method: req.method,
    headers: req.headers,
    body: req,
    duplex: "half",
  });

  const formData = await request.formData();
  const file = formData.get("file");

  if (!file) return { error: "No file provided (expected form field name 'file')" };

  const fileName = file.name || "audio";
  const contentType = file.type || "application/octet-stream";
  const ext = guessExt(fileName, contentType);
  const buf = Buffer.from(await file.arrayBuffer());

  return { buf, fileName, contentType, ext };
}

async function downloadFromUrl(file_url, rid) {
  const resp = await fetch(file_url);
  if (!resp.ok) {
    throw new Error(`Failed to download file_url (${resp.status})`);
  }

  const ct = resp.headers.get("content-type") || "application/octet-stream";
  const urlName = (() => {
    try {
      const u = new URL(file_url);
      const base = u.pathname.split("/").pop() || "audio";
      return base;
    } catch {
      return "audio";
    }
  })();

  const ab = await resp.arrayBuffer();
  const buf = Buffer.from(ab);

  return { buf, fileName: urlName, contentType: ct };
}

async function transcribeBuffer({ buf, fileName, contentType, rid }) {
  const ext = guessExt(fileName, contentType);

  // If Base gives "audio.bin", strip that junk so we don't end up with audio.bin.m4a
  let base = safeBaseName(fileName || "audio");
  base = base.replace(/\.bin$/i, "");

  const finalName = base.endsWith(ext) ? base : base + ext;

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

    const upload = await toFile(fs.createReadStream(tmpPath), finalName, {
      type: contentType || "application/octet-stream",
    });

    const resp = await openai.audio.transcriptions.create({
      model,
      file: upload,
    });

    const outText = resp?.text || "";
    console.log(`[${rid}] TRANSCRIBE success`, { chars: outText.length });

    return { text: outText, chars: outText.length, model };
  } finally {
    try {
      await unlink(tmpPath);
      console.log(`[${rid}] cleaned temp file`, tmpPath);
    } catch {}
  }
}

async function analyzeText({ transcript, rid }) {
  const model = process.env.ANALYSIS_MODEL || "gpt-4o-mini";

  // Keep it reliable + structured
  const prompt = `
You are TruthSense's analysis engine. Analyze the transcript for:
- emotional tone
- stress/pressure indicators
- evasiveness/avoidance patterns
- inconsistency risk (without claiming truth/lie)
Return STRICT JSON only with keys:
summary, tone, risks, notable_quotes, confidence_notes

Transcript:
${transcript}
`;

  console.log(`[${rid}] ANALYZE start`, { model, chars: transcript.length });

  // Uses Responses API style; if your SDK version doesn’t support it,
  // tell me and I’ll switch it to chat.completions format.
  const r = await openai.responses.create({
    model,
    input: prompt,
  });

  const out = (r.output_text || "").trim();
  console.log(`[${rid}] ANALYZE done`, { chars: out.length });

  return { model, raw: out };
}

const server = http.createServer(async (req, res) => {
  const rid = Math.random().toString(16).slice(2, 8);

  try {
    // Health check
    if (req.method === "GET" || req.method === "HEAD") {
      if (req.url === "/" || req.url === "/health") return text(res, 200, "TruthSense Transcriber OK");
      return json(res, 404, { error: "Not found" });
    }

    const isTranscribe = req.method === "POST" && req.url === "/transcribe";
    const isProcess = req.method === "POST" && req.url === "/process";

    if (!isTranscribe && !isProcess) return json(res, 404, { error: "Not found" });

    const ct = (req.headers["content-type"] || "").toLowerCase();

    let buf, fileName, contentType;

    // ✅ Recommended: JSON with file_url
    if (ct.includes("application/json")) {
      const body = await readJson(req);
      if (!body) return json(res, 400, { error: "Invalid JSON" });

      const file_url = body.file_url;
      if (!file_url) return json(res, 400, { error: "Missing file_url" });

      const dl = await downloadFromUrl(file_url, rid);
      buf = dl.buf;
      contentType = body.content_type || dl.contentType;
      fileName = body.file_name || dl.fileName;
    }
    // Multipart upload
    else if (ct.includes("multipart/form-data")) {
      const parsed = await readMultipart(req);
      if (parsed.error) return json(res, 400, { error: parsed.error });
      buf = parsed.buf;
      fileName = parsed.fileName;
      contentType = parsed.contentType;
    }
    // Raw body fallback
    else {
      buf = await readBodyBuffer(req);
      if (!buf || buf.length === 0) return json(res, 400, { error: "Empty request body" });

      fileName = "audio";
      contentType = req.headers["content-type"] || "application/octet-stream";
    }

    const t = await transcribeBuffer({ buf, fileName, contentType, rid });

    // /transcribe returns transcript only
    if (isTranscribe) {
      return json(res, 200, { ok: true, text: t.text, chars: t.chars, model: t.model });
    }

    // /process = transcript + analysis
    if (!t.text || t.text.trim().length < 10) {
      // Avoid Base crashing on tiny/empty transcript
      return json(res, 200, {
        ok: true,
        text: t.text,
        chars: t.chars,
        model: t.model,
        analysis: null,
        warning: "Transcript too short to analyze (likely bad upload or wrong file_url).",
      });
    }

    const a = await analyzeText({ transcript: t.text, rid });

    return json(res, 200, {
      ok: true,
      text: t.text,
      chars: t.chars,
      transcribe_model: t.model,
      analysis_model: a.model,
      analysis_raw: a.raw,
    });
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
  console.log("BOOT ANALYSIS_MODEL =", process.env.ANALYSIS_MODEL || "gpt-4o-mini");
});
