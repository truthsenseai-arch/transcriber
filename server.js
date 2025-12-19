import http from "http";
import OpenAI from "openai";
import { writeFile } from "fs/promises";
import fs from "fs";

const hasKey = !!process.env.OPENAI_API_KEY;
console.log("BOOT: OPENAI_API_KEY present?", hasKey);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const server = http.createServer(async (req, res) => {console.log("REQ:", req.method, req.url);
  if (req.method === "GET") {
    res.writeHead(200);
    return res.end("TruthSense Transcriber OK");
  }

  if (req.method === "POST" && req.url === "/transcribe") {
    try {
      const request = new Request(`http://localhost${req.url}`, {
  method: req.method,
  headers: req.headers,
  body: req,
  duplex: "half", // important on Node when body is a stream
});

const formData = await request.formData();
      const file = formData.get("file");

      if (!file) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "No file provided" }));
      }

      console.log("REQ: got file", {
        name: file.name,
        type: file.type,
        size: file.size,
      });

      const buffer = Buffer.from(await file.arrayBuffer());
      console.log("REQ: bytes length", buffer.length);

      const path = `/tmp/audio-${Date.now()}.m4a`;
      await writeFile(path, buffer);

      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(path),
        model: process.env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
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

  res.writeHead(404);
  res.end();
});

server.listen(process.env.PORT || 10000);
