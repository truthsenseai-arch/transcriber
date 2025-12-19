import http from "http";
import OpenAI from "openai";
import { writeFile } from "fs/promises";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const server = http.createServer(async (req, res) => {
  if (req.method === "GET") {
    res.writeHead(200);
    return res.end("TruthSense Transcriber OK");
  }

  if (req.method === "POST" && req.url === "/transcribe") {
    try {
      const formData = await req.formData();
      const file = formData.get("file");

      if (!file) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "No file provided" }));
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      const path = `/tmp/audio-${Date.now()}.m4a`;
      await writeFile(path, buffer);

      const transcription = await openai.audio.transcriptions.create({
        file: await import("fs").then(fs => fs.createReadStream(path)),
        model: "gpt-4o-mini-transcribe",
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ text: transcription.text }));
    } catch (err) {
      console.error("TRANSCRIBE ERROR:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  res.writeHead(404);
  res.end();
});

server.listen(process.env.PORT || 10000);
