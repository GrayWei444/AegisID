# AegisID 開發路線圖

> **版本**: 0.2.0
> **建立日期**: 2026-03-14
> **最後更新**: 2026-03-20
> **定位**: AegisRD 生態系匿名身份認證系統

---

## 開發階段總覽

| Phase | 名稱 | 預估時間 | 狀態 | 依賴 |
|-------|------|----------|------|------|
| **Phase 1** | 專案建置 + CNN 遷移 | 1-2 天 | ✅ 完成 | - |
| **Phase 1.5** | 唯一臉部 ID 研究 | 持續 | 🔄 進行中 | Phase 1 |
| **Phase 2** | CNN 跨鏡頭穩定性驗證 | 2-3 天 | ⏳ | Phase 1 |
| **Phase 2.5** | 滑動手勢辨識研究 | 持續 | 🔄 進行中 | Phase 1 |
| **Phase 3** | 滑動手勢 + PIN 行為重新設計 | 3-5 天 | ⏳ | Phase 2.5 |
| **Phase 4** | 固定尺寸 PIN 鍵盤 | 1-2 天 | ⏳ | Phase 3 |
| **Phase 5** | LSH 系統升級 | 2-3 天 | ⏳ | Phase 2, 3 |
| **Phase 6** | VPS 三表資料庫 | 2-3 天 | ⏳ | Phase 5 |
| **Phase 7** | VPS API — 註冊與查找 | 3-5 天 | ⏳ | Phase 6 |
| **Phase 8** | 聯合信心分數 | 2-3 天 | ⏳ | Phase 7 |
| **Phase 9** | 加密身份包 | 2-3 天 | ⏳ | Phase 7 |
| **Phase 10** | 防批量建號 (Rate Limiting) | 2-3 天 | ⏳ | Phase 7 |
| **Phase 11** | 信用分數系統 | 2-3 天 | ⏳ | Phase 7 |
| **Phase 12** | AegisTalk 整合 | 5-7 天 | ⏳ | Phase 8-11 |
| **Phase 13** | 跨裝置恢復流程 | 3-5 天 | ⏳ | Phase 12 |
| **Phase 14** | LINE PWA 註冊流程 | 3-5 天 | ⏳ | Phase 13 |
| **Phase 15** | 穩定性調優 + 閾值校準 | 3-5 天 | ⏳ | Phase 14 |

---

## Phase 1: 專案建置 + CNN 遷移 ✅ 進行中

**目標**: 建立專案骨架，從 AegisTalk 遷移 CNN 臉部辨識和相關模組

### 任務清單

- [x] 建立專案目錄結構
- [x] 建立 README.md、CLAUDE.md、ROADMAP.md、HANDOVER.md
- [x] 從 AegisTalk 複製 CNN 模組 (faceRecognition/*.ts)
- [x] 從 AegisTalk 複製 PIN 行為指紋 (behaviorFingerprint.ts)
- [x] 從 AegisTalk 複製 LSH 系統 (lshFingerprint.ts)
- [x] 從 AegisTalk 複製裝置指紋 (deviceFingerprint.ts)
- [x] 複製 ONNX 模型 (face_recognition.onnx + anti_spoof.onnx)
- [ ] 建立 package.json + tsconfig.json
- [ ] 確認遷移代碼可獨立編譯

### 遷移清單

| 來源 (AegisTalk) | 目標 (AegisID) | 行數 |
|-------------------|----------------|------|
| faceRecognition/cnnInference.ts | sdk/src/face/ | 381 |
| faceRecognition/embedding.ts | sdk/src/face/ | 399 |
| faceRecognition/faceMesh.ts | sdk/src/face/ | 228 |
| faceRecognition/liveness.ts | sdk/src/face/ | 283 |
| faceRecognition/storage.ts | sdk/src/face/ | 195 |
| faceRecognition/types.ts | sdk/src/face/ | 165 |
| faceRecognition/index.ts | sdk/src/face/ | 68 |
| behaviorFingerprint.ts | sdk/src/behavior/ | 813 |
| lshFingerprint.ts | sdk/src/lsh/ | 389 |
| deviceFingerprint.ts | sdk/src/identity/ | 414 |
| useFaceRecognition.ts | sdk/src/face/ | 594 |
| usePinBehavior.ts | sdk/src/behavior/ | 344 |
| **合計** | | **4,273** |

### 驗收標準

- [x] 目錄結構建立
- [x] 所有源碼複製完成
- [x] ONNX 模型複製完成
- [x] TypeScript 編譯通過 ✅

---

## Phase 1.5: 唯一臉部 ID 研究 🔄 進行中

**目標**: 讓同一個人不管怎麼掃臉，ID 永遠相同。不是模糊匹配，是確定性唯一身份。

**核心差異**: 傳統辨識是 `similarity > threshold → 通過`（模糊），AegisID 要的是 `f(同一張臉) → 永遠相同的 hash`（確定性）。

### 已完成

- [x] 影像正規化管線研究 — ArcFace align → gray → histEq → 橢圓遮罩
- [x] 正規化管線驗證 — SSIM avg 0.993, pHash 4×4 100% exact match
- [x] 深度路線評估 — Depth Anything V2 + Laplacian 曲率場 → ❌ 放棄（穩定性 26%）
- [x] pHash 穩定性測試 — 4×4 (15bit) 100% stable, 8×8 (63bit) 2-4 bit drift
- [x] 骨骼比率初始測試 — 12 比率，10/12 穩定 (83%)
- [x] 骨骼比率擴充 — 12 → 30 → 67 個比率
- [x] SDK 模組建立 — `structuralId.ts` 正規化管線已實作
- [x] 測試頁面 — https://aegisrd.com/face-id-test/
- [x] 文件建立 — UNIQUE-FACE-ID.md, BONE-RATIO-SYSTEM.md, IMAGE-NORMALIZATION.md
- [x] 3D 視頻掃描管線 — 連續錄影 + 自動截圖 + 多角度 3D 重建
- [x] 偽彩深度可視化 — Jet colormap 3D 臉模型（正面/側面/俯視）
- [x] Bin 邊界漂移研究 — floor() vs round() 量化，系統性邊界分析
- [x] BIN_WIDTH 最佳化 — 0.10 → 0.15 → 0.25，round() 量化
- [x] 穩定比率篩選 — 67 → 24 個穩定比率，3 輪 3D Multi-Test 24/24 全部一致 ✅
- [x] v14 統一架構設計 — 一套骨骼比率系統服務註冊（3D hash）和登入（平面 bin match）
- [x] 正面基準提取 — 3D 掃描時自動取最佳正面幀，存本機作登入基準
- [x] Login Test 模式 — 平面刷臉 vs 正面基準 bin 比對

### 進行中

- [ ] 3D vs 平面 match rate 驗證（目標 ≥80%）
- [ ] 不同距離穩定性測試
- [ ] 不同裝置穩定性測試
- [ ] 區分力驗證（不同人測試）
- [ ] `structuralId.ts` 完整實作（含 3D 重建 + 登入比對）

### 關鍵發現

1. **背景是最大干擾源** — 橢圓遮罩消除背景後 SSIM 從 ~0.85 提升到 0.993
2. **全局 histEq 優於 CLAHE** — CLAHE 分區處理反而扭曲五官邊界
3. **不需要 Gaussian blur** — SSIM 0.993 已經夠穩定，模糊反而丟資訊
4. **深度路線不可行** — 單目深度推論不確定性太大，曲率場二階微分放大誤差
5. **骨骼比率有潛力** — 83% → 100% 穩定（BIN_WIDTH=0.25 + round()）
6. **策略轉向：大量擴充後篩選** — 67 比率覆蓋所有面部區域，篩選出 24 個穩定子集
7. **Bin 邊界是根本問題** — floor() 邊界在 0.x0，round() 移到 0.x5，加大 BIN_WIDTH 避開
8. **BIN_WIDTH=0.25 + round() 是最優組合** — 邊界在 0.125/0.375/0.625/0.875，所有比率安全避開
9. **統一系統可行** — 骨骼比率同時服務 3D 唯一 ID 和平面登入，不需要 CNN
10. **Anti-spoof 仍然需要** — MiniFASNet 防偽保留（612KB），CNN 13MB 不再需要

### 相關文件

| 文件 | 內容 |
|------|------|
| `docs/UNIQUE-FACE-ID.md` | 核心設計文件 |
| `docs/BONE-RATIO-SYSTEM.md` | 67 骨骼比率完整定義 |
| `docs/IMAGE-NORMALIZATION.md` | 正規化演算法規格 |
| `docs/face-structure-id-research.md` | 研究過程完整記錄 |
| `sdk/src/face/structuralId.ts` | SDK 模組 |
| `tools/face-id-test.html` | 測試頁面 |

---

## Phase 2.5: 滑動手勢辨識研究 🔄 進行中

**目標**: 驗證「往上滑解鎖」手勢作為行為辨識的第二層驗證

**核心概念**: 臉部辨識 → 確認 → 往上滑解鎖 → 滑動行為驗證（如 iPhone Face ID 後的解鎖手勢）

### 已完成

- [x] 觸控感測器調查 — Samsung SM-F9560 MotionEvent 測試
- [x] 觸控感測器結論 — pressure/orientation 無用，touchMajor/Minor 噪音太大
- [x] Capacitor 原生 App — NativeTouchPlugin.java（MOVE 事件 + 歷史採樣）
- [x] Swipe Up 手勢測試 — 路徑形狀 + 速度曲線 + 加速度特徵
- [x] **同指穩定性驗證** — 7 個特徵 SNR < 1 ✅
- [x] **不同指區分力驗證** — 7 個特徵 SNR > 2（最高 6.6）✅
- [x] PIN + Swipe 聯合測試 — PIN 時序 + 滑動手勢組合

### 進行中

- [ ] 不同人區分力驗證（同手指、不同人）
- [ ] 跨 session 穩定性驗證（隔天再測）
- [ ] 特徵量化 → bin hash → 確定性 ID
- [ ] 整合到 face-id-test.html（臉 + 滑動聯合測試）

### 關鍵發現

1. **觸控物理數據不可行** — Samsung 的 pressure=1.0, orientation=0.0, touchMajor CV>20%
2. **滑動手勢路徑+速度是正確方向** — 只需 x, y, timestamp，不依賴硬體
3. **8 個高 SNR 特徵**: endY(6.6), pathLength(5.4), straightness(4.4), xDrift(2.9), s50(2.5), maxSpeed(2.4), avgSpeed(2.2), s75(2.2)
4. **PIN 按鍵指紋 SNR 幾乎都 < 1** — 瀏覽器/原生觸控數據均不足以區分手指
5. **行為特徵 > 物理特徵** — 人的動作習慣比觸控感測器數據更穩定、更有區分力

### 測試工具

| 工具 | 路徑 | 說明 |
|------|------|------|
| 原生 App | `touch-test-app/` | Capacitor Android App，含 Swipe Up + PIN 測試 |
| PWA 測試 | `tools/face-id-test.html` | 瀏覽器版，臉 + 滑動聯合測試（待更新）|

---

## Phase 2: CNN 跨鏡頭穩定性驗證

**目標**: 驗證 MobileFaceNet 512 維 embedding 在不同前鏡頭下是否產出穩定的 LSH hash

### 任務清單

- [ ] 建立 `tools/face_stability_test.html` 測試工具
- [ ] 在 3+ 台不同裝置上拍攝同一人臉部
- [ ] 計算兩兩 cosine similarity
- [ ] 計算 LSH hash 漢明距離
- [ ] 不同人之間的對照測試
- [ ] 確定 LSH 位數和閾值

### 測試矩陣

| 裝置 | 前鏡頭 | 同一人 similarity | 不同人 similarity |
|------|--------|-------------------|-------------------|
| Samsung Z Fold | 12MP | ⏳ | ⏳ |
| iPhone | TrueDepth | ⏳ | ⏳ |
| 其他 Android | 待定 | ⏳ | ⏳ |

### 成功標準

- 同一人跨鏡頭 cosine similarity >= 0.75
- 同一人跨鏡頭 LSH 漢明距離 <= 40%
- 不同人 cosine similarity < 0.50
- FAR (False Accept Rate) < 0.1%
- FRR (False Reject Rate) < 5%

---

## Phase 3: 滑動手勢 + PIN 行為重新設計

**目標**: 以滑動手勢為主要行為辨識，PIN 時序為輔助

### 設計原則

- **主要辨識**: 往上滑手勢 — 路徑形狀 + 速度曲線（8 個高 SNR 特徵）
- **輔助驗證**: PIN 時序 — dwell/flight 比例（穩定但區分力低）
- **加密用途**: PIN 碼 → Argon2id → AES-256-GCM 加密身份包
- 只使用 x, y, timestamp — 不依賴觸控感測器硬體

### 滑動手勢特徵（8 維，已驗證）

| # | 名稱 | 說明 | 不同指 SNR |
|---|------|------|-----------|
| 1 | endY | 手指結束垂直位置 | 6.6 |
| 2 | pathLength | 滑動總路徑長度 | 5.4 |
| 3 | straightness | 路徑直線程度 | 4.4 |
| 4 | xDrift | 水平偏移量 | 2.9 |
| 5 | s50 | 50% 位置的速度 | 2.5 |
| 6 | maxSpeed | 最大速度 | 2.4 |
| 7 | avgSpeed | 平均速度 | 2.2 |
| 8 | s75 | 75% 位置的速度 | 2.2 |

### PIN 時序輔助特徵

| # | 名稱 | 說明 |
|---|------|------|
| 1-N | dwellProp | 各按鍵持續時間比例 |
| N+1-2N | flightProp | 各按鍵間飛行時間比例 |

### 已放棄的特徵

| 特徵 | 放棄原因 |
|------|---------|
| 觸控面積 touchMajor/Minor | 同指 CV > 20%，SNR < 1 |
| 壓力 pressure | Samsung 回報二元值 1.0 |
| 方向 orientation | Samsung 永遠 0.0 |
| PIN 按鍵比較 dw[i]v[j] | 同指不穩定，頻繁翻轉 |
| 觸控偏移角度 | iOS/Android 回報 0 |

### 任務清單

- [ ] 重寫 `behaviorFingerprint.ts` — 滑動特徵 + PIN 時序
- [ ] 新增 `swipeGesture.ts` — 滑動手勢特徵提取
- [ ] 更新 `lshFingerprint.ts` — 滑動 + PIN 聯合 LSH
- [ ] 整合到 face-id-test.html — 臉 + 滑動測試
- [ ] 不同人區分力驗證
- [ ] 跨裝置穩定性驗證

### 驗收標準

- [ ] 同指滑動 SNR < 1（穩定）
- [ ] 不同指滑動 SNR > 2（有區分力）
- [ ] 不同人滑動可區分
- [ ] 臉 + 滑動 聯合通過率 ≥ 90%

---

## Phase 4: 固定尺寸 PIN 鍵盤

**目標**: 建立 280x360px 固定尺寸 PIN 鍵盤元件

### 設計規格

```
┌──────────────────────────────┐
│        280px (固定)            │
│  ┌──────┬──────┬──────┐      │
│  │  1   │  2   │  3   │ 80px │
│  ├──────┼──────┼──────┤      │
│  │  4   │  5   │  6   │ 80px │ 360px
│  ├──────┼──────┼──────┤      │ (固定)
│  │  7   │  8   │  9   │ 80px │
│  ├──────┼──────┼──────┤      │
│  │  ⌫   │  0   │  ✓   │ 80px │
│  └──────┴──────┴──────┘      │
│     93px  93px  93px          │
│     居中顯示，不隨螢幕縮放     │
└──────────────────────────────┘
```

### 任務清單

- [ ] 建立 `components/FixedPinKeypad.tsx`
- [ ] 固定 280x360px，CSS `transform: none`
- [ ] 記錄每個鍵的中心座標常量
- [ ] Touch 事件收集（座標、時間、持續時間）
- [ ] 計算鍵內偏移（觸控點 - 鍵中心）
- [ ] 整合 usePinBehavior hook

### 驗收標準

- [ ] 所有裝置上鍵盤尺寸一致
- [ ] 觸控位置正確記錄
- [ ] 鍵內偏移計算正確

---

## Phase 5: LSH 系統升級

**目標**: 支援 Face 512 維和 Behavior 18 維兩套 LSH 配置

### 任務清單

- [ ] 新增 Face LSH 配置（512 維 → 128-bit hash）
- [ ] 更新 Behavior LSH 配置（18 維 → 64-bit hash）
- [ ] 實作 LSH 模糊匹配（漢明距離查詢）
- [ ] 實作 LSH Bucket Indexing（大規模用戶效能優化）
- [ ] 確定兩套 threshold
- [ ] 單元測試：同人/不同人的分布

### LSH 信心分數原理

```
LSH 不是傳統 hash（一點不同就天差地遠）。
LSH 的數學保證：越相似的向量 → hash 越像。

原理：N 個隨機超平面，每個超平面判斷向量在哪一側（0 或 1）
  → 相似向量在大多數超平面同側 → hash 大部分 bit 相同
  → 漢明距離小 → 相似度高

範例（64-bit behavior hash）：
  同一人兩次輸入：hash 差 5-8 bit → 相似度 87-92%
  不同人：hash 差 ~32 bit → 相似度 ~50%（隨機水平）
```

### LSH Bucket Indexing（效能優化）

```
問題：400 萬用戶，每次 lookup 掃全表算漢明距離？

解法：將 128-bit face hash 拆成 4 段 segment，建 4 個索引：

  hash = "a3b5c7d9" | "e1f2a3b4" | "c5d6e7f8" | "91a2b3c4"
         segment_0    segment_1    segment_2    segment_3

  CREATE INDEX idx_ia_seg0 ON identity_anchors(face_seg_0);
  CREATE INDEX idx_ia_seg1 ON identity_anchors(face_seg_1);
  CREATE INDEX idx_ia_seg2 ON identity_anchors(face_seg_2);
  CREATE INDEX idx_ia_seg3 ON identity_anchors(face_seg_3);

查詢流程：
  1. 拆查詢 hash 為 4 段
  2. 任何一段完全匹配 → 進入候選人列表
  3. 只對候選人算全 128-bit 漢明距離
  4. 400 萬 → 縮小到 ~100 候選人 → 微秒級完成

原理：真正相似的 hash 至少有一段 segment 完全相同
     （128 bit 差 20 bit，平均每段差 5 bit，
      4 段中至少 1 段 0 差異的機率很高）

萬級用戶階段：直接全表掃描也只需毫秒，不需要 bucket
百萬級以上：必須啟用 bucket indexing
```

### LSH 配置

```typescript
const FACE_LSH_CONFIG = {
  dimensions: 512,
  numBits: 128,
  seed: 20260314,
};

const BEHAVIOR_LSH_CONFIG = {
  dimensions: 18,
  numBits: 64,
  seed: 20260315,
};
```

---

## Phase 6: VPS 三表資料庫

**目標**: 在 VPS SQLite 建立三表分離架構

### 任務清單

- [ ] 建立 `api/database.py` — 三表 schema
- [ ] identity_anchors 表 + 索引
- [ ] credit_scores 表 + 索引
- [ ] registration_rate_limits 表 + 索引 + TTL
- [ ] 建立 `api/cleanup.py` — 48hr 過期清除 cron
- [ ] 遷移現有 `registration_fingerprints` 資料
- [ ] 遷移現有 `account_risk_scores` 資料

### Schema

```sql
-- 表 1：永久，身份查找
CREATE TABLE identity_anchors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    face_lsh_hash TEXT NOT NULL,
    behavior_lsh_hash TEXT,
    encrypted_blob BLOB NOT NULL,
    blob_salt TEXT NOT NULL,
    blob_iv TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 表 2：永久，信用分數
CREATE TABLE credit_scores (
    credit_token TEXT PRIMARY KEY,
    risk_score REAL DEFAULT 0,
    l2_trigger_count INTEGER DEFAULT 0,
    l3_trigger_count INTEGER DEFAULT 0,
    complaint_count INTEGER DEFAULT 0,
    last_trigger_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 表 3：短期，防濫用
CREATE TABLE registration_rate_limits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL,
    dimension TEXT NOT NULL,
    count INTEGER DEFAULT 1,
    first_seen INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
```

---

## Phase 7: VPS API — 註冊與查找

**目標**: 實作核心 API endpoints

### 端點

| 方法 | 路徑 | 用途 |
|------|------|------|
| POST | /aegisid/register | 註冊身份 + 上傳加密身份包 |
| POST | /aegisid/lookup | 刷臉+行為查找 → 返回身份包 |
| POST | /aegisid/credit/update | 更新信用分數 |
| POST | /aegisid/credit/query | 批量查詢信用 |
| GET | /aegisid/health | 健康檢查 |

### 任務清單

- [ ] 建立 `api/main.py` — FastAPI app
- [ ] 實作 /aegisid/register
- [ ] 實作 /aegisid/lookup
- [ ] 實作 /aegisid/credit/update
- [ ] 實作 /aegisid/credit/query
- [ ] 建立 `api/hmac_service.py` — 6 個 HMAC secret 管理
- [ ] 整合到現有 VPS API 服務
- [ ] CORS 設定

---

## Phase 8: 聯合信心分數

**目標**: 實作 face + behavior 聯合評分

### 公式

```
confidence = face_similarity * 0.6 + behavior_similarity * 0.4

face_similarity = 1 - (hamming_distance / total_bits)
  例：128-bit hash，漢明距離 12 → 1 - 12/128 = 0.906

behavior_similarity = 1 - (hamming_distance / total_bits)
  例：64-bit hash，漢明距離 8 → 1 - 8/64 = 0.875
```

### 完整查詢流程

```
VPS 收到 lookup 請求：
  face_lsh_hash = "a3b5..." (128 bits)
  behavior_lsh_hash = "c7d9..." (64 bits)

1. Bucket Indexing 快速篩選：
   拆 face hash 為 4 段 → 索引查詢 → 候選人列表（~100 人）

2. 每個候選人算漢明距離：
   候選人 1：
     face 漢明距離 = 12/128 → face_sim = 0.906
     behavior 漢明距離 = 8/64 → behavior_sim = 0.875
     confidence = 0.906 × 0.6 + 0.875 × 0.4 = 0.894 ✅

   候選人 2：
     face 漢明距離 = 58/128 → face_sim = 0.547
     behavior 漢明距離 = 30/64 → behavior_sim = 0.531
     confidence = 0.547 × 0.6 + 0.531 × 0.4 = 0.541 ❌

3. 取 confidence 最高且 >= 0.80 → 返回 encrypted_blob
```

### 判定邏輯

| confidence | 動作 |
|-----------|------|
| >= 0.80 | 確認同一人，返回 blob |
| 0.60~0.79 | 要求額外驗證（再輸一次 PIN） |
| < 0.60 | 拒絕 |

### 防禦矩陣

| 場景 | face | behavior | confidence | 結果 |
|------|------|----------|-----------|------|
| 本人 | 0.90 | 0.85 | 0.88 | 通過 |
| 雙胞胎 | 0.90 | 0.20 | 0.62 | 額外驗證 |
| 深偽 | 0.90 | 0.00 | 0.54 | 拒絕 |
| 陌生人 | 0.30 | 0.30 | 0.30 | 拒絕 |

### 任務清單

- [ ] 建立 `api/confidence.py`
- [ ] LSH 漢明距離 → 相似度轉換
- [ ] 加權聯合分數計算
- [ ] 候選人排序（多個 face 匹配時）
- [ ] 閾值可配置
- [ ] 單元測試

---

## Phase 9: 加密身份包

**目標**: 實作身份包的加密/解密/存儲

### 身份包內容

```typescript
interface IdentityBlob {
  privateKey: string;           // Ed25519 私鑰 base64
  behaviorBaseline: number[];   // 18 維行為基線
  signedPreKey?: string;        // Signal Protocol
  createdAt: number;
}
```

### 加密方式

```
Argon2id(PIN, random_salt) → AES-256-GCM key
AES-256-GCM(identityBlob_json, key) → encrypted_blob
```

### 任務清單

- [ ] 建立 `sdk/src/identity/identityBlob.ts`
- [ ] 加密：PIN → Argon2id → AES-256-GCM 加密
- [ ] 解密：PIN → Argon2id → AES-256-GCM 解密
- [ ] 序列化/反序列化 IdentityBlob
- [ ] 上傳到 VPS API
- [ ] 從 VPS API 下載

---

## Phase 10: 防批量建號 (Rate Limiting)

**目標**: 多維度 HMAC rate limiting，48hr TTL

### 維度

| 維度 | HMAC input | Secret |
|------|-----------|--------|
| IP | ip_hash | AEGISID_SECRET_IP |
| 裝置 | canvas+webgl hash | AEGISID_SECRET_DEVICE |
| 臉部 | face_lsh_hash | AEGISID_SECRET_FACE |
| 行為 | behavior_lsh_hash | AEGISID_SECRET_BEHAVIOR |

### 閾值

| 維度 | 1hr 閾值 | 24hr 閾值 | 動作 |
|------|---------|----------|------|
| IP | 5+ 可疑 | 15+ 阻擋 | 加分 |
| 裝置 | 3+ 阻擋 | 5+ 阻擋 | 加分 |
| 臉部 | 2+ 可疑 | 3+ 阻擋 | 加分 |
| 行為 | 3+ 可疑 | 5+ 阻擋 | 加分 |

### 任務清單

- [ ] 建立 `api/rate_limiter.py`
- [ ] 4 維度 HMAC token 計算
- [ ] 各維度獨立查詢計數
- [ ] 綜合風險評分
- [ ] 48hr cron 清除
- [ ] 遷移現有 registration_fingerprints 邏輯

---

## Phase 11: 信用分數系統

**目標**: 匿名信用累積，供未來交易風控

### 任務清單

- [ ] 建立 `sdk/src/credit/creditToken.ts`
- [ ] 客戶端 HMAC(pubkey_hash, client_secret) 生成
- [ ] 整合 AegisTalk 的 trustScore.ts
- [ ] 遷移現有 account_risk_scores 資料
- [ ] API：批量查詢

---

## Phase 12: AegisTalk 整合

**目標**: AegisTalk 引入 AegisID SDK

### 任務清單

- [ ] 發布 SDK 為 npm 套件（或本地引用）
- [ ] AegisTalk AuthScreen 改用 FixedPinKeypad
- [ ] 註冊流程加入 VPS 身份包上傳
- [ ] passkey-recovery 改為 FaceID + PIN 恢復
- [ ] 日常登入保持不變（本地驗證）
- [ ] trustScore.ts 遷移到 AegisID credit

---

## Phase 13: 跨裝置恢復流程

**目標**: 刷臉 + PIN → VPS 查找 → 解密身份包 → 登入

### 流程

```
1. App 首次啟動 → 偵測無帳號
2.「我已有帳號」→ 刷臉（CNN）→ face_lsh_hash
3. 輸入 PIN → behavior_lsh_hash + Argon2id key
4. POST /aegisid/lookup → 聯合信心分數
5. confidence >= 0.80 → 返回 encrypted_blob
6. Argon2id(PIN) 解密 → 得到 privateKey
7. 驗證：行為 baseline 比對 → 確認本人
8. 登入完成
```

### 任務清單

- [ ] 建立恢復 UI 元件
- [ ] 整合 CNN + PIN → VPS lookup
- [ ] 解密後的本地初始化
- [ ] MQTT 連線 + 離線訊息恢復
- [ ] Cloud Backup 恢復（如果有）

---

## Phase 14: LINE PWA 註冊流程

**目標**: LINE 連結 → PWA → 正式帳號註冊

### 流程

```
A 在 LINE 丟連結 → B 點開 → LINE WebView
→ AegisTalk 介紹頁
→「註冊帳號」
→ 標準流程：刷臉(CNN) + 設定 PIN
→ 身份包上傳 VPS
→ 進入與 A 的 E2EE 安全對話
→ 信用開始累積

日後 B 下載 App：
→ 刷臉 + PIN → 從 VPS 恢復 → 同帳號
```

### 任務清單

- [ ] LINE WebView 相容性測試（camera API、localStorage）
- [ ] 邀請連結格式設計
- [ ] 註冊引導 UI（介紹頁 → PIN → FaceID）
- [ ] 身份包上傳
- [ ] LINE WebView localStorage 不穩定的 fallback

---

## Phase 15: 穩定性調優 + 閾值校準

**目標**: 用真實用戶資料調整所有閾值

### 任務清單

- [ ] 收集 50+ 用戶的 face embedding 跨裝置資料
- [ ] 收集 50+ 用戶的 PIN 行為跨裝置資料
- [ ] ROC 曲線分析 → 最佳閾值
- [ ] 信心分數權重調整（0.6/0.4 不一定最優）
- [ ] Rate limiting 閾值調整
- [ ] 文檔更新

---

## 里程碑

| 里程碑 | 目標日期 | 內容 |
|--------|----------|------|
| M1 | Phase 2 完成 | CNN 跨鏡頭穩定性驗證通過 |
| M2 | Phase 5 完成 | LSH 系統升級完成 |
| M3 | Phase 8 完成 | VPS API + 聯合信心分數可用 |
| M4 | Phase 12 完成 | AegisTalk 整合完成 |
| M5 | Phase 14 完成 | LINE PWA 註冊流程可用 |
| M6 | Phase 15 完成 | 閾值校準，準備上線 |

---

**維護者**: AegisRD Team
**建立日期**: 2026-03-14
