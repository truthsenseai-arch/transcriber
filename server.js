import http from "http";
import fs from "fs";
import path from "path";
import Busboy from "busboy";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/transcribe") {
    const busboy = Busboy({ headers: req.headers });
    let tempPath = null;

    busboy.on("file", (_, file, info) => {
      tempPath = `/tmp/audio-${Date.now()}.m4a`;
      const writeStream = fs.createWriteStream(tempPath);
      file.pipe(writeStream);
    });

    busboy.on("finish", async () => {
      if (!tempPath) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "No file provided" }));
      }

      try {
        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(tempPath),
          model: "gpt-4o-mini-transcribe",
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text: transcription.text }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      } finally {
        fs.unlink(tempPath, () => {});
      }
    });

    req.pipe(busboy);
    return;
  }

  // Health check
  res.writeHead(200);
  res.end("OK");
}).listen(process.env.PORT || 10000, () => {
  console.log("Transcriber running");
});
