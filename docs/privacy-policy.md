# Privacy Policy / 隱私權政策

**Last updated / 最後更新：2026-10-11**

This policy covers the Discord application **西寶** (application ID `1491051091524059316`, "the bot"), operated by an individual developer (GitHub: [Lanternko](https://github.com/Lanternko)). The bot is open source: <https://github.com/Lanternko/discord-social-preview-bot>.

The English text comes first; a Traditional Chinese version follows. If the two differ, the English text governs.

---

## English

### 1. What the bot does

The bot does two things in the servers it is added to:

- **Link previews.** When a message contains a link to a supported site (Threads, X, Instagram, Reddit, Pixiv, Bluesky, Bilibili, Facebook, Pinterest, Bahamut, PTT), the bot replies with a preview.
- **AI chat.** When someone mentions the bot, replies to it, or uses its commands, it answers as the character 西寶 using third-party language models.

### 2. Data the bot reads

The bot uses Discord's Message Content intent, so it receives the content of messages in channels it can see. It uses that content only for the purposes below.

| Purpose | What is read | Kept on disk? |
|---|---|---|
| Detect supported links | Message text, checked for URLs | No. Only the URL is processed; a 60-second in-memory record prevents duplicate replies. |
| Answer a mention, reply or command | The message, attached images, and the message being replied to | Yes, see section 3. |
| Give the reply context (Standard and Detailed plans only) | About the last 15 messages in the channel | Short excerpts may be held until summarised, see section 3. |
| Learn nicknames members use for each other | Messages in servers where the bot already holds memory, kept in an in-memory buffer of at most 80 messages per channel | The raw messages are never written to disk. Only a confirmed nickname is saved. |
| Count how active each member is | The author of each message (not its text) | Yes, a per-member message count. |

The bot does not read direct messages for these features, does not read voice channels, and does not collect email addresses, IP addresses, or payment information.

### 3. Data the bot stores

All stored data lives on a single server operated by the developer.

| Data | Contents | Retention |
|---|---|---|
| Short-term conversation memory | Recent turns between members and the bot in a channel | In memory only; cleared after 30 minutes of inactivity or on restart. |
| Conversation log | Messages sent to the bot and its replies, with user ID, display name and time | 90 days, and never more than the most recent 500 turns per channel. Your own entries are deleted earlier on request (section 6). |
| Member memory | Per server and per member: display name, short notes about speaking style, frequent topics and interaction preferences, nicknames, and the IDs and times of the messages that support each note | Notes that are not re-confirmed are dropped after roughly 120 to 180 days. Deleted on request (section 6). |
| Server memory | Per server: frequent topics, interaction style, running jokes, plus short excerpts of recent chat waiting to be summarised | Notes not re-confirmed are dropped after about 60 days. Excerpts are removed once summarised; a member's lines are removed earlier on request (section 6). |
| Activity count | Per server and per member: display name and number of messages | Until the member deletes it (section 6) or the bot is removed from the server. |
| Server settings | AI plan, reply language, chat triggers, scheduled tasks (including the ID of the user who created each one) | Until changed or removed by a server administrator, or the bot is removed from the server. |
| Server API key | A DeepSeek API key that an administrator provides with `/ai-key set` | Until removed with `/ai-key remove`, or the bot is removed from the server. Used only for that server's requests. |
| Usage counters | Number of AI replies and translations per server per day | Reset daily. |
| Departure record | The ID of a server the bot was removed from, and when | Until that server's data is deleted (30 days), or the bot is added back. |
| Operational logs | Timestamps, server, channel and user IDs, error details, and occasionally short fragments of content needed for debugging | 14 days. |

**When the bot is removed from a server**, everything stored for that server (member memory, server memory, conversation log, activity counts, settings, scheduled tasks and API key) is deleted 30 days later. The delay exists so that a server which removes the bot by mistake, or re-invites it to fix permissions, does not lose its memory; adding the bot back within 30 days cancels the deletion. A Discord outage is not treated as removal.

**Backups.** Each stored file has one automatic backup copy on the same server. Whenever data is deleted (by a command, by the 90-day limit, or after the bot leaves a server), the backup copy is overwritten so that it no longer contains the deleted data. The developer occasionally makes a manual snapshot before maintenance; these are deleted once the maintenance is finished and may contain previously deleted data until then.

### 4. Third parties that receive data

To generate replies, translations, image descriptions and memory notes, the bot sends the relevant message text (and images, when attached) to one or more language model providers:

- DeepSeek
- OpenAI
- Google (Gemini API)
- Groq
- Moonshot AI (Kimi)
- Vercel AI Gateway (which routes to Z.ai GLM models)

Requests contain message text, display names, and the stored memory notes relevant to the conversation. They do not contain Discord account email addresses or tokens. Each provider handles the data under its own terms and privacy policy.

To build link previews, the bot requests the linked page or its metadata from the original site or from a public preview service (for example fxtwitter, vxtwitter, fixembed, vxbilibili, phixiv). These requests contain the link only, not information about who posted it.

Speech for `/voice` is generated on the developer's own server and is not sent to a third party.

### 5. What the bot does not do

- It does not sell or rent data.
- It does not use message content to train machine learning or AI models. Content is sent to model providers only to produce a response.
- It does not show advertising or build advertising profiles.
- It does not share stored memory between servers. Memory about a member in one server is not used in another.

### 6. Your choices

- **See what is stored about you:** `/memory show`. For the server: `/memory guild`.
- **Delete what is stored about you:** `/memory forget-me`. For the server you run it in, this immediately removes your member memory (notes and nicknames), your conversation log entries together with the bot's replies to them, your activity count, your lines in excerpts waiting to be summarised, and your user ID where it was recorded as evidence for another member's nickname. It does not delete messages in Discord itself, and it is not an opt-out: if you keep talking in the server, the bot starts counting and remembering again.
- **Server administrators** can do the same for another member with `/memory forget-user`.
- **Skip a preview:** include `nopreview`, `previewignore` or `fxignore` in the message.
- **Delete a bot message:** react with 🗑️ on it, or use the "刪除西寶訊息" context menu command.
- **Stop all processing:** remove the bot from the server. Its stored data is deleted 30 days later (section 3).
- **Anything else** (deleting a server's data immediately instead of after 30 days, removal from manual snapshots or operational logs, or data in a server you can no longer access): contact the developer as described in section 9. Requests are handled within 30 days.

### 7. Children

The bot is intended for users who meet Discord's minimum age requirement (13, or higher where local law requires). The bot does not knowingly collect data from younger users.

### 8. Security

Stored data is kept on a private server with access limited to the developer. API keys provided by administrators are stored in a file readable only by the bot's system account and are never shown in chat. No system is perfectly secure, and the developer cannot guarantee absolute security.

### 9. Contact

- Open an issue: <https://github.com/Lanternko/discord-social-preview-bot/issues>

Do not include private information in a public issue. For a deletion request, give the server ID and your Discord user ID.

### 10. Changes

This policy may be updated when the bot's features change. The date at the top shows the latest revision, and the full history is visible in the repository.

---

## 繁體中文

### 1. 西寶做什麼

- **連結預覽**：訊息裡有支援網站的連結（Threads、X、Instagram、Reddit、Pixiv、Bluesky、Bilibili、Facebook、Pinterest、巴哈姆特、PTT）時，西寶會回覆預覽。
- **AI 聊天**：有人 @西寶、回覆她或使用指令時，她會透過第三方語言模型以「西寶」這個角色回答。

### 2. 西寶讀取的資料

西寶使用 Discord 的 Message Content intent，會收到她看得到的頻道裡的訊息內容，並只用於下列用途。

| 用途 | 讀取內容 | 是否存到硬碟 |
|---|---|---|
| 偵測支援的連結 | 訊息文字（只檢查網址） | 否。只處理網址；另有 60 秒的記憶體紀錄避免重複回覆。 |
| 回應 @、回覆或指令 | 該則訊息、附圖、被回覆的那則訊息 | 是，見第 3 節。 |
| 提供回覆的前文（僅標準、精細方案） | 頻道最近約 15 則訊息 | 短片段可能暫存到整理成摘要為止，見第 3 節。 |
| 學習群友之間的暱稱 | 西寶已有記憶的伺服器裡的訊息，只放在記憶體緩衝區（每頻道最多 80 則） | 原始訊息不寫入硬碟，只儲存確認過的暱稱。 |
| 統計成員活躍度 | 每則訊息的發言者（不含內容） | 是，每位成員的訊息數。 |

西寶不會為這些功能讀取私訊、不讀取語音頻道，也不蒐集電子郵件、IP 位址或付款資訊。

### 3. 西寶儲存的資料

所有資料都存在開發者自行管理的單一伺服器上。

| 資料 | 內容 | 保存期限 |
|---|---|---|
| 短期對話記憶 | 頻道中成員與西寶最近的對話 | 只在記憶體；閒置 30 分鐘或重啟後清除。 |
| 對話紀錄 | 傳給西寶的訊息與她的回覆，含使用者 ID、顯示名稱、時間 | 90 天，且每頻道最多保留最近 500 輪；你自己的紀錄可依請求提前刪除（第 6 節）。 |
| 成員記憶 | 每個伺服器、每位成員：顯示名稱、說話風格／常聊話題／互動偏好的簡短紀錄、暱稱，以及佐證訊息的 ID 與時間 | 沒有再被印證的紀錄約 120 至 180 天後移除；可依請求刪除（第 6 節）。 |
| 伺服器記憶 | 每個伺服器：常聊話題、互動風格、群內梗，以及等待整理的近期對話短片段 | 沒有再被印證的紀錄約 60 天後移除；片段整理後即刪除，成員的片段可依請求提前刪除（第 6 節）。 |
| 活躍度統計 | 每個伺服器、每位成員：顯示名稱與訊息數 | 直到成員自行刪除（第 6 節），或西寶被移出該伺服器。 |
| 伺服器設定 | AI 方案、回覆語言、聊天觸發方式、排程（含建立者的使用者 ID） | 直到管理員更改或移除，或西寶被移出該伺服器。 |
| 伺服器 API 金鑰 | 管理員用 `/ai-key set` 提供的 DeepSeek 金鑰 | 直到用 `/ai-key remove` 移除，或西寶被移出該伺服器；只用於該伺服器的請求。 |
| 用量計數 | 每個伺服器每天的 AI 回覆與翻譯次數 | 每日重置。 |
| 退出紀錄 | 西寶被移出的伺服器 ID 與時間 | 直到該伺服器的資料刪除為止（30 天），或西寶被加回去。 |
| 運作紀錄 | 時間、伺服器／頻道／使用者 ID、錯誤細節，偶爾含除錯所需的短片段內容 | 14 天。 |

**西寶被移出伺服器時**，該伺服器的所有資料（成員記憶、伺服器記憶、對話紀錄、活躍度統計、設定、排程與 API 金鑰）會在 30 天後刪除。保留這段時間，是為了讓誤踢、或為了調整權限而重新邀請的伺服器不會失去記憶；30 天內把西寶加回來就會取消刪除。Discord 斷線不算移出。

**備份**：每個資料檔在同一台伺服器上有一份自動備份。每次刪除資料時（透過指令、90 天期限到期，或西寶退出伺服器後），備份會一併覆寫，不再含有被刪除的資料。開發者偶爾會在維護前手動留一份快照，維護結束後刪除；在那之前，快照可能仍含有已刪除的資料。

### 4. 會收到資料的第三方

為了產生回覆、翻譯、圖片描述與記憶紀錄，西寶會把相關的訊息文字（以及附上的圖片）傳給下列語言模型供應商之一或數個：

- DeepSeek
- OpenAI
- Google（Gemini API）
- Groq
- Moonshot AI（Kimi）
- Vercel AI Gateway（轉送至 Z.ai GLM 模型）

請求內容包含訊息文字、顯示名稱，以及與該對話相關的記憶紀錄；不包含 Discord 帳號的電子郵件或 token。各供應商依其自身的條款與隱私權政策處理資料。

為了製作連結預覽，西寶會向原站或公開的預覽服務（例如 fxtwitter、vxtwitter、fixembed、vxbilibili、phixiv）請求該頁面或其中繼資料。這些請求只包含連結，不包含貼文者的資訊。

`/voice` 的語音在開發者自己的伺服器上產生，不會送到第三方。

### 5. 西寶不做的事

- 不販售或出租資料。
- 不使用訊息內容訓練機器學習或 AI 模型；內容只為了產生回覆才送給模型供應商。
- 不投放廣告，也不建立廣告用的個人檔案。
- 不跨伺服器共用記憶；某位成員在一個伺服器的記憶不會用在另一個伺服器。

### 6. 你的選擇

- **查看西寶記得你什麼**：`/memory show`；查看對這個群的記憶：`/memory guild`。
- **刪除西寶存的關於你的資料**：`/memory forget-me`。在你執行指令的那個伺服器，會立即移除你的成員記憶（紀錄與暱稱）、你的對話紀錄與西寶對那些訊息的回覆、你的活躍度統計、等待整理的片段中你說的話，以及你被記為其他成員暱稱佐證的使用者 ID。這不會刪除 Discord 上的訊息，也不是「退出」：之後你繼續在伺服器發言，西寶會重新開始統計與記憶。
- **伺服器管理員**可用 `/memory forget-user` 對其他成員做同樣的事。
- **不要預覽**：訊息中加上 `nopreview`、`previewignore` 或 `fxignore`。
- **刪除西寶的訊息**：在該訊息按 🗑️，或使用右鍵選單「刪除西寶訊息」。
- **停止所有處理**：把西寶移出伺服器，儲存的資料會在 30 天後刪除（第 3 節）。
- **其他請求**（不等 30 天、立即刪除整個伺服器的資料；從手動快照或運作紀錄中移除；或你已無法進入的伺服器裡的資料）：依第 9 節聯絡開發者，30 天內處理。

### 7. 兒童

西寶僅供符合 Discord 最低年齡要求（13 歲，或當地法律規定的更高年齡）的使用者使用，不會在知情的情況下蒐集更年幼使用者的資料。

### 8. 安全

資料存放在私人伺服器，只有開發者能存取。管理員提供的 API 金鑰存在只有 bot 系統帳號可讀的檔案中，不會顯示在聊天裡。沒有任何系統能保證絕對安全。

### 9. 聯絡方式

- 開 issue：<https://github.com/Lanternko/discord-social-preview-bot/issues>

請勿在公開 issue 中張貼私人資訊。提出刪除請求時，請附上伺服器 ID 與你的 Discord 使用者 ID。

### 10. 政策變更

功能變動時本政策可能更新。頁首日期為最新修訂日，完整修訂紀錄可在 repo 中查看。
