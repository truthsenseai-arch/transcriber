import http from "http";
import OpenAI from "openai";
import { writeFile, unlink } from "fs/promises";
import fs from "fs";

const hasKey = !!process.env.OPENAI_API_KEY;
console.log("BOOT: OPENAI_API_KEY present?", hasKey);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function text(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const ct = req.headers["content-type"];
  const cl = req.headers["content-length"];
  console.log("REQ:", req.method, req.url, "CT:", ct, "CL:", cl);

  // Health check / root
  if (req.method === "GET" || req.method === "HEAD") {
    if (req.url === "/" || req.url === "/health") {
      return text(res, 200, "TruthSense Transcriber OK");
    }
    if (req.url === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }
  }

  // Only endpoint Base44 should call
  if (req.method === "POST" && req.url === "/transcribe") {
    let tmpPath = null;

    try {
      // Wrap Node req into a Web Request so we can use request.formData() when multipart
      const request = new Request(`http://localhost${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: req,
        duplex: "half", // REQUIRED in Node for streaming body
      });

      const contentType = (ct || "").toLowerCase();

      let audioBuffer;

      // Case 1: multipart/form-data (expects field name "file")
      if (contentType.includes("multipart/form-data")) {
        const formData = await request.formData();
        const file = formData.get("file");

        if (!file) {
          return json(res, 400, {
            error: 'No file provided (expected form field name "file")',
            hint: 'Send multipart/form-data with field "file".',
          });
        }

        console.log("REQ got multipart file:", {
          name: file.name,
          type: file.type,
          size: file.size,
        });

        audioBuffer = Buffer.from(await file.arrayBuffer());
      } else {
        // Case 2: raw body (octet-stream or audio/*)
        const ab = await request.arrayBuffer();
        audioBuffer = Buffer.from(ab);

        console.log("REQ got raw body bytes:", audioBuffer.length, "CT:", contentType);
        if (!audioBuffer.length) {
          return json(res, 400, { error: "Empty request body" });
        }
      }

      // Write to /tmp (Render allows /tmp)
      tmpPath = `/tmp/audio-${Date.now()}.m4a`;
      await writeFile(tmpPath, audioBuffer);

      const model = process.env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
      console.log("TRANSCRIBE using model:", model);

      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmpPath),
        model,
      });

      const outText = transcription?.text || "";
      console.log("TRANSCRIBE success, chars:", outText.length);

      return json(res, 200, { text: outText });
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
        status: err?.status,
        code: err?.code,
      });
    } finally {
      if (tmpPath) {
        try {
          await unlink(tmpPath);
        } catch {}
      }
    }
  }

  // Fallback
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(process.env.PORT || 10000, () => {
  console.log("BOOT: listening on", process.env.PORT || 10000);
});
