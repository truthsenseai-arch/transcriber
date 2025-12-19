app.post("/transcribe", upload.single("file"), async (req, res) => {
  console.log("HIT /transcribe");

  try {
    console.log("Headers:", req.headers);
    console.log("File:", req.file);

    if (!req.file) {
      console.error("NO FILE RECEIVED");
      return res.status(400).json({ error: "No file uploaded" });
    }

    const stream = fs.createReadStream(req.file.path);

    console.log("Calling OpenAI...");

    const transcription = await openai.audio.transcriptions.create({
      file: stream,
      model: "gpt-4o-mini-transcribe",
    });

    console.log("Transcription success");

    res.json({ text: transcription.text });
  } catch (err) {
    console.error("TRANSCRIBE ERROR FULL:", err);
    res.status(500).json({
      error: err.message,
      name: err.name,
      stack: err.stack,
    });
  }
});
