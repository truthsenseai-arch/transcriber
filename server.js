import http from "http";
import OpenAI from "openai";
import fs from "fs";
import { writeFile, unlink } from "fs/promises";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function text(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(body);
}

function nowId() {
  return Math.random().toString(16).slice(2, 8);
}

async function readBodyAsBuffer(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Parse multipart/form-data using WHATWG Request.formData()
 * (works in modern Node runtimes; requires duplex: 'half')
 */
async function parseMultipartToBuffer(req) {
  const request = new Request("http://localhost/transcribe", {
    method: "POST",
    headers: req.headers,
    body: req,
    duplex: "half",
  });

  const formData = await request.formData();
  const file = formData.get("file");
  if (!file) {
    return { error: `No file provided (expected form field name "file")` };
  }

  const ab = await file.arrayBuffer();
  const buf = Buffer.from(ab);
  const meta = {
    name: file.name,
    type: file.type,
    size: file.size,
  };
  return { buf, meta };
}

async function transcribeBufferToText({ buf, contentType, reqId }) {
  const model = process.env.TRANSCRIBE_MODEL || "gpt-4o-transcribe";
  const tmpPath = `/tmp/audio-${Date.now()}-${reqId}.bin`;

  const t0 = Date.now();
  await writeFile(tmpPath, buf);

  try {
    console.log(`[${reqId}] TRANSCRIBE start`, {
      model,
      bytes: buf.length,
      contentType,
      tmpPath,
    });

    const result = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model,
      // optional: you can add language or prompt later if needed
      // language: "en",
    });

    const outText = result?.text || "";
    console.log(`[${reqId}] TRANSCRIBE success`, {
      ms: Date.now() - t0,
      chars: outText.length,
    });

    return { text: outText, model, ms: Date.now() - t0 };
  } finally {
    try {
      await unlink(tmpPath);
      console.log(`[${reqId}] cleaned temp file`, tmpPath);
    } catch {}
  }
}

async function analyzeTranscript({ transcript, reqId }) {
  const analysisModel = process.env.ANALYSIS_MODEL || "gpt-5.2"; // change if you prefer
  const t0 = Date.now();

  console.log(`[${reqId}] ANALYZE start`, { chars: transcript.length, analysisModel });

  // Keep this structured so your UI can render it reliably
  const prompt = `
You are TruthSense. Analyze the transcript for communication dynamics.
Return STRICT JSON with this exact shape:

{
  "summary": string,
  "key_points": string[],
  "emotions": {"label": string, "confidence": number, "evidence": string}[],
  "credibility_risks": {"label": string, "severity": "low"|"medium"|"high", "evidence": string}[],
  "manipulation_patterns": {"label": string, "severity": "low"|"medium"|"high", "evidence": string}[],
  "consistency_notes": string[],
  "recommended_questions": string[]
}

Rules:
- Do NOT claim certainty. Use probability language.
- Evidence must quote short phrases from the transcript (no long blocks).
Transcript:
"""${transcript}"""
`.trim();

  const resp = await openai.responses.create({
    model: analysisModel,
    input: prompt,
    // If your model supports structured outputs in your setup, you can enforce JSON more strongly.
  });

  const outText =
    resp.output_text ||
    (resp.output?.[0]?.content?.[0]?.text ?? "");

  // Try to parse; if parsing fails, return raw text too
  let parsed = null;
  try {
    parsed = JSON.parse(outText);
  } catch {}

  console.log(`[${reqId}] ANALYZE done`, { ms: Date.now() - t0, parsed: !!parsed });

  return {
    analysis: parsed || null,
    analysis_raw: parsed ? null : outText,
    analysis_model: analysisModel,
    analysis_ms: Date.now() - t0,
  };
}

const server = http.createServer(async (req, res) => {
  const reqId = nowId();
  const ct = (req.headers["content-type"] || "").toLowerCase();
  const url = req.url || "/";
  const method = req.method || "GET";

  console.log(`[${reqId}] REQ`, { method, url, ct });

  // Health
  if ((method === "GET" || method === "HEAD") && (url === "/" || url === "/healthz")) {
    return text(res, 200, "TruthSense Transcriber OK");
  }

  // TRANSCRIBE ONLY
  if (method === "POST" && url === "/transcribe") {
    try {
      let buf, meta;

      if (ct.includes("multipart/form-data")) {
        console.log(`[${reqId}] parsing multipart`);
        const parsed = await parseMultipartToBuffer(req);
        if (parsed.error) return json(res, 400, { error: parsed.error });
        buf = parsed.buf;
        meta = parsed.meta;
        console.log(`[${reqId}] got multipart file`, meta);
      } else if (ct.includes("application/json")) {
        const raw = await readBodyAsBuffer(req);
        const body = JSON.parse(raw.toString("utf8") || "{}");
        if (!body.file_url) return json(res, 400, { error: "Missing file_url" });

        console.log(`[${reqId}] fetching file_url`);
        const r = await fetch(body.file_url);
        if (!r.ok) return json(res, 400, { error: `file_url fetch failed`, status: r.status });
        const ab = await r.arrayBuffer();
        buf = Buffer.from(ab);
        meta = { name: "remote-audio", type: r.headers.get("content-type") || "application/octet-stream", size: buf.length };
      } else {
        // raw audio body
        console.log(`[${reqId}] reading raw body`);
        buf = await readBodyAsBuffer(req);
        meta = { name: "raw-audio", type: ct || "application/octet-stream", size: buf.length };
      }

      if (!buf || !buf.length) return json(res, 400, { error: "Empty audio buffer" });

      const t = await transcribeBufferToText({ buf, contentType: meta?.type || ct, reqId });
      return json(res, 200, { ok: true, ...t });
    } catch (err) {
      console.error(`[${reqId}] TRANSCRIBE ERROR`, {
        message: err?.message,
        status: err?.status,
        code: err?.code,
        response: err?.response?.data,
        stack: err?.stack,
      });
      return json(res, 500, { ok: false, error: err?.message || "Unknown error" });
    }
  }

  // ANALYZE ONLY
  if (method === "POST" && url === "/analyze") {
    try {
      const raw = await readBodyAsBuffer(req);
      const body = JSON.parse(raw.toString("utf8") || "{}");
      const transcript = body.transcript || body.text || "";
      if (!transcript) return json(res, 400, { ok: false, error: "Missing transcript/text" });

      const a = await analyzeTranscript({ transcript, reqId });
      return json(res, 200, { ok: true, ...a });
    } catch (err) {
      console.error(`[${reqId}] ANALYZE ERROR`, { message: err?.message, stack: err?.stack });
      return json(res, 500, { ok: false, error: err?.message || "Unknown error" });
    }
  }

  // BEST: TRANSCRIBE + ANALYZE IN ONE CALL
  if (method === "POST" && url === "/process") {
    try {
      let buf, meta;

      if (ct.includes("multipart/form-data")) {
        const parsed = await parseMultipartToBuffer(req);
        if (parsed.error) return json(res, 400, { ok: false, error: parsed.error });
        buf = parsed.buf;
        meta = parsed.meta;
      } else if (ct.includes("application/json")) {
        const raw = await readBodyAsBuffer(req);
        const body = JSON.parse(raw.toString("utf8") || "{}");
        if (!body.file_url) return json(res, 400, { ok: false, error: "Missing file_url" });
        const r = await fetch(body.file_url);
        if (!r.ok) return json(res, 400, { ok: false, error: `file_url fetch failed`, status: r.status });
        const ab = await r.arrayBuffer();
        buf = Buffer.from(ab);
        meta = { type: r.headers.get("content-type") || "application/octet-stream" };
      } else {
        buf = await readBodyAsBuffer(req);
        meta = { type: ct || "application/octet-stream" };
      }

      if (!buf || !buf.length) return json(res, 400, { ok: false, error: "Empty audio buffer" });

      const t = await transcribeBufferToText({ buf, contentType: meta?.type || ct, reqId });
      const transcript = t.text || "";

      const a = await analyzeTranscript({ transcript, reqId });

      return json(res, 200, {
        ok: true,
        transcript,
        transcript_model: t.model,
        transcript_ms: t.ms,
        ...a,
      });
    } catch (err) {
      console.error(`[${reqId}] PROCESS ERROR`, { message: err?.message, stack: err?.stack });
      return json(res, 500, { ok: false, error: err?.message || "Unknown error" });
    }
  }

  // Not found
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "Not found" }));
});

server.listen(process.env.PORT || 10000, () => {
  console.log("BOOT listening on", process.env.PORT || 10000);
  console.log("BOOT TRANSCRIBE_MODEL =", process.env.TRANSCRIBE_MODEL || "gpt-4o-transcribe");
  console.log("BOOT ANALYSIS_MODEL =", process.env.ANALYSIS_MODEL || "gpt-5.2");
});
