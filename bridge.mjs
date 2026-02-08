#!/usr/bin/env node
/**
 * Larksuite ↔ Moltbot Bridge (with Image Support)
 *
 * Receives messages from Larksuite via HTTP webhook,
 * forwards them to Moltbot Gateway, and sends the AI reply back.
 * Supports text and image messages.
 */

import * as lark from "@larksuiteoapi/node-sdk";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import WebSocket from "ws";

// ─── Config ──────────────────────────────────────────────────────

const APP_ID = process.env.LARKSUITE_APP_ID;
const APP_SECRET = process.env.LARKSUITE_APP_SECRET || tryReadFile(
  process.env.LARKSUITE_APP_SECRET_PATH || "~/.clawdbot/secrets/larksuite_app_secret"
);
const CLAWDBOT_CONFIG_PATH = resolve(process.env.CLAWDBOT_CONFIG_PATH || "~/.moltbot/moltbot.json");
const CLAWDBOT_AGENT_ID = process.env.CLAWDBOT_AGENT_ID || "main";
const THINKING_THRESHOLD_MS = Number(process.env.LARKSUITE_THINKING_THRESHOLD_MS ?? 2500);
const WEBHOOK_PORT = Number(process.env.LARKSUITE_WEBHOOK_PORT || 9000);
const ENCRYPT_KEY = process.env.LARKSUITE_ENCRYPT_KEY || "";
const VERIFICATION_TOKEN = process.env.LARKSUITE_VERIFICATION_TOKEN || "";
const MEDIA_DIR = resolve(process.env.LARKSUITE_MEDIA_DIR || "~/.clawdbot/media/larksuite");

// ─── Helpers ─────────────────────────────────────────────────────

function resolve(p) {
  return p.replace(/^~/, os.homedir());
}

function tryReadFile(filePath) {
  const resolved = resolve(filePath);
  if (!fs.existsSync(resolved)) return null;
  return fs.readFileSync(resolved, "utf8").trim() || null;
}

function mustRead(filePath, label) {
  const resolved = resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`[FATAL] ${label} not found: ${resolved}`);
    process.exit(1);
  }
  const val = fs.readFileSync(resolved, "utf8").trim();
  if (!val) {
    console.error(`[FATAL] ${label} is empty: ${resolved}`);
    process.exit(1);
  }
  return val;
}

const uuid = () => crypto.randomUUID();

// Ensure media directory exists
if (!fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

// ─── AES Decrypt for Larksuite ───────────────────────────────────

function decryptAES(encryptKey, encryptedData) {
  const key = crypto.createHash('sha256').update(encryptKey).digest();
  const encryptedBuffer = Buffer.from(encryptedData, 'base64');
  const iv = encryptedBuffer.slice(0, 16);
  const encrypted = encryptedBuffer.slice(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encrypted);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString('utf8');
}

// ─── Load secrets & config ───────────────────────────────────────

if (!APP_ID) {
  console.error("[FATAL] LARKSUITE_APP_ID environment variable is required");
  process.exit(1);
}

if (!APP_SECRET) {
  console.error("[FATAL] LARKSUITE_APP_SECRET not found");
  process.exit(1);
}

const clawdConfig = JSON.parse(mustRead(CLAWDBOT_CONFIG_PATH, "Moltbot config"));

const GATEWAY_PORT = clawdConfig?.gateway?.port || 18789;
const GATEWAY_TOKEN = clawdConfig?.gateway?.auth?.token;

if (!GATEWAY_TOKEN) {
  console.error("[FATAL] gateway.auth.token missing in Moltbot config");
  process.exit(1);
}

console.log(`[CONFIG] Encrypt Key: ${ENCRYPT_KEY ? "SET" : "NOT SET"}`);
console.log(`[CONFIG] Verification Token: ${VERIFICATION_TOKEN ? "SET" : "NOT SET"}`);
console.log(`[CONFIG] Media Dir: ${MEDIA_DIR}`);

// ─── Larksuite SDK setup ─────────────────────────────────────────

const sdkConfig = {
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain: lark.Domain.Lark,
  appType: lark.AppType.SelfBuild,
};

const client = new lark.Client(sdkConfig);

// ─── Dedup ───────────────────────────────────────────────────────

const seen = new Map();
const SEEN_TTL_MS = 10 * 60 * 1000;

// Session reset overrides: chatId → suffix (used to create new sessionKey)
const sessionOverrides = new Map();

function isDuplicate(messageId) {
  const now = Date.now();
  for (const [k, ts] of seen) {
    if (now - ts > SEEN_TTL_MS) seen.delete(k);
  }
  if (!messageId) return false;
  if (seen.has(messageId)) return true;
  seen.set(messageId, now);
  return false;
}

// ─── Image Handling ──────────────────────────────────────────────

async function downloadImage(messageId, imageKey) {
  try {
    const response = await client.im.messageResource.get({
      path: { message_id: messageId, file_key: imageKey },
      params: { type: "image" },
    });
    
    const filename = `${imageKey}.png`;
    const filepath = path.join(MEDIA_DIR, filename);
    
    // Lark SDK returns { writeFile, getReadableStream, headers }
    if (typeof response?.writeFile === 'function') {
      await response.writeFile(filepath);
    } else if (typeof response?.getReadableStream === 'function') {
      const stream = await response.getReadableStream();
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(filepath);
        stream.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
      });
    } else if (response?.data) {
      fs.writeFileSync(filepath, Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data));
    } else {
      console.error(`[ERROR] Unknown response format for image ${imageKey}:`, Object.keys(response || {}));
      return null;
    }
    
    const size = fs.statSync(filepath).size;
    console.log(`[IMAGE] Downloaded: ${filepath} (${size} bytes)`);
    if (size === 0) {
      console.error(`[ERROR] Downloaded image is empty: ${filepath}`);
      fs.unlinkSync(filepath);
      return null;
    }
    return filepath;
  } catch (e) {
    console.error("[ERROR] Failed to download image:", e.message);
  }
  return null;
}

async function uploadImage(imagePath) {
  try {
    const imageBuffer = fs.readFileSync(imagePath);
    const response = await client.im.image.create({
      data: {
        image_type: "message",
        image: imageBuffer,
      },
    });
    
    if (response?.data?.image_key) {
      console.log(`[IMAGE] Uploaded: ${response.data.image_key}`);
      return response.data.image_key;
    }
  } catch (e) {
    console.error("[ERROR] Failed to upload image:", e.message);
  }
  return null;
}

async function sendImageMessage(chatId, imageKey, altText = "") {
  try {
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "image",
        content: JSON.stringify({ image_key: imageKey }),
      },
    });
    console.log(`[IMAGE] Sent image to ${chatId}`);
    return true;
  } catch (e) {
    console.error("[ERROR] Failed to send image:", e.message);
    return false;
  }
}

// ─── Talk to Moltbot Gateway ─────────────────────────────────────

async function askMoltbot({ text, sessionKey, mediaPath }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${GATEWAY_PORT}`);
    let runId = null;
    let buf = "";
    let mediaUrls = [];
    const close = () => { try { ws.close(); } catch {} };

    ws.on("error", (e) => { close(); reject(e); });

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === "event" && msg.event === "connect.challenge") {
        ws.send(JSON.stringify({
          type: "req",
          id: "connect",
          method: "connect",
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: { id: "gateway-client", version: "0.2.0", platform: "macos", mode: "backend" },
            role: "operator",
            scopes: ["operator.read", "operator.write"],
            auth: { token: GATEWAY_TOKEN },
            locale: "en-US",
            userAgent: "larksuite-moltbot-bridge",
          },
        }));
        return;
      }

      if (msg.type === "res" && msg.id === "connect") {
        if (!msg.ok) { close(); reject(new Error(msg.error?.message || "connect failed")); return; }
        
        const params = {
          message: text || "",
          sessionKey,
          deliver: false,
          idempotencyKey: uuid(),
        };
        
        // Copy image to workspace so agent can read it via image tool
        if (mediaPath) {
          try {
            const imgName = `lark_${Date.now()}_${path.basename(mediaPath)}`;
            const workspacePath = `/Users/thx/.clawdbot/workspace/media/inbound/${imgName}`;
            const workspaceDir = path.dirname(workspacePath);
            if (!fs.existsSync(workspaceDir)) fs.mkdirSync(workspaceDir, { recursive: true });
            fs.copyFileSync(mediaPath, workspacePath);
            const size = fs.statSync(workspacePath).size;
            console.log(`[IMAGE] Copied to workspace: ${workspacePath} (${size} bytes)`);
            if (size > 0) {
              params.message = (params.message || "") + `\n\n[用戶傳送了一張圖片，請用 image tool 讀取: ${workspacePath}]`;
            }
            if (!params.message) params.message = "(image)";
          } catch (e) {
            console.error("[ERROR] Failed to copy image to workspace:", e.message);
          }
        }
        
        ws.send(JSON.stringify({
          type: "req",
          id: "chat-send",
          method: "chat.send",
          params,
        }));
        return;
      }

      if (msg.type === "res" && msg.id === "chat-send") {
        if (!msg.ok) { close(); reject(new Error(msg.error?.message || "chat.send failed")); return; }
        if (msg.payload?.runId) runId = msg.payload.runId;
        return;
      }

      // Listen for chat events (chat.send uses "chat" event stream)
      if (msg.type === "event" && (msg.event === "agent" || msg.event === "chat")) {
        const p = msg.payload;
        if (!p || (runId && p.runId !== runId)) return;

        if (p.stream === "assistant") {
          const d = p.data || {};
          if (typeof d.text === "string") buf = d.text;
          else if (typeof d.delta === "string") buf += d.delta;
          if (d.mediaUrls) mediaUrls = d.mediaUrls;
          return;
        }

        if (p.stream === "lifecycle") {
          if (p.data?.phase === "end") { close(); resolve({ text: buf.trim(), mediaUrls }); }
          if (p.data?.phase === "error") { close(); reject(new Error(p.data?.message || "agent error")); }
        }
      }
    });
  });
}

// ─── Group chat intelligence ─────────────────────────────────────

function shouldRespondInGroup(text, mentions) {
  if (mentions.length > 0) return true;
  const t = text.toLowerCase();
  if (/[？?]$/.test(text)) return true;
  if (/\b(why|how|what|when|where|who|help)\b/.test(t)) return true;
  const verbs = ["帮", "麻烦", "请", "能否", "可以", "解释", "看看", "排查", "分析", "总结", "写", "改", "修", "查", "对比", "翻译"];
  if (verbs.some(k => text.includes(k))) return true;
  if (/^(moltbot|bot|assistant|助手|智能体|小机)[\s,:，：]/i.test(text)) return true;
  return false;
}

// ─── Message Handler ─────────────────────────────────────────────

async function handleMessage(data) {
  try {
    const { message } = data;
    const chatId = message?.chat_id;
    const messageId = message?.message_id;
    if (!chatId) return;

    if (isDuplicate(messageId)) { console.log(`[DEDUP] Skipping duplicate ${messageId}`); return; }

    const messageType = message?.message_type;
    console.log(`[DEBUG] chat=${chatId} type=${messageType} chat_type=${message?.chat_type}`);
    let text = "";
    let mediaPath = null;

    // Handle text messages
    if (messageType === "text" && message?.content) {
      try {
        text = (JSON.parse(message.content)?.text || "").trim();
      } catch {}
    }
    // Handle image messages
    else if (messageType === "image" && message?.content) {
      try {
        const content = JSON.parse(message.content);
        const imageKey = content?.image_key;
        if (imageKey) {
          mediaPath = await downloadImage(messageId, imageKey);
          text = "[收到圖片]";
        }
      } catch {}
    }
    // Handle post (rich text) messages
    else if (messageType === "post" && message?.content) {
      try {
        const content = JSON.parse(message.content);
        // Collect image keys from post
        const postImageKeys = [];
        const extractText = (node) => {
          if (!node) return "";
          if (typeof node === "string") return node;
          if (node.tag === "text") return node.text || "";
          if (node.tag === "a") return node.text || node.href || "";
          if (node.tag === "at") return "";
          if (node.tag === "img") {
            if (node.image_key) postImageKeys.push(node.image_key);
            return "[圖片]";
          }
          if (Array.isArray(node)) return node.map(extractText).join("");
          if (node.content) return node.content.map(line => 
            (Array.isArray(line) ? line.map(extractText).join("") : extractText(line))
          ).join("\n");
          return "";
        };
        // post content can be { zh_cn: { title, content }, en_us: ... } or { title, content }
        const post = content.zh_cn || content.zh_tw || content.en_us || content;
        const title = post.title || "";
        const body = (post.content || []).map(line =>
          (Array.isArray(line) ? line.map(extractText).join("") : "")
        ).join("\n");
        text = (title ? title + "\n" : "") + body;
        text = text.trim();
        // Download first image from post if any
        if (postImageKeys.length > 0 && !mediaPath) {
          for (const imgKey of postImageKeys) {
            try {
              mediaPath = await downloadImage(messageId, imgKey);
              console.log(`[IMAGE] Extracted from post: ${imgKey}`);
              break; // take first image
            } catch (e) {
              console.error(`[ERROR] Failed to download post image ${imgKey}:`, e.message);
            }
          }
        }
      } catch {}
    }
    // Handle other message types
    else {
      console.log(`[SKIP] Unsupported message type: ${messageType}`);
      return;
    }

    if (!text && !mediaPath) return;

    if (message?.chat_type === "group") {
      const mentions = Array.isArray(message?.mentions) ? message.mentions : [];
      text = text.replace(/@_user_\d+\s*/g, "").trim();
      if (!text && !mediaPath) return;
      if (!mediaPath && !shouldRespondInGroup(text, mentions)) return;
    }

    // Handle /reset command — start a new session
    if (text.trim().toLowerCase() === "/reset") {
      const newSuffix = Date.now().toString(36);
      sessionOverrides.set(chatId, newSuffix);
      console.log(`[RESET] Session reset for ${chatId} → suffix: ${newSuffix}`);
      await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: "✅ Session 已重置，開始新對話。" }) },
      });
      return;
    }

    // Handle /status command — show current session info
    if (text.trim().toLowerCase() === "/status") {
      const suffix = sessionOverrides.get(chatId);
      const sk = suffix ? `larksuite:${chatId}:${suffix}` : `larksuite:${chatId}`;
      await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: `📊 Session: ${sk}\nChat: ${chatId}\nType: ${message?.chat_type || "unknown"}` }) },
      });
      return;
    }

    const suffix = sessionOverrides.get(chatId);
    const sessionKey = suffix ? `larksuite:${chatId}:${suffix}` : `larksuite:${chatId}`;
    console.log(`[MSG] Received: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}" from ${chatId}${mediaPath ? ' (with image)' : ''}`);

    let placeholderId = "";
    let done = false;

    const timer = THINKING_THRESHOLD_MS > 0
      ? setTimeout(async () => {
          if (done) return;
          try {
            const res = await client.im.message.create({
              params: { receive_id_type: "chat_id" },
              data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: "Thinking…" }) },
            });
            placeholderId = res?.data?.message_id || "";
          } catch {}
        }, THINKING_THRESHOLD_MS)
      : null;

    let reply = { text: "", mediaUrls: [] };
    try {
      reply = await askMoltbot({ text, sessionKey, mediaPath });
    } catch (e) {
      reply = { text: `(System error) ${e?.message || String(e)}`, mediaUrls: [] };
    } finally {
      done = true;
      if (timer) clearTimeout(timer);
    }

    const trimmed = (reply.text || "").trim();
    if (!trimmed || trimmed === "NO_REPLY" || trimmed.endsWith("NO_REPLY")) {
      if (placeholderId) {
        try {
          await client.im.message.delete({ path: { message_id: placeholderId } });
        } catch {}
      }
      return;
    }

    // Send text reply
    if (placeholderId) {
      try {
        await client.im.message.patch({
          path: { message_id: placeholderId },
          data: { content: JSON.stringify({ text: trimmed }) },
        });
      } catch {
        await client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: trimmed }) },
        });
      }
    } else {
      await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: trimmed }) },
      });
    }

    // Send images if any
    if (reply.mediaUrls && reply.mediaUrls.length > 0) {
      for (const url of reply.mediaUrls) {
        try {
          // Download image from URL and upload to Larksuite
          const tempPath = path.join(MEDIA_DIR, `temp_${uuid()}.png`);
          await downloadUrl(url, tempPath);
          const imageKey = await uploadImage(tempPath);
          if (imageKey) {
            await sendImageMessage(chatId, imageKey);
          }
          // Clean up temp file
          try { fs.unlinkSync(tempPath); } catch {}
        } catch (e) {
          console.error("[ERROR] Failed to send image:", e.message);
        }
      }
    }

    console.log(`[MSG] Sent reply to ${chatId}`);
  } catch (e) {
    console.error("[ERROR] message handler:", e);
  }
}

// Download URL to file
async function downloadUrl(url, destPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    protocol.get(url, (response) => {
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

// ─── HTTP Webhook Server ─────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, appId: APP_ID }));
    return;
  }

  // Only accept POST
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method Not Allowed");
    return;
  }

  // Read body
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const bodyBuffer = Buffer.concat(chunks);
  const bodyText = bodyBuffer.toString("utf8");

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Invalid JSON");
    return;
  }

  // Handle encrypted data
  if (body?.encrypt && ENCRYPT_KEY) {
    try {
      const decrypted = decryptAES(ENCRYPT_KEY, body.encrypt);
      body = JSON.parse(decrypted);
      console.log("[INFO] Decrypted request successfully");
    } catch (e) {
      console.error("[ERROR] Failed to decrypt:", e.message);
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Decryption failed");
      return;
    }
  }

  // URL verification challenge
  if (body?.type === "url_verification") {
    console.log("[INFO] URL verification challenge received");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ challenge: body.challenge }));
    return;
  }

  // Verify token if configured
  if (VERIFICATION_TOKEN && body?.token && body.token !== VERIFICATION_TOKEN) {
    console.warn("[WARN] Token mismatch");
    res.writeHead(401, { "Content-Type": "text/plain" });
    res.end("Invalid token");
    return;
  }

  // Handle event
  if (body?.event) {
    const eventType = body?.header?.event_type || body?.event?.type;
    console.log(`[EVENT] ${eventType}`);
    
    if (eventType === "im.message.receive_v1") {
      // Process async
      setImmediate(() => handleMessage(body.event));
    }
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
});

// ─── Start ───────────────────────────────────────────────────────

server.listen(WEBHOOK_PORT, () => {
  console.log(`[OK] Larksuite bridge started (with image support)`);
  console.log(`    App ID: ${APP_ID}`);
  console.log(`    Webhook: http://localhost:${WEBHOOK_PORT}`);
  console.log(`    Gateway: ws://127.0.0.1:${GATEWAY_PORT}`);
  console.log(`    Agent: ${CLAWDBOT_AGENT_ID}`);
  console.log("");
  console.log("Waiting for messages from Larksuite...");
});
