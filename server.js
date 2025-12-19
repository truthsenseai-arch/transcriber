import express from "express";
import multer from "multer";
import fs from "fs";
import OpenAI from "openai";

const app = express();

// Multer temp storage (Render-compatible)
const upload = multer({
  dest: "/tmp",
});

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Health check
app.get("/", (req, res) => {
  res.send("TruthSense Transcriber OK");
});

// Transcription route
app.post("/transcribe", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file uploaded" });
    }

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: "gpt-4o-mini-transcribe",
    });

    res.json({ text: transcription.text });
  } catch (error) {
    console.error("Transcription error:", error);
    res.status(500).json({
      error: "Transcription failed",
      details: error.message,
    });
  }
});

// REQUIRED for Render
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Transcriber running on port ${PORT}`);
});
