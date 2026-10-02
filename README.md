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
