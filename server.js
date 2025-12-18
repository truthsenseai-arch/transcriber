import express from "express";
import multer from "multer";
import OpenAI from "openai";

const app = express();
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.post("/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file provided" });
    }

    const transcription = await openai.audio.transcriptions.create({
      file: req.file.buffer,
      model: "gpt-4o-transcribe"
    });

    res.json({
      text: transcription.text
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Transcription failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Transcriber running on port ${PORT}`);
});
