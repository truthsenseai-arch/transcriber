// server.js
import http from "http";
import OpenAI from "openai";
import fs from "fs";
import { writeFile, unlink } from "fs/promises";

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";

console.log("[BOOT] OPENAI_API_KEY present?", !!OPENAI_API_KEY);
console.log("[BOOT] TRANSCRIBE_MODEL:", TRANSCRIBE_MODEL);

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

function json(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST,GET,HEAD,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(obj));
}

function text(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "text/plain",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function safeStr(v) {
  try {
    if (typeof v === "string") return v;
    if (v == null) return "";
    return String(v);
  } catch {
    return "";
  }
}

function inferExt(ct) {
  const c = (ct || "").toLowerCase();
  if (c.includes("audio/mpeg") || c.includes("audio/mp3")) return "mp3";
  if (c.includes("audio/wav")) return "wav";
  if (c.includes("audio/webm")) return "webm";
  if (c.includes("audio/ogg")) return "ogg";
  if (c.includes("audio/flac")) return "flac";
  if (c.includes("audio/mp4") || c.includes("audio/m4a") || c.includes("audio/aac")) return "m4a";
  return "m4a";
}

const server = http.createServer(async (req, res) => {
  const ct = req.headers["content-type"];
  const cl = req.headers["content-length"];
  console.log("REQ:", req.method, req.url, "CT:", ct, "CL:", cl);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    return res.end();
  }

  // Health checks
  if (req.method === "GET" || req.method === "HEAD") {
    if (req.url === "/" || req.url === "/healthz") return text(res, 200, "TruthSense Transcriber OK");
    if (req.url === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }
  }

  // Main endpoint
  if (req.method === "POST" && req.url === "/transcribe") {
    if (!OPENAI_API_KEY) return json(res, 500, { error: "OPENAI_API_KEY missing on server" });

    let tmpPath = null;

    try {
      console.log("TRANSCRIBE: start");
      console.log("TRANSCRIBE: using model:", TRANSCRIBE_MODEL);

      // Convert Node req into a Web Request so we can use formData() for multipart
      const webReq = new Request(`http://localhost${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: req,
        duplex: "half",
      });

      const contentType = safeStr(ct).toLowerCase();
      let audioBuffer;
      let fileName = null;
      let fileType = null;

      // Case 1: multipart/form-data (expects field name "file")
      if (contentType.includes("multipart/form-data")) {
        console.log("TRANSCRIBE: parsing multipart/form-data");
        const formData = await webReq.formData();
        const file = formData.get("file");

        if (!file) {
          return json(res, 400, {
            error: 'No file provided (expected form field name "file")',
            hint: 'Send multipart/form-data with field "file".',
          });
        }

        fileName = file.name;
        fileType = file.type;

        console.log("TRANSCRIBE: got multipart file:", { name: fileName, type: fileType, size: file.size });
        audioBuffer = Buffer.from(await file.arrayBuffer());
      } else {
        // Case 2: raw body (octet-stream or audio/*)
        console.log("TRANSCRIBE: parsing raw body");
        const ab = await webReq.arrayBuffer();
        audioBuffer = Buffer.from(ab);

        console.log("TRANSCRIBE: got raw body bytes:", { bytes: audioBuffer.length, ct: contentType || "(none)" });

        if (!audioBuffer.length) return json(res, 400, { error: "Empty request body" });
      }

      // Write to /tmp
      const ext = inferExt(fileType || contentType);
      tmpPath = `/tmp/audio-${Date.now()}.${ext}`;
      await writeFile(tmpPath, audioBuffer);
      console.log("TRANSCRIBE: wrote temp file:", tmpPath);

      // OpenAI transcription
      const t0 = Date.now();
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmpPath),
        model: TRANSCRIBE_MODEL,
      });

      const ms = Date.now() - t0;
      const outText = safeStr(transcription?.text);

      console.log("TRANSCRIBE: success:", { ms, chars: outText.length });

      // IMPORTANT: return BOTH "text" and "transcript" so Base44 can't miss it
      return json(res, 200, {
        text: outText || "",
        transcript: outText || "",
        segments: outText ? [{ start: 0, end: 0, text: outText }] : [],
        metadata: {
          service: "render-transcriber",
          model: TRANSCRIBE_MODEL,
          fileName: fileName || null,
          fileType: fileType || contentType || null,
          ms,
        },
      });
    } catch (err) {
      console.error("TRANSCRIBE ERROR:", {
        message: err?.message,
        status: err?.status,
        code: err?.code,
        type: err?.type,
        response: err?.response?.data,
        stack: err?.stack,
      });

      return json(res, 500, {
        error: err?.message || "Unknown error",
        status: err?.status || 500,
        code: err?.code || null,
        type: err?.type || null,
        details: err?.response?.data || null,
      });
    } finally {
      if (tmpPath) {
        try {
          await unlink(tmpPath);
          console.log("TRANSCRIBE: cleaned temp file:", tmpPath);
        } catch {}
      }
    }
  }

  return json(res, 404, { error: "Not found" });
});

server.listen(PORT, () => console.log("[BOOT] listening on", PORT));
