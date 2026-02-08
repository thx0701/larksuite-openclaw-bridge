# Larksuite ↔ OpenClaw Bridge

Larksuite Webhook bridge，將 Lark Bot 訊息轉發至 OpenClaw Gateway，並回傳 AI 回覆。

## 架構

```
Lark 用戶 → Lark Server → (HTTPS) → Cloudflare Tunnel
  → localhost:3000/webhook → bridge.mjs → (WebSocket) → OpenClaw Gateway :18789
  → AI 回覆 → bridge.mjs → Lark API → Lark 用戶
```

## 功能

| 功能 | 狀態 | 說明 |
|------|------|------|
| 純文字訊息 | ✅ | `text` 類型直接轉發 |
| 富文本訊息 (post) | ✅ | 提取文字 + 第一張圖片 |
| 圖片訊息 | ✅ | `image` 類型，下載後以 base64 attachment 送入 gateway |
| Post 內嵌圖片 | ✅ | 從 `img` tag 提取 `image_key`，下載並傳送 |
| 群組智慧回覆 | ✅ | @提及、問句、動詞觸發才回覆 |
| Thinking 佔位符 | ✅ | 超過 2.5 秒顯示「Thinking…」，完成後替換 |
| 去重 (Dedup) | ✅ | 10 分鐘內同 `message_id` 不重複處理 |
| 圖片回傳 | ✅ | `mediaUrls` 下載 → 上傳 Lark → 發送 |
| PDF/檔案回傳 | ❌ | 尚未實作 |
| 加密解密 | ✅ | AES-256-CBC，支援 Lark Encrypt Key |
| Challenge 驗證 | ✅ | `url_verification` + Verification Token |

## 環境變數

| 變數 | 必填 | 預設 | 說明 |
|------|------|------|------|
| `LARKSUITE_APP_ID` | ✅ | — | Lark App ID |
| `LARKSUITE_APP_SECRET` | ✅* | — | App Secret（直接值） |
| `LARKSUITE_APP_SECRET_PATH` | ✅* | `~/.clawdbot/secrets/larksuite_app_secret` | Secret 檔案路徑 |
| `CLAWDBOT_CONFIG_PATH` | — | `~/.moltbot/moltbot.json` | OpenClaw config 路徑 |
| `CLAWDBOT_AGENT_ID` | — | `main` | Agent ID |
| `LARKSUITE_WEBHOOK_PORT` | — | `9000` | HTTP 監聽 port |
| `LARKSUITE_ENCRYPT_KEY` | — | — | Lark 事件加密金鑰 |
| `LARKSUITE_VERIFICATION_TOKEN` | — | — | Lark 驗證 Token |
| `LARKSUITE_MEDIA_DIR` | — | `~/.clawdbot/media/larksuite` | 圖片暫存目錄 |
| `LARKSUITE_THINKING_THRESHOLD_MS` | — | `2500` | 顯示 Thinking 的等待毫秒 |

> `*` `APP_SECRET` 和 `APP_SECRET_PATH` 二擇一

## 部署

### launchd 持久服務（macOS）

Plist 位置：`~/Library/LaunchAgents/com.openclaw.lark-bridge.plist`

```bash
# 載入（啟動）
launchctl load ~/Library/LaunchAgents/com.openclaw.lark-bridge.plist

# 卸載（停止）
launchctl unload ~/Library/LaunchAgents/com.openclaw.lark-bridge.plist

# 查看狀態
launchctl list | grep lark-bridge
```

日誌位置：
- stdout: `~/.openclaw/logs/lark-bridge.log`
- stderr: `~/.openclaw/logs/lark-bridge.err`

### Cloudflare Tunnel 路由（範例）

| 域名 | 目標 |
|------|------|
| `bot.example.com` | `localhost:18789` (OpenClaw Gateway) |
| `larkbot.example.com` | `localhost:3000` (Lark Bridge) |

## Lark 開發者後台設定

- **App ID**: 在 [Lark 開放平台](https://open.larksuite.com/app) 建立應用取得
- **事件訂閱 Webhook URL**: `https://your-domain.com/webhook`
- **卡片回調 URL**: `https://your-domain.com/webhook/card`
- **訂閱事件**:
  - `im.message.receive_v1` — 接收訊息
  - `im.chat.member.bot.added_v1` — Bot 加入群組
  - `im.message.message_read_v1` — 已讀回執（可選）

## Session 管理

每個對話有獨立 session：
- **DM**: `larksuite:{user_open_id}` → 每位用戶獨立
- **群組**: `larksuite:{chat_id}` → 每群組共享一個 session

## Gateway 通訊

使用 WebSocket 連接 OpenClaw Gateway（`ws://127.0.0.1:{port}`）：

1. 連線 → 收到 `connect.challenge`
2. 發送 `connect` 請求（含 auth token）
3. 發送 `chat.send`（含 message + attachments）
4. 監聽 `chat` / `agent` event stream
5. 收到 `lifecycle.end` → 取得完整回覆

圖片以 base64 data URL 放在 `attachments[]` 陣列（與 webchat 相同格式）。

## 除錯

查看即時日誌：
```bash
tail -f ~/.openclaw/logs/lark-bridge.log
```

日誌標記：
- `[DEBUG]` — 訊息類型/來源
- `[IMAGE]` — 圖片下載/上傳
- `[MSG]` — 收發訊息
- `[DEDUP]` — 重複訊息跳過
- `[SKIP]` — 不支援的訊息類型
- `[ERROR]` — 錯誤
- `[INFO]` — 解密/驗證資訊

## 開發紀錄

### 2026-02-08
- 初始部署：text + image 支援
- 加入 `post`（富文本）解析，提取純文字
- 修復 post 內嵌圖片：從 `img` tag 提取 `image_key` 並下載
- Gateway 通訊從 `agent` method 改為 `chat.send`（支援 attachments）
- 圖片傳送改用 base64 data URL attachment（與 webchat 一致）
- 加入群組智慧回覆（@提及、問句、動詞判斷）
- 部署為 launchd 持久服務
- Cloudflare Tunnel 路由設定完成
