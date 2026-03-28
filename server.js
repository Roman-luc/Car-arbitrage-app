const express = require("express");
const cors    = require("cors");
const path    = require("path");
const { exec } = require("child_process");
const { compareByMake } = require("./services");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.post("/api/compare-make", async (req, res) => {
  try {
    const input = req.body || {};
    if (!input.buyCountry || !input.sellCountry)
      return res.status(400).json({ status: "Buy country and sell country are required." });
    if (input.buyCountry === input.sellCountry)
      return res.status(400).json({ status: "Buy and sell countries must be different." });
    if (!input.make)
      return res.status(400).json({ status: "Make is required." });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    const emit = (type, message) => send(type, { message });

    const result = await compareByMake(input, emit);
    send("result", result);
    res.end();
  } catch (err) {
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ message: err.message || "Unexpected error." })}\n\n`);
      res.end();
    } catch {}
  }
});

// Proxy endpoint for Anthropic API — keeps API key server-side
// Set ANTHROPIC_API_KEY env var, or the call will fail with 401
app.post("/api/ai", async (req, res) => {
  try {
    const { prompt, max_tokens = 1200, apiKey: bodyKey } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "prompt required" });

    // Accept key from env var OR from request body (diagnostic tool passes it from UI)
    const apiKey = process.env.ANTHROPIC_API_KEY || bodyKey || "";
    if (!apiKey) return res.status(401).json({ error: "No API key. Set ANTHROPIC_API_KEY env var or paste key in diagnostic." });

    const headers = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": apiKey
    };

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json();
    res.status(response.ok ? 200 : response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("*", (_req, res) =>
  res.sendFile(path.join(__dirname, "..", "public", "index.html"))
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  Market Comparison running at ${url}\n`);

  // Auto-open browser using native OS command — no npm package needed
  const cmd = process.platform === "win32"  ? `start "" "${url}"` :
              process.platform === "darwin" ? `open "${url}"` :
                                              `xdg-open "${url}"`;
  exec(cmd, err => { if (err) console.log(`  Open ${url} in your browser.`); });
});
