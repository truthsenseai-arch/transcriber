import http from "http";
import OpenAI from "openai";
import { writeFile } from "fs/promises";
import fs from "fs";

const hasKey = !!process.env.OPENAI_API_KEY;
console.log("BOOT: OPENAI_API_KEY present?", hasKey);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const server = http.createServer(async (req, res) => {
  console.log("REQ:", req.method, req.url);

  // Health check
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("TruthSense Transcriber OK");
  }

  // Transcribe endpoint
  if (req.method === "POST" && req.url === "/transcribe") {
    try {
      // Node http.IncomingMessage isn't a real Request body for formData()
      // So we wrap it in a Web Request and parse multipart via request.formData()
      const request = new Request(`http://localhost${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: req,
        duplex: "half", // REQUIRED in Node when body is a stream
      });

      const formData = await request.formData();
      const file = formData.get("file");

      if (!file) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "No file provided (expected form field 'file')" }));
      }

      console.log("REQ got file", { name: file.name, type: file.type, size: file.size });

      const buffer = Buffer.from(await file.arrayBuffer());
      console.log("REQ bytes length", buffer.length);

      // Write to tmp (Render allows /tmp)
      const path = `/tmp/audio-${Date.now()}.m4a`;
      await writeFile(path, buffer);

      const model = process.env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
      console.log("TRANSCRIBE model", model);

      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(path),
        model,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ text: transcription.text }));
    } catch (err) {
      console.error("TRANSCRIBE ERROR:", {
        message: err?.message,
        status: err?.status,
        code: err?.code,
        type: err?.type,
        response: err?.response?.data,
        stack: err?.stack,
      });

      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: err?.message || "Unknown error" }));
    }
  }

  // Fallback
  res.writeHead(404, { "Content-Type": "application/json" });
  return res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(process.env.PORT || 10000, () => {
  console.log("BOOT: listening on", process.env.PORT || 10000);
});
