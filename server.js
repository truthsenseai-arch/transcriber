// server.js
import http from "http";
import OpenAI from "openai";
import fs from "fs";
import { writeFile, unlink } from "fs/promises";

// ---------- Config ----------
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Use gpt-4o-mini-transcribe by default, but you can set TRANSCRIBE_MODEL=whisper-1 if you want.
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";

console.log("[BOOT] OPENAI_API_KEY present?", !!OPENAI_API_KEY);
console.log("[BOOT] TRANSCRIBE_MODEL:", TRANSCRIBE_MODEL);

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------- Helpers ----------
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

function inferExtFromContentType(ct) {
  const c = (ct || "").toLowerCase();
  if (c.includes("audio/mpeg") || c.includes("audio/mp3")) return "mp3";
  if (c.includes("audio/wav")) return "wav";
  if (c.includes("audio/webm")) return "webm";
  if (c.includes("audio/ogg")) return "ogg";
  if (c.includes("audio/mp4") || c.includes("audio/m4a") || c.includes("audio/aac")) return "m4a";
  if (c.includes("audio/flac")) return "flac";
  return "m4a";
}

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  const ct = req.headers["content-type"];
  const cl = req.headers["content-length"];

  // Basic request log
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
    if (req.url === "/" || req.url === "/healthz") {
      return text(res, 200, "TruthSense Transcriber OK");
    }
    if (req.url === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }
  }

  // Main endpoint
  if (req.method === "POST" && req.url === "/transcribe") {
    if (!OPENAI_API_KEY) {
      return json(res, 500, { error: "OPENAI_API_KEY missing on server" });
    }

    let tmpPath = null;

    try {
      const contentType = safeStr(ct).toLowerCase();
      console.log("TRANSCRIBE: start");
      console.log("TRANSCRIBE: using model:", TRANSCRIBE_MODEL);

      // Wrap Node request -> Web Request so we can do request.formData() on multipart
      const webReq = new Request(`http://localhost${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: req,
        duplex: "half", // REQUIRED in Node for streaming request bodies
      });

      let audioBuffer;
      let fileName = null;
      let fileType = null;

      if (contentType.includes("multipart/form-data")) {
        console.log("TRANSCRIBE: parsing multipart/form-data");
        const formData = await webReq.formData();

        // expects field name "file"
        const file = formData.get("file");
        if (!file) {
          return json(res, 400, {
            error: 'No file provided (expected form field name "file")',
            hint: 'Send multipart/form-data with field "file".',
          });
        }

        fileName = file.name;
        fileType = file.type;

        console.log("TRANSCRIBE: got multipart file:", {
          name: fileName,
          type: fileType,
          size: file.size,
        });

        audioBuffer = Buffer.from(await file.arrayBuffer());
      } else {
        // Raw body (octet-stream OR audio/*)
        console.log("TRANSCRIBE: parsing raw body");
        const ab = await webReq.arrayBuffer();
        audioBuffer = Buffer.from(ab);

        console.log("TRANSCRIBE: got raw body bytes:", {
          bytes: audioBuffer.length,
          ct: contentType || "(none)",
        });

        if (!audioBuffer.length) {
          return json(res, 400, { error: "Empty request body" });
        }
      }

      const ext = inferExtFromContentType(fileType || contentType);
      tmpPath = `/tmp/audio-${Date.now()}.${ext}`;

      await writeFile(tmpPath, audioBuffer);
      console.log("TRANSCRIBE: wrote temp file:", tmpPath);

      const t0 = Date.now();

      // OpenAI transcription
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmpPath),
        model: TRANSCRIBE_MODEL,
      });

      const ms = Date.now() - t0;
      const outText = safeStr(transcription?.text);

      console.log("TRANSCRIBE: success:", {
        ms,
        chars: outText.length,
      });

      // IMPORTANT: return the structure Base44 pipeline expects
      return json(res, 200, {
        transcript: outText || "",
        segments: outText ? [{ start: 0, end: 0, text: outText }] : [],
        audio_timeline: outText ? [{ start: 0, end: 0, text: outText }] : [],
        metadata: {
          service: "render-transcriber",
          model: TRANSCRIBE_MODEL,
          fileName: fileName || null,
          fileType: fileType || contentType || null,
          ms,
        },
      });
    } catch (err) {
      // Log deeply (Render logs)
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
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }

  // Fallback
  return json(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log("[BOOT] listening on", PORT);
});
