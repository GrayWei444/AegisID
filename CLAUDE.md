# CLAUDE.md - AegisID 專案指南

本文件供 AI 助手了解 AegisID 專案架構與開發規範。

---

## 0. 最高優先級規則

### 0.1 禁止自動回滾

- 遇到錯誤停止，提供選項，等用戶選擇
- 絕對不要自動 git reset / checkout / clean

### 0.2 任務範圍原則

- 只做用戶要求的事，不自作主張重構
- 發現其他問題先報告，不自動修

### 0.3 先讀再做

- 修改任何檔案前先 read_file 確認內容
- 參考 ROADMAP.md 確認當前 Phase

### 0.4 VPS 部署鐵律 ⚠️

**絕對不能直接修改 VPS 上的檔案。所有修改必須 repo → commit → push → 再 deploy。**

- ❌ 直接 SSH 到 VPS 修改程式碼
- ❌ Deploy 前沒有 commit + push
- ✅ 改 repo 原始碼 → git commit → git push → scp 到 VPS → restart

事故記錄：2026-03-22 shortcode、2026-03-23 push/blacklist，VPS 直接寫的程式碼被 deploy 覆蓋導致功能中斷。

---

## 1. 專案概述

### 1.1 定位

**AegisID = 匿名身份認證系統**

核心理念：知道是同一人，但不知道是誰。

### 1.2 與 AegisTalk 的關係

AegisID 是獨立專案，AegisTalk 透過 SDK 整合。
AegisTalk 負責通訊和 AI 防詐，AegisID 負責身份和信用。

```
AegisTalk ──import──→ @aegisrd/aegisid SDK
                           │
                           ├── 骨骼比率臉部辨識（唯一 ID）
                           ├── Anti-spoof 防偽（MiniFASNet）
                           ├── PIN 碼（純密碼，加密 key）
                           ├── 裝置指紋（同裝置偵測）
                           ├── 身份包加解密
                           └── VPS API 呼叫
```

---

## 2. 核心架構

### 2.1 統一骨骼比率系統（v14 架構）

**一套系統做到底** — 骨骼比率同時服務註冊和登入，不再需要 CNN。

```
┌─────────────────────────────────────────────────────────┐
│                    AegisID 身份認證                       │
│                                                         │
│  ┌───────────────────────┐  ┌────────────────────────┐  │
│  │ 註冊/帳號恢復（一次性） │  │ 日常登入（每次）        │  │
│  │                       │  │                        │  │
│  │ 3D 轉頭掃描           │  │ 平面刷臉               │  │
│  │ → 多角度 landmarks    │  │ → 正面 landmarks       │  │
│  │ → 3D 重建 (median)    │  │ → 24 bone bins         │  │
│  │ → 24 bone bins        │  │ → 比對本機正面基準      │  │
│  │ → face_hash (限速)    │  │ → bin match rate       │  │
│  │ → account_key (查找)  │  │                        │  │
│  │                       │  │ + Anti-spoof 防偽      │  │
│  │ + Anti-spoof 防偽     │  │ + PIN 碼驗證           │  │
│  │ + 設定 PIN 碼         │  │                        │  │
│  │ + 裝置指紋 + IP 限速  │  │ → ≥80% bins match     │  │
│  │                       │  │ → 通過                 │  │
│  │ → VPS 查重+存儲       │  │                        │  │
│  └───────────────────────┘  └────────────────────────┘  │
│                                                         │
│  每個帳號(face+PIN)綁定詐騙風險分數（跟帳號走，不跟裝置）  │
└─────────────────────────────────────────────────────────┘
```

### 2.2 註冊流程（3D 掃描 + PIN）

```
轉頭 3D 掃描 → MediaPipe 468 landmarks × 多角度
    → 3D 重建（inverse rotation → canonical space → median fusion）
    → 25 穩定骨骼比率 → 量化 (BIN_WIDTH=0.25, round())
    → SHA-256(bins) = 唯一 Face ID

同時：取最佳正面幀 → 2D bone bins → 存本機（登入基準）

+ Anti-spoof 防偽檢查
+ 設定 PIN 碼 → Argon2id → 加密 key
+ 裝置指紋收集
+ IP 限速檢查

計算雙 hash:
  - face_hash = SHA-256(25 bone bins)          → 限速用（同臉限 ~2 帳號）
  - account_key = SHA-256(25 bone bins + PIN)  → 帳號唯一 key

上傳 VPS:
  - face_hash → registration_rate_limits 查重
  - account_key + encrypted_blob → identity_anchors 存儲
  - fraud_risk_score 初始 0（綁 account_key，非 face_hash）
```

### 2.3 日常登入流程（臉 + PIN）

```
平面刷臉（5 幀取 median）
    → 25 骨骼比率 → bins
    → 比對本機存的正面基準 bins
    → bin match rate ≥ 80% → 通過

+ Anti-spoof 防偽檢查
+ PIN 碼驗證（解密本機身份包）

臉 + PIN 雙重確認 → 放行
```

### 2.4 帳號恢復流程

```
新裝置 → 轉頭 3D 掃描 + 輸入 PIN
    → account_key = SHA-256(bone bins + PIN)
    → VPS 查表 O(1) → 找到匹配的 identity_anchor
    → 返回加密身份包
    → PIN 解密 → 恢復帳號
```

### 2.5 VPS 三表分離（Option C 雙 hash 架構）

| 表 | Key | 用途 | 壽命 |
|----|-----|------|------|
| identity_anchors | `account_key` | 加密身份包查找 | 永久 |
| credit_scores | `account_key` | 詐騙風險分數（跟帳號走） | 永久 |
| registration_rate_limits | `face_hash` | 防批量建號（同臉限 ~2 帳號） | 48hr 自動清除 |

**雙 hash 說明：**
```
face_hash   = SHA-256(25 bone bins)          → 限速/防批量（同臉共用）
account_key = SHA-256(25 bone bins + PIN)    → 帳號查找 + 風險分數（每帳號獨立）
```

**關鍵原則：**
- `face_hash` 只用於 rate limiting — 同一張臉最多建 ~2 帳號
- `account_key` 用於帳號查找和風險分數 — 即使雙胞胎（同臉不同 PIN）也是獨立帳號
- 風險分數綁 `account_key`，不綁 `face_hash` — 雙胞胎各自獨立分數
- 三表使用不同 HMAC secret，無法跨表 JOIN
- 短期表 48 小時自動清除

### 2.6 骨骼比率臉部辨識

- 引擎：MediaPipe FaceLandmarker (~4MB) — 468 landmarks
- 防偽：MiniFASNetV2SE — 照片/面具/螢幕偵測 (612KB)
- 67 個骨骼比率覆蓋所有面部區域，篩選後 25 個穩定比率
- 量化：BIN_WIDTH=0.25, round() 量化，3 輪測試 24/24 穩定 ✅
- 3D 重建：多角度 landmarks → inverse rotation → canonical → median fusion
- MobileFaceNet CNN 13MB 模型已移除，臉部辨識完全使用骨骼比率系統
- structuralId.ts 已實作完整：computeBoneRatios, computeStructuralId, matchLoginBins, build3DModel

詳見: `docs/UNIQUE-FACE-ID.md`, `docs/BONE-RATIO-SYSTEM.md`, `docs/IMAGE-NORMALIZATION.md`

### 2.7 PIN 碼（純密碼）

- PIN 碼 = 純密碼，不做任何行為指紋分析
- 用途 1：Argon2id key derivation → 加密/解密身份包
- 用途 2：帳號恢復時解密身份包
- 用途 3：雙胞胎區分 — 即使骨骼 hash 相同，PIN 不同就是不同帳號
- 行為指紋（時序、滑動手勢）經 2026-03-22 研究後放棄：
  - 滑動手勢：區分力夠但無法產生穩定 hash（速度曲線每次變化太大）
  - PIN 時序：觸控感測器數據不可靠，時序比率不穩定

### 2.8 裝置指紋 + IP 限速（保留）

- 裝置指紋：canvas/webgl/audio hash → 同裝置偵測
- IP 限速：同 IP 48 小時內限制註冊次數 → 防批量建號
- 已實作，見 `sdk/src/identity/deviceFingerprint.ts`

### 2.9 詐騙風險分數

- 每個 `account_key`（face+PIN）綁定一個風險分數
- 跟著帳號走，不跟裝置 — 換手機都是同一個分數
- 雙胞胎（同臉不同 PIN）= 不同 account_key = 各自獨立風險分數
- AegisPay 收款人信任判定用
- VPS `credit_scores` 表的 key = `account_key`
- VPS `credit_scores` 表的 key 從 LSH hash 改為 face_structure_hash

---

## 3. 目錄結構

```
AegisID/
├── sdk/                               # 客戶端 SDK (@aegisrd/aegisid)
│   └── src/
│       ├── database.ts                # ✅ DatabaseAdapter 注入（宿主提供 SQLite）
│       ├── index.ts                   # ✅ 主匯出
│       │
│       ├── face/                      # ✅ 骨骼比率臉部辨識（統一系統）
│       │   ├── structuralId.ts        # ✅ 唯一 Face ID（67 骨骼比率 + 3D 重建 + SHA-256）
│       │   ├── cnnInference.ts        # ✅ Anti-spoof 防偽 (MiniFASNet only, CNN 已移除)
│       │   ├── embedding.ts           # Landmark embedding (降級 fallback)
│       │   ├── faceMesh.ts            # ✅ MediaPipe wrapper (468 landmarks)
│       │   ├── liveness.ts            # ✅ 活體偵測
│       │   ├── storage.ts             # ✅ 加密儲存（使用 DatabaseAdapter）
│       │   ├── types.ts               # 型別
│       │   ├── index.ts               # 匯出
│       │   └── useFaceRecognition.ts  # ✅ React hook（AegisTalk 直接引用此 hook）
│       │
│       ├── behavior/                  # ⚠️ 已棄用（行為指紋研究後放棄）
│       │   ├── behaviorFingerprint.ts # 保留但不使用
│       │   └── usePinBehavior.ts      # 保留但不使用
│       │
│       ├── lsh/                       # ✅ LSH 系統
│       │   ├── lshFingerprint.ts      # LSH hash + Face LSH + PIN LSH + 比對
│       │   └── index.ts              # 匯出
│       │
│       └── identity/                  # 身份管理
│           └── deviceFingerprint.ts   # ✅ 裝置指紋
│
├── models/                            # ONNX 模型
│   └── anti_spoof.onnx               # ✅ MiniFASNetV2SE (612KB) — 防偽（MobileFaceNet 已移除）
│
├── docs/
│   ├── UNIQUE-FACE-ID.md              # 唯一臉部 ID 核心設計文件
│   ├── BONE-RATIO-SYSTEM.md           # 67 骨骼比率系統（完整定義+篩選方法）
│   ├── IMAGE-NORMALIZATION.md         # 影像正規化演算法（已驗證 SSIM 0.993）
│   ├── face-structure-id-research.md  # 完整研究過程記錄
│   └── PRIVACY.md                     # 隱私設計文件
│
├── tools/
│   └── face-id-test.html              # 臉部辨識測試頁面（骨骼比率 + PIN 行為）
│
├── touch-test-app/                    # ⚠️ 觸控研究用（已完成，不再開發）
│   ├── www/index.html                 # Swipe/PIN 行為測試 UI
│   ├── capacitor.config.json          # appId: com.aegisrd.touchtest
│   └── android/                       # Android 原生專案
```

**注意：** VPS API 端點（`/aegisid/register`、`/aegisid/lookup`）目前整合在 AegisTalk 的 `api/main.py` 中，尚未分離為獨立 AegisID API。身份包加解密由 AegisTalk 的 `identityAnchor.ts` 處理。

**待建模組：**
- `identity/identityBlob.ts` — 加密/解密身份包（目前在 AegisTalk 端）
- `identity/aegisId.ts` — 主服務入口
- `credit/creditToken.ts` — 信用 token
- `components/FixedPinKeypad.tsx` — 固定尺寸鍵盤

---

## 4. HMAC Secret 管理

```
6 個 secret（環境變數，不進資料庫）：

AEGISID_CREDIT_SECRET         — credit_scores 表 token
AEGISID_SECRET_IP             — rate_limits IP 維度
AEGISID_SECRET_DEVICE         — rate_limits 裝置維度
AEGISID_SECRET_FACE           — rate_limits 臉部維度
AEGISID_SECRET_BEHAVIOR       — rate_limits 行為維度
AEGISID_CLIENT_CREDIT_SECRET  — 客戶端信用 HMAC
```

---

## 5. API 端點

| 方法 | 路徑 | 用途 |
|------|------|------|
| POST | /aegisid/register | 註冊身份 + 上傳加密身份包 |
| POST | /aegisid/lookup | 刷臉+行為 → 聯合查找 → 返回身份包 |
| POST | /aegisid/credit/update | 更新信用分數 |
| POST | /aegisid/credit/query | 批量查詢信用 |

---

## 6. 開發環境

### VPS 資訊

| 項目 | 值 |
|------|-----|
| VPS IP | 31.97.71.140 |
| 專案路徑 | /opt/webtop/projects/AegisID |
| 現有資料庫 | /opt/aegis-data/data/aegis.db |
| API 服務 | https://api.aegisrd.com |
| MCP Server | https://mcp.aegisrd.com/mcp |
| GitHub | GrayWei444 |

### 部署方式

Caddy 容器 serve `/var/www/aegisrd/`，容器內無法直接存取此路徑。
**必須透過 MCP Server 部署**（Python script）：

**測試工具部署：**
```bash
# tools/face-id-test.html → https://aegisrd.com/face-id-test/
# 使用 MCP write_file 部署到 VPS
python3 << 'PYEOF'
import json, urllib.request, ssl
with open('tools/face-id-test.html', 'r') as f:
    content = f.read()
payload = json.dumps({
    "tool": "write_file",
    "parameters": {
        "path": "/var/www/aegisrd/face-id-test/index.html",
        "content": content
    }
}).encode('utf-8')
ctx = ssl.create_default_context()
req = urllib.request.Request('https://mcp.aegisrd.com/mcp', data=payload,
    headers={'Content-Type': 'application/json'}, method='POST')
resp = urllib.request.urlopen(req, timeout=30, context=ctx)
print(resp.status, resp.read().decode()[:200])
PYEOF
```

| 來源 | VPS 路徑 | URL |
|------|---------|-----|
| `tools/face-id-test.html` | `/var/www/aegisrd/face-id-test/index.html` | https://aegisrd.com/face-id-test/ |

**MCP Server：** https://mcp.aegisrd.com/mcp
- `exec` — 執行 shell 指令（`parameters.command`）
- `read_file` / `write_file` — 讀寫檔案（`parameters.path`, `parameters.content`）
- `list_dir` — 列目錄（`parameters.path`）
- `docker_ps` / `docker_logs` / `docker_restart` — Docker 管理

**站點對應：**
| VPS 路徑 | 對應站點 |
|---------|---------|
| `/var/www/aegisrd/` | aegisrd.com |
| `/var/www/talk/` | talk.aegisrd.com |
| `/var/www/mist/` | mist.aegisrd.com |

### 從 AegisTalk 遷移的代碼

| 來源 | 目標 | 狀態 |
|------|------|------|
| faceRecognition/*.ts | sdk/src/face/ | ✅ 已遷移 + 建置通過 |
| behaviorFingerprint.ts | sdk/src/behavior/ | ✅ 已遷移 |
| lshFingerprint.ts | sdk/src/lsh/ | ✅ 已遷移 + 新增 Face LSH |
| deviceFingerprint.ts | sdk/src/identity/ | ✅ 已遷移 |
| ONNX 模型 | models/ | ✅ 已複製 |

### AegisTalk 整合架構

**原則：邏輯在 SDK，宿主只消費 API**

```
@aegisrd/aegisid (SDK)
  ├── useFaceRecognition()     ← 相機、活體、防偽、embedding 全部在 SDK
  ├── structuralId.ts          ← 骨骼比率 + 3D 重建 + SHA-256 唯一 ID
  ├── cnnInference.ts          ← MiniFASNet 防偽 only（MobileFaceNet 已移除）
  └── faceMesh.ts              ← MediaPipe 468 landmarks

AegisTalk (宿主 App)
  ├── hooks/useFaceRecognition.ts  ← 薄包裝，re-export from SDK
  ├── AuthScreen.tsx               ← 只負責 UI + 流程控制
  └── main.tsx                     ← 啟動時預載模型 + 注入 DatabaseAdapter
```

| 整合項目 | 狀態 | 說明 |
|---------|------|------|
| SDK import | ✅ | `@aegisrd/aegisid` (file-based local package) |
| DatabaseAdapter 注入 | ✅ | `main.tsx` 呼叫 `setDatabaseAdapter()` |
| useFaceRecognition hook | ✅ | AegisTalk re-export SDK hook，不自己實作 |
| 模型預載 | ✅ | `main.tsx` 啟動時 `initFaceLandmarker()` + `initCnnModels()` |
| MobileFaceNet CNN | ❌ 已移除 | 臉部辨識改用骨骼比率系統 |
| 骨骼比率 structuralId | ✅ SDK 已實作 | 待整合進 hook 取代 landmark embedding |
| VPS 身份錨點 | ✅ | `identityAnchor.ts` + `/aegisid/register` + `/aegisid/lookup` |

### Git 版本控制

```bash
git status
git add -A
git commit -m "feat: 描述"
git push
```

---

## 7. 注意事項

### 隱私紅線

- face_structure_hash 和 behavior_lsh_hash 可關聯（同為匿名生物特徵 hash）
- 但絕不與 IP/裝置/pubkey/真實身份關聯
- rate_limits 48 小時自動清除
- VPS 永遠無法解密 encrypted_blob
- 正面骨骼 bins 只存本機，不上傳 VPS

### 測試前置

- 骨骼比率 3D 穩定性：24/24 穩定 ✅（BIN_WIDTH=0.25, round()）
- 骨骼比率 3D vs 平面 match rate：需驗證 ≥80%
- PIN 18 維跨裝置穩定性必須先驗證再上線
- 登入三層聯合閾值需要實測調整

---

**維護者**: AegisRD Team
**建立日期**: 2026-03-14
