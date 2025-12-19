import http from "http";
import OpenAI from "openai";
import fs from "fs";
import { writeFile } from "fs/promises";

const PORT = Number(process.env.PORT || 10000);
console.log("BOOT: OPENAI_API_KEY present?", !!process.env.OPENAI_API_KEY);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

async function readAll(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  console.log(
    "REQ:",
    req.method,
    req.url,
    "CT:",
    req.headers["content-type"],
    "CL:",
    req.headers["content-length"]
  );

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("TruthSense Transcriber OK");
  }

  if (req.method === "POST" && req.url === "/transcribe") {
    try {
      const ct = String(req.headers["content-type"] || "");
      if (!ct.includes("application/octet-stream")) {
        return json(res, 415, { error: "Expected application/octet-stream" });
      }

      const bytes = await readAll(req);
      console.log("REQ bytes length:", bytes.length);
      if (!bytes.length) return json(res, 400, { error: "Empty body" });

      const tmpPath = `/tmp/audio-${Date.now()}.m4a`;
      await writeFile(tmpPath, bytes);

      const model = process.env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
      console.log("TRANSCRIBE model:", model);

      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmpPath),
        model,
      });

      return json(res, 200, { text: transcription.text });
    } catch (err) {
      console.error("TRANSCRIBE ERROR:", {
        message: err?.message,
        status: err?.status,
        code: err?.code,
        response: err?.response?.data,
        stack: err?.stack,
      });
      return json(res, 500, { error: err?.message || "Unknown error" });
    }
  }

  return json(res, 404, { error: "Not found" });
});

server.listen(PORT, () => console.log("BOOT: listening on", PORT));
