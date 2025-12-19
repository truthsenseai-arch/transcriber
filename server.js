import http from "http";
import OpenAI from "openai";
import { writeFile, unlink } from "fs/promises";
import fs from "fs";

/**
 * ---------------------------
 * Config
 * ---------------------------
 */
const hasKey = !!process.env.OPENAI_API_KEY;
console.log("BOOT: OPENAI_API_KEY present?", hasKey);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const DEFAULT_MODEL = process.env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";

/**
 * ---------------------------
 * Helpers
 * ---------------------------
 */
function json(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(obj));
}

function text(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "text/plain",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(body);
}

/**
 * Convert Node req to a WHATWG Request so we can call request.formData()
 * NOTE: Node needs duplex: "half" for streaming request bodies.
 */
function nodeReqToWebRequest(req) {
  return new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: req,
    duplex: "half",
  });
}

/**
 * ---------------------------
 * Server
 * ---------------------------
 */
const server = http.createServer(async (req, res) => {
  const ct = (req.headers["content-type"] || "").toLowerCase();
  const cl = req.headers["content-length"];
  const method = req.method || "GET";

  // Robust pathname parsing (fixes 404 caused by querystrings/trailing slash)
  const urlObj = new URL(req.url || "/", "http://localhost");
  const pathname = urlObj.pathname;

  console.log("REQ:", method, req.url, "PATH:", pathname, "CT:", ct, "CL:", cl);
  console.log("REQ RAW URL:", req.url);

  // CORS / preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    return res.end();
  }

  // Health checks
  if (method === "GET" || method === "HEAD") {
    if (pathname === "/" || pathname === "/health") {
      return text(res, 200, "TruthSense Transcriber OK");
    }
    if (pathname === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }
  }

  // Transcribe endpoint (accept /transcribe and /transcribe/)
  const isTranscribe =
    method === "POST" && (pathname === "/transcribe" || pathname === "/transcribe/");

  if (!isTranscribe) {
    return json(res, 404, { error: "Not found", pathname, method });
  }

  // Safety: no key = hard fail
  if (!process.env.OPENAI_API_KEY) {
    return json(res, 500, { error: "Missing OPENAI_API_KEY on server" });
  }

  let tmpPath = null;

  try {
    const request = nodeReqToWebRequest(req);

    console.log("TRANSCRIBE: start");
    console.log("TRANSCRIBE: using model:", DEFAULT_MODEL);

    let audioBuffer;

    // Case 1: multipart/form-data (expects field name "file")
    if (ct.includes("multipart/form-data")) {
      console.log("TRANSCRIBE: parsing multipart/form-data");
      const formData = await request.formData();
      const file = formData.get("file");

      if (!file) {
        return json(res, 400, {
          error: 'No file provided (expected form field name "file")',
          hint: 'Send multipart/form-data with field "file".',
        });
      }

      console.log("TRANSCRIBE: got multipart file", {
        name: file.name,
        type: file.type,
        size: file.size,
      });

      audioBuffer = Buffer.from(await file.arrayBuffer());
    } else {
      // Case 2: raw body (application/octet-stream or audio/*)
      console.log("TRANSCRIBE: reading raw body");
      const ab = await request.arrayBuffer();
      audioBuffer = Buffer.from(ab);

      console.log("TRANSCRIBE: raw body bytes:", audioBuffer.length, "CT:", ct);

      if (!audioBuffer.length) {
        return json(res, 400, { error: "Empty request body" });
      }
    }

    // Write temp file (Render allows /tmp)
    tmpPath = `/tmp/audio-${Date.now()}.m4a`;
    await writeFile(tmpPath, audioBuffer);
    console.log("TRANSCRIBE: wrote temp file:", tmpPath, "bytes:", audioBuffer.length);

    // Call OpenAI transcription
    const t0 = Date.now();
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: DEFAULT_MODEL,
    });
    const ms = Date.now() - t0;

    const outText = transcription?.text || "";
    console.log("TRANSCRIBE: success", { ms, chars: outText.length });

    return json(res, 200, { text: outText });
  } catch (err) {
    // Rich error logging
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
      status: err?.status,
      code: err?.code,
      type: err?.type,
    });
  } finally {
    if (tmpPath) {
      try {
        await unlink(tmpPath);
        console.log("TRANSCRIBE: cleaned temp file:", tmpPath);
      } catch {
        // ignore
      }
    }
  }
});

server.listen(process.env.PORT || 10000, () => {
  console.log("BOOT: listening on", process.env.PORT || 10000);
});
