import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import http from "node:http";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("./clinic-call.html", import.meta.url));
const model = process.env.DEMO_MODEL || "qwen3:1.7b";
const origin = "http://127.0.0.1:8765";
http.createServer(async (req, res) => {
  if (req.headers.host !== "127.0.0.1:8765") return res.writeHead(403).end();
  if (req.method === "GET" && req.url === "/") {
    return res.writeHead(200, {"Content-Type":"text/html; charset=utf-8"}).end(page);
  }
  if (req.method === "GET" && req.url === "/ready") {
    try {
      const check = await fetch("http://127.0.0.1:11434/api/show", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({model}), signal: AbortSignal.timeout(5000)
      });
      await check.body?.cancel();
      res.writeHead(check.ok ? 204 : 503, {"Cache-Control":"no-store"}).end();
    } catch {
      res.writeHead(503).end();
    }
    return;
  }
  if (req.method === "POST" && req.url === "/demo-voice" && req.headers.origin === origin) {
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 8192) return res.writeHead(413).end();
        chunks.push(chunk);
      }
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text || text.length > 1600) return res.writeHead(400).end();
      const hash = createHash("sha256").update(text).digest("hex");
      const clip = await readFile(new URL(`../../tmp/demo-repair/voice-clips/${hash}.mp3`, import.meta.url))
        .catch(error => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
      if (clip?.length) {
        return res.writeHead(200, {"Content-Type":"audio/mpeg","Cache-Control":"no-store"}).end(clip);
      }
      const python = fileURLToPath(new URL("../../tmp/demo-repair/tts/bin/python", import.meta.url));
      const script = fileURLToPath(new URL("./uzbek_voice.py", import.meta.url));
      const child = execFile(python, [script], {encoding:"buffer", timeout:45000, maxBuffer:16000000}, (err, wav) => {
        if (res.destroyed) return;
        if (err) return res.writeHead(503).end();
        res.writeHead(200, {"Content-Type":"audio/wav","Cache-Control":"no-store"}).end(wav);
      });
      res.on("close", () => { if (!res.writableEnded) child.kill(); });
      child.stdin.on("error", () => {});
      child.stdin.end(text);
    } catch {
      res.writeHead(503).end();
    }
    return;
  }
  if (req.method !== "POST" || req.url !== "/demo-chat" || req.headers.origin !== origin) {
    return res.writeHead(403).end();
  }
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 48000) return res.writeHead(413).end();
      chunks.push(chunk);
    }
    const messages = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!Array.isArray(messages) || messages.length > 42 || !messages.every(m =>
      m && ["user","assistant","system"].includes(m.role) && typeof m.content === "string")) {
      return res.writeHead(400).end();
    }
    const upstream = await fetch("http://127.0.0.1:11434/api/chat", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({model, messages, stream:false, think:false, options:{num_ctx:4096,num_predict:180}}),
      signal:AbortSignal.timeout(180000)
    });
    if (!upstream.ok) throw Error();
    const {message} = await upstream.json();
    if (!message?.content?.trim()) throw Error();
    res.writeHead(200, {"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store"}).end(message.content);
  } catch {
    res.writeHead(503).end();
  }
}).listen(8765,"127.0.0.1",()=>console.log(origin));
