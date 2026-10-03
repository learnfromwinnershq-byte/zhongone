# 中一 · 香港中一自學系統

極簡自學平台：主頁列出所有課件，孩子撳入去就可以學；管理員喺 `/admin` 上載 HTML 課件。
零依賴（只需 Node.js 18+），初次啟動會自動放入初始課件「有向數的乘法與除法」。

## 頁面
| 路徑 | 用途 |
|---|---|
| `/` | 課程列表（孩子用） |
| `/lesson/<id>/` | 開啟課件（以 sandbox 方式執行；同一課件內嘅 js / css / 圖片用相對路徑存取） |
| `/admin` | 管理員登入、上載 / 刪除課件 |
| `/healthz` | 健康檢查 |

## 環境變數
| 變數 | 預設 | 說明 |
|---|---|---|
| `ADMIN_PASSWORD` | （冇設定就每次啟動隨機產生並印喺 log） | 管理員密碼，**部署時必須設定** |
| `PORT` | `3000` | 監聽端口 |
| `HOST` | `0.0.0.0` | 監聽地址 |
| `DATA_DIR` | `./data` | 課件同 `lessons.json` 存放位置，請保留 / 備份 |
| `MAX_UPLOAD_MB` | `100` | 單次上載上限（MB）；解壓後上限為 3 倍 |

## 上載課件格式
喺 `/admin` 可以上載：
- **單一 `.html`**
- **多個檔案 / 成個資料夾**（html + js、css、圖片、音效…）：瀏覽器會自動打包成 zip 再上載
- **`.zip`**：伺服器自動解壓（支援一般 zip；唔支援加密 / zip64）

每個課件存放喺 `DATA_DIR/lessons/<id>/`。入口優先用 `index.html`，否則用最外層嘅 `.html`。
如果所有檔案都包喺同一個資料夾入面，會自動去除嗰層。`__MACOSX`、`.DS_Store` 會被忽略，`../` 等不安全路徑會被拒絕。
課件內請用相對路徑引用資源（例如 `js/app.js`、`img/a.png`）。

## 部署（VPS）

### 方法 A：Node + systemd
```bash
git clone git@github.com:learnfromwinnershq-byte/zhongone.git /opt/zhongone
cd /opt/zhongone
sudo tee /etc/systemd/system/zhongone.service >/dev/null <<'UNIT'
[Unit]
Description=zhongone (中一)
After=network.target
[Service]
WorkingDirectory=/opt/zhongone
Environment=ADMIN_PASSWORD=請改成強密碼
Environment=PORT=3000
Environment=DATA_DIR=/var/lib/zhongone
ExecStart=/usr/bin/node server.js
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload && sudo systemctl enable --now zhongone
```

### 方法 B：Docker
```bash
docker build -t zhongone .
docker run -d --name zhongone --restart=always -p 3000:3000 \
  -e ADMIN_PASSWORD=請改成強密碼 -v zhongone-data:/data zhongone
```

### HTTPS（建議）
用 Caddy 反向代理（自動 HTTPS）：
```
your.domain.com {
    reverse_proxy 127.0.0.1:3000
}
```
如用 Nginx，請加 `proxy_set_header X-Forwarded-Proto $scheme;` 及 `client_max_body_size 100m;`（同 `MAX_UPLOAD_MB` 一致）。

## 更新
```bash
cd /opt/zhongone && git pull && sudo systemctl restart zhongone
```
`DATA_DIR` 入面嘅課件唔會因更新而受影響（舊版單檔格式會喺啟動時自動轉換）。

## 粵語旁白（Google Cloud TTS 預錄）
初始課件已附帶 Google `yue-HK-Chirp3-HD-Kore` 預錄旁白（`seed/lessons/s1-math-directed-numbers/audio/`，149 句），**部署時唔需要任何 API key**。以下只係新增 / 修改課件旁白時先需要。

課件播放器優先用**預錄旁白**；冇預錄就用瀏覽器內置粵語聲音；再冇就字幕模式。
用 Google Cloud Text-to-Speech 為課件生成粵語旁白（只需 Node 18+，無依賴）：

```bash
GOOGLE_TTS_API_KEY=你的key node tools/build_voice.mjs                     # 預設：初始課件
GOOGLE_TTS_API_KEY=你的key node tools/build_voice.mjs --list              # 列出可用 yue-HK 聲音
GOOGLE_TTS_API_KEY=你的key node tools/build_voice.mjs path/to/lesson --voice=yue-HK-Standard-A --rate=1.0
```

- 腳本讀取課件 `index.html` 入面每句旁白，逐句合成 MP3 → `<課件>/audio/`，並喺 `index.html` 注入 `window.LESSON_AUDIO`（時間軸按真實音檔長度）。
- 未指定 `--voice` 時自動揀最自然嘅聲音（Chirp3-HD → Chirp-HD → Neural2 → Wavenet → Standard，優先女聲）。
- 已合成嘅句子快取喺 `.cache/tts/`，改咗幾句再跑只會重新合成改動嘅句。
- 支援 `HTTPS_PROXY` / `HTTP_PROXY` 代理（例如中國大陸網絡）。
- API key 只經環境變數傳入，唔會寫入任何檔案；key 需要開通 Cloud Text-to-Speech API，且唔可以限制 HTTP referrer。
- 生成後：如果係初始課件就 commit `seed/` ；已部署嘅系統可以喺 `/admin` 用「揀資料夾」上載成個課件資料夾（再刪除舊版）。

## 匯出 MP4（抖音 / 下載）
初始課件已經匯出好 MP4，放喺 GitHub Release **`s1-math-directed-numbers-video`**：
- 完整橫版 1920×1080（約 14 分鐘）
- 抖音直版分集 1080×1920（每章一集，連封面 `covers/*.jpg`）

課件播放器控制列有「⬇ 下載 MP4」選單（播完亦會出現）。選單會先試用伺服器本機嘅 `video/`，冇就用 GitHub Release 連結。
如果 VPS 喺中國大陸、GitHub 下載慢，可以將 MP4 放到本機（之後選單自動用本機檔案）：
```bash
cd $DATA_DIR/lessons/s1-math-directed-numbers && mkdir -p video && \
gh release download s1-math-directed-numbers-video -R learnfromwinnershq-byte/zhongone -p '*.mp4' -D video
```

### 自己重新匯出（改咗課件內容之後）
需要 Google Chrome（或設定 `CHROME_PATH`）同 ffmpeg，唔需要 API key：
```bash
node tools/render_video.mjs                         # 完整橫版 + 全部直版分集 → dist/<課件>/
node tools/render_video.mjs --only=vertical --chapters=3   # 只出某一集（試樣）
node tools/render_video.mjs --workers=6 --release   # 上載到 GitHub Release，並喺課件注入下載選單
```
- 逐格渲染：播放器嘅 render 模式將所有 CSS 動畫暫停並按課件時間定位，所以每一格都準確，唔受電腦快慢影響。
- 音軌：預錄旁白 + 音效按時間軸精確放置；字幕直接畫喺畫面上。
- 已完成嘅章節會保留喺 `dist/<課件>/.work/`，中斷後再跑會續做。MP4 唔入 git（太大），只放 Release。
