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
                           ├── CNN FaceID
                           ├── PIN 行為指紋
                           ├── LSH 匹配
                           ├── 身份包加解密
                           └── VPS API 呼叫
```

---

## 2. 核心架構

### 2.1 身份構成

```
AegisID 身份 = CNN FaceID (512維) + PIN 行為指紋 (18維)

兩者聯合判定，取信心分數：
  confidence = face_similarity × 0.6 + behavior_similarity × 0.4

  ≥ 0.80 → 確認同一人
  0.60~0.79 → 額外驗證
  < 0.60 → 拒絕
```

### 2.2 VPS 三表分離

| 表 | 用途 | 壽命 |
|----|------|------|
| identity_anchors | 身份查找 + 加密身份包 | 永久 |
| credit_scores | 交易信用分數 | 永久 |
| registration_rate_limits | 防批量建號 | 48hr 自動清除 |

**關鍵原則：**
- face_lsh_hash 和 behavior_lsh_hash 可以關聯（同為生物特徵 hash）
- 但不可關聯到 IP、裝置、pubkey 等真實身份
- 三表使用不同 HMAC secret，無法跨表 JOIN
- 短期表 48 小時自動清除

### 2.3 CNN FaceID

- 模型：MobileFaceNet (w600k_mbf) — 512 維 embedding
- 防偽：MiniFASNetV2SE — 照片/面具/螢幕偵測
- 引擎：onnxruntime-web WASM 後端
- 模型位置：`models/face_recognition.onnx` (13MB) + `models/anti_spoof.onnx` (612KB)
- 只保留 CNN 版本，Landmark 128 維已廢棄

### 2.4 PIN 行為指紋

- 18 維全比率/模式特徵（移除所有裝置相關絕對值）
- 固定鍵盤尺寸 280×360px（讓位置特徵跨裝置穩定）
- LSH 64-bit hash

### 2.5 LSH (Locality-Sensitive Hashing)

- Random Hyperplane LSH
- 固定 seed 確保可重現
- 漢明距離 → 相似度 → 信心分數

---

## 3. 目錄結構

```
AegisID/
├── api/                               # VPS API
│   ├── main.py                        # FastAPI endpoints
│   ├── database.py                    # 三表 SQLite
│   ├── hmac_service.py                # HMAC token（6 個 secret）
│   ├── rate_limiter.py                # 防批量建號
│   ├── confidence.py                  # 聯合信心分數
│   ├── cleanup.py                     # 48hr 清除 cron
│   └── tests/
│
├── sdk/                               # 客戶端 SDK
│   └── src/
│       ├── face/                      # CNN 臉部辨識
│       │   ├── cnnInference.ts        # ONNX 推論 (MobileFaceNet + MiniFASNet)
│       │   ├── embedding.ts           # Landmark embedding (降級 fallback)
│       │   ├── faceMesh.ts            # MediaPipe wrapper
│       │   ├── liveness.ts            # 活體偵測
│       │   ├── storage.ts             # 加密儲存
│       │   ├── types.ts               # 型別
│       │   ├── index.ts               # 匯出
│       │   └── useFaceRecognition.ts  # React hook
│       │
│       ├── behavior/                  # PIN 行為指紋
│       │   ├── behaviorFingerprint.ts # 特徵計算 (→重構為18維)
│       │   └── usePinBehavior.ts      # React hook
│       │
│       ├── lsh/                       # LSH 系統
│       │   └── lshFingerprint.ts      # LSH hash + 比對
│       │
│       ├── identity/                  # 身份管理
│       │   ├── deviceFingerprint.ts   # 裝置指紋
│       │   ├── identityBlob.ts        # 加密/解密身份包 (待建)
│       │   └── aegisId.ts             # 主服務入口 (待建)
│       │
│       └── credit/                    # 信用系統
│           └── creditToken.ts         # 信用 token (待建)
│
├── components/                        # React UI
│   ├── FixedPinKeypad.tsx             # 固定尺寸鍵盤 (待建)
│   └── ...
│
├── models/                            # ONNX 模型
│   ├── face_recognition.onnx          # MobileFaceNet (13MB)
│   └── anti_spoof.onnx               # MiniFASNetV2SE (612KB)
│
├── docs/
└── tools/
```

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

### 從 AegisTalk 遷移的代碼

| 來源 | 目標 | 狀態 |
|------|------|------|
| faceRecognition/*.ts | sdk/src/face/ | ✅ 已複製 |
| behaviorFingerprint.ts | sdk/src/behavior/ | ✅ 已複製，需重構 |
| lshFingerprint.ts | sdk/src/lsh/ | ✅ 已複製，需更新 |
| deviceFingerprint.ts | sdk/src/identity/ | ✅ 已複製 |
| ONNX 模型 | models/ | ✅ 已複製 |

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

- face_lsh_hash 和 behavior_lsh_hash 可關聯
- 但絕不與 IP/裝置/pubkey/真實身份關聯
- rate_limits 48 小時自動清除
- VPS 永遠無法解密 encrypted_blob

### 測試前置

- CNN 跨鏡頭穩定性必須先驗證再上線
- PIN 18 維跨裝置穩定性必須先驗證再上線
- 聯合信心分數閾值需要實測調整

---

**維護者**: AegisRD Team
**建立日期**: 2026-03-14
