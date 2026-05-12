# AegisID 唯一臉部 ID 設計文件

> **版本**: 4.0.0
> **日期**: 2026-05-04
> **狀態**: v17 SDK 已落地（25 個 2D + 11 個 3D），v15 研究路線並行（26 特徵 41/41 hash 一致）
> **測試頁面**: https://aegisrd.com/face-id-test/

---

## 0. 版本演進

| 版本 | 日期 | 特徵集 | 量化 | 狀態 |
|------|------|--------|------|------|
| v14 | 2026-03-20 | 24 個 3D 比率 | round(), BIN=0.25 | 已被 v17 取代 |
| **v17** | **2026-03-22** | **25 個 2D + 11 個 3D 混合** | **floor-biased (frac≥0.80 ceil)** | **✅ SDK 已實作** |
| v15 研究 | 2026-04-16 | 26 個特徵（offset=0 嚴格篩選） | round(), offset=0 | 41/41 同人 hash 一致；跨人未驗證；**未整合進 SDK** |

---

## 1. 目標：唯一 ID，不是辨識通過

### 1.1 核心差異

**傳統臉部辨識**（Apple FaceID、MobileFaceNet）：
```
f(臉A, 臉B) → similarity > threshold → 通過/不通過
```
每次產出不同的 embedding，只要「夠接近」就通過。這是**模糊匹配**。

**AegisID 唯一 ID**：
```
f(同一張臉, 任意條件) → 永遠相同的唯一 ID
f(不同人的臉) → 永遠不同的唯一 ID
```
同一個人不管什麼時間、什麼光線、什麼裝置掃臉，ID 永遠相同。
這是**確定性唯一身份**。

### 1.2 為什麼需要唯一 ID

| 需求 | 模糊匹配 | 唯一 ID |
|------|:---:|:---:|
| 解鎖手機 | ✅ | ✅ |
| 防批量建號（同一張臉不能建第二個帳號）| ⚠️ 需要 1:N 遍歷 | ✅ 直接 hash 查重 |
| 跨裝置恢復帳號 | ⚠️ 需要保存 embedding | ✅ 重新掃臉 = 同一個 ID |
| 去中心化身份（無伺服器也能驗證）| ❌ | ✅ hash 比對即可 |
| 隱私保護（伺服器只存 hash）| ⚠️ embedding 可反推 | ✅ hash 不可逆 |
| AegisPay 收款人信任分數 | ⚠️ 需要 embedding 比對 | ✅ 直接用 ID 查表 |

**核心價值**：唯一 ID 讓 AegisID 從「辨識工具」升級為「身份基礎設施」。
帳號不再綁定裝置或電話號碼，而是綁定臉本身。

### 1.3 統一架構（v17 SDK）

**一套骨骼比率系統做到底**，取代雙軌 CNN+骨骼。MobileFaceNet CNN 不再需要。

```
                    ┌─────────────────────────────────────┐
                    │          AegisID v17 認證            │
                    │                                     │
  ┌─────────────────┼─────────────────────────────────────┼──┐
  │ 註冊/帳號恢復    │                                     │  │
  │                 │  3D 轉頭掃描                         │  │
  │  landmarks ×N → 真 3D 三角測量（multi-ray LSQ）      │  │
  │                 │  → 25 個 2D bins + 11 個 3D bins   │  │
  │                 │  → hash2D + hash3D → SHA-256(comb) │  │
  │                 │  + Anti-spoof + 活體挑戰 + PIN      │  │
  │                 │  → 唯一 ID 上傳 VPS（防重複建號）     │  │
  │                 │  → 正面基準存本機（供登入比對）       │  │
  ├─────────────────┼─────────────────────────────────────┤  │
  │ 日常登入        │                                     │  │
  │                 │  活體挑戰: blink → turn_head        │  │
  │                 │  （遇口罩動態注入 remove_mask）      │  │
  │                 │  平面刷臉                            │  │
  │  landmarks → 25 個 2D bins → 比對本機正面基準        │  │
  │                 │  + Anti-spoof + PIN 碼               │  │
  │                 │  → bin match ≥ 80% → 通過           │  │
  └─────────────────┴─────────────────────────────────────┘  │
                    │                                        │
                    │  每個 account_key 綁定詐騙風險分數      │
                    │  （跟臉+PIN 走，不跟裝置）              │
                    └────────────────────────────────────────┘
```

---

## 2. 已驗證：影像正規化管線

> 詳見 [IMAGE-NORMALIZATION.md](IMAGE-NORMALIZATION.md)

### 2.1 管線架構

```
相機 RGB 原圖
    ↓
MediaPipe FaceLandmarker → 468 landmarks
    ↓
ArcFace 5 點 similarity transform → 112×112 aligned
    ↓
RGB → Grayscale（加權灰度: 0.299R + 0.587G + 0.114B）
    ↓
全局直方圖均衡化（Histogram Equalization）
    ↓
橢圓臉部遮罩（中心 56,68 半徑 40×44）→ 遮罩外固定 128
    ↓
正規化灰度圖 112×112 ← 所有後續特徵提取的輸入
```

### 2.2 驗證結果（2026-03-20）

| 指標 | 結果 | 判定 |
|------|------|------|
| SSIM | avg 0.993, min 0.991 | ✅ >0.95 |
| pHash 4×4 (15bit) | 100% exact match | ✅ 5/5 全部相同 |
| maxΔ (像素差) | 39-105 | ✅ 可接受範圍 |

### 2.3 棄用方案

| 方案 | 棄用原因 |
|------|---------|
| CLAHE (分區均衡) | 扭曲五官邊界結構 |
| Gaussian blur | 磨掉五官細節 |
| DoG (Difference of Gaussians) | 1px 漂移被放大，SSIM 降至 0.43 |

---

## 3. 主要特徵路線：骨骼比率

> 詳見 [BONE-RATIO-SYSTEM.md](BONE-RATIO-SYSTEM.md)

### 3.1 策略：大量擴充 → 嚴格篩選

```
Phase 1: 系統性擴充（12 → 30 → 67 個比率）✅ 已完成
Phase 2: L1 測試（頭不動）→ 淘汰不穩定比率      ← 當前階段
Phase 3: L2-L5 測試（轉頭、不同距離、不同光線、不同裝置）
Phase 4: 最終保留 20-30 個在所有條件下穩定的比率
```

### 3.2 67 個比率覆蓋

| 類別 | 數量 | 覆蓋範圍 |
|------|------|---------|
| F 臉部比例 | 7 | 臉寬高比、三庭比、對稱性 |
| EL 左眼 | 8 | 寬高比、到鼻距離、眼眉距 |
| ER 右眼 | 8 | 同左眼鏡像 |
| B 眉毛 | 8 | 眉峰高度、眉間距、眉長 |
| N 鼻子 | 10 | 鼻翼寬、鼻長、鼻底、對稱 |
| M 嘴巴 | 10 | 嘴寬、唇厚比、人中、對稱 |
| J 下顎顴骨 | 8 | 下顎角寬、顴骨寬、對稱 |
| X 交叉特徵 | 8 | 鼻眼比、眼嘴比、三庭、五眼 |
| **合計** | **67** | |

### 3.3 初步數據

- 12 比率版本：10/12 穩定 (83%)
  - 不穩定：r03 (中臉/臉高) 和 r11 (右眼開度/IPD) → 已識別
- bin width 0.05，每個比率約 8-12 個 bin
- 正規化管線 SSIM 0.993 作為基礎

### 3.4 區分力估算

如果最終保留 20 個穩定比率：
```
20 比率 × ~10 bins/比率 = 10^20 理論組合
考慮相關性，有效空間 ~10^12 = 1 萬億
遠超唯一 ID 需求 ✅
```

---

## 4. 輔助特徵：pHash 預篩

### 4.1 pHash 4×4 (15 bit)

- **穩定性**: 100% exact match ✅
- **區分力**: 32,768 組合，不夠做唯一 ID
- **用途**: 快速預篩 — pHash 相同 → 可能是同一人 → 進一步比對骨骼

### 4.2 pHash 8×8 (63 bit)

- **穩定性**: 2-4 bit 漂移（median 附近跳動）
- **區分力**: 2^63 組合，足夠
- **現狀**: 不夠穩定，暫不使用

---

## 5. 已放棄的路線

### 5.1 深度曲率場（Depth Anything V2）— ❌ 已放棄

**測試數據**: 穩定性 12.3/48 (26%)，等於隨機水平。

**失敗原因**:
1. Depth Anything V2 單次推論不確定性太大
2. Laplacian 曲率場是二階微分，推論誤差被放大
3. bin width 0.002 太細，但即使加大也無法拯救底層不確定性
4. 手機端 WASM 推論 ~12,600ms + OOM 風險

**結論**: 單目深度在手機端無法達到確定性 hash 所需的穩定度。

### 5.2 純 CNN Embedding Hash — ❌ 概念不可行

CNN 推論有浮點精度差異，每次結果不完全相同。無法做確定性 hash。
保留作為輔助驗證（cosine similarity），不用於唯一 ID。

### 5.3 Landmark 座標比率（早期方案）— ⚠️ 部分可行

早期結論認為 landmark 比率不穩定。擴充到 67 個後重新評估中。
關鍵改進：
- 使用 ArcFace 對齊後的座標（消除旋轉/平移）
- 大量擴充後篩選穩定子集
- 配合影像正規化管線（SSIM 0.993）

---

## 6. 統一架構（v17 SDK 確定版）

### 6.1 最終參數

```
量化方式: floor-biased (frac ≥ 0.80 才 ceil，否則 floor)
BIN_WIDTH: 0.25
穩定 2D 比率: 25 個（STABLE_RATIO_WHITELIST）
穩定 3D 特徵: 11 個（STABLE_3D_FEATURES，T/E/N/F/G 類）
基準正規化: 垂直 → fh, 水平 → (IPD + browW) / 2, 自比率不需基準
3D 重建: 真 multi-ray least-squares 三角測量（landmark-based yaw，不依賴 MediaPipe matrix）
測試結果: 3/3 同人重複掃描 hash 一致 ✅
聯合 hash: hashCombined = SHA-256(hash2D + hash3D)
account_key = SHA-256(hashCombined + PIN)
```

### 6.2 穩定比率白名單

**2D（25 個）— `STABLE_RATIO_WHITELIST`：**
```
F02, F03,
EL02, EL03, EL04, EL06, EL08,
ER02, ER03, ER04, ER06, ER08,
B01, B02, B04, B05, B06, B07,
N01, N02, N03, N04, N10,
X03, X05
```

**3D（11 個）— `STABLE_3D_FEATURES`：**
```
T01_temple_width        T03_cheek_jaw_ratio    E04_orbital_width_R
E05_intercanthal        N05_alar_width_3d      F05_face_side
G02_face_width_height   T02_temple_recess      T05_bizygomatic
E03_orbital_width_L     F04_bigonial
```

### 6.2b v15 並行研究（尚未整合進 SDK）

[docs/RESEARCH-REPORT-UNIQUE-FACE-HASH.md](RESEARCH-REPORT-UNIQUE-FACE-HASH.md) 提出 26 個經 offset=0 嚴格篩選 + 5 sessions 黑名單過濾的特徵，41 captures hash 100% 一致。SDK 整合是 M3（2026-05-15）目標。

### 6.3 註冊流程（3D 掃描 + 活體挑戰 + PIN）

```
活體挑戰序列 (liveness.ts)：
  blink → turn_head（口罩偵測時自動注入 remove_mask 到序列最前）
    ↓
轉頭 3D 掃描（15s 自動截圖，turn_head 完成後停留 2.5s 爭取 VPS 查詢時間）
    ↓
MediaPipe 468 landmarks × 多角度（GPU/CPU 自動 fallback）
    ↓
真 3D 三角測量（multi-ray least-squares）→ 3D landmarks
    ↓
正面 median 幀 + 全量 3D landmarks
    ↓
25 個 2D 比率 + 11 個 3D 特徵 → floor-biased 量化（BIN_WIDTH=0.25）
    ↓
hash2D = SHA-256(2D bin 序列)
hash3D = SHA-256(3D bin 序列)
hashCombined = SHA-256(hash2D + hash3D)  ← face_hash
    ↓
同時：正面 2D 骨骼 bins → 存本機（登入基準）
    ↓
+ Anti-spoof 防偽（MiniFASNetV2SE）
+ PIN → Argon2id → 加密 key
    ↓
account_key = SHA-256(hashCombined + PIN)
上傳 VPS:
  - face_hash → registration_rate_limits（限速，48hr TTL）
  - account_key + encrypted_blob → identity_anchors（永久）
```

### 6.4 日常登入流程（平面刷臉）

```
活體挑戰: blink → turn_head（口罩偵測時加 remove_mask）
    ↓
平面刷臉（5 幀取 median）
    ↓
25 個 2D 比率 → bins
    ↓
比對本機存的正面基準 bins
    ↓
bin match rate 計算（matchLoginBins）
    ↓
≥ 80% (LOGIN_MATCH_THRESHOLD) → 通過 + Anti-spoof ✓ + PIN ✓ → 放行
65-79% → 額外驗證
< 65% → 拒絕
```

### 6.5 帳號恢復流程

```
新裝置 → 轉頭 3D 掃描 → SHA-256 唯一 ID
    ↓
VPS 查表 O(1) → 找到 face_structure_hash
    ↓
返回 encrypted_blob
    ↓
輸入 PIN → Argon2id 解密 → 恢復帳號
```

### 6.6 詐騙風險分數

```
每個 face_structure_hash 綁定一個 fraud_risk_score
    ↓
同一張臉 = 同一個風險分數（跟臉走，不跟裝置）
    ↓
AegisPay 收款人信任: 掃臉 → 唯一 ID → 查風險分數
    ↓
信用累積: 正常交易 → 分數降低（風險低）
         詐騙報告 → 分數升高（風險高）
```

---

## 7. 後續步驟

### Phase A：v14 穩定性篩選 ✅ 完成（已被 v17 取代）

- [x] 影像正規化管線 — SSIM 0.993 ✅
- [x] 骨骼比率擴充到 67 個 ✅
- [x] 3D 視頻掃描 + 自動截圖 ✅
- [x] Bin 邊界研究 — floor() vs round()，BIN_WIDTH 最佳化 ✅
- [x] BIN_WIDTH=0.25 + round() → v14 24/24 穩定 ✅
- [x] 3D Multi-Test 3 輪全部一致 ✅

### Phase B：v17 SDK 落地 ✅ 完成（2026-03-22）

- [x] 多基準正規化（fh / (IPD+browW)/2 / 自比率） ✅
- [x] floor-biased 量化（frac≥0.80 才 ceil） ✅
- [x] 真 3D 三角測量（multi-ray LSQ） ✅
- [x] 25 個 2D + 11 個 3D 混合特徵集 ✅
- [x] hash2D + hash3D 聯合 ✅
- [x] SDK structuralId.ts 完整實作 ✅
- [x] AegisTalk hook 整合 ✅
- [x] 3/3 同人重複掃描 hash 一致 ✅

### Phase B+：活體 + GPU/CPU + 防偽 ✅ 完成（2026-04~05）

- [x] 活體挑戰 blink + turn_head ✅
- [x] 自適應 EAR 眨眼偵測（相對下降取代絕對閾值） ✅
- [x] 口罩偵測（HSV AND Blendshape 雙重判定） ✅
- [x] remove_mask 動態挑戰注入 ✅
- [x] turn_head 完成後停留 2.5s（爭取 VPS 查詢時間） ✅
- [x] GPU/CPU 自動 fallback ✅（[FACE-GPU-FALLBACK.md](FACE-GPU-FALLBACK.md)）

### Phase C：v15 進一步穩定性研究 ✅ 完成（2026-04-16）

- [x] 5 sessions × 41 captures 跨光線/表情/配飾測試 ✅
- [x] offset=0 嚴格篩選 → 26 個跨 sessions 100% bin 一致特徵 ✅
- [x] 黑名單法剔除表情/配飾敏感特徵 ✅
- [ ] 跨人區分性驗證（M1 目標 2026-04-20，**已逾期**）
- [ ] 整合進 SDK structuralId.ts（M3 目標 2026-05-15）

### Phase D：VPS 整合 + 跨裝置恢復

- [x] VPS `identity_anchors` + `credit_scores` + `rate_limits` 三表分離 ✅
- [x] account_key + encrypted_blob 上傳機制 ✅
- [ ] 跨裝置恢復端到端測試
- [ ] AegisPay 收款人信任查詢整合

### Phase E：已知 bug 修復

- [ ] 半臉攻擊防護（landmark visibility 檢查）— 嚴重度高
- [ ] 口罩判定誤判（白皮膚冷光下 skinRatio 偏低）— 嚴重度中

---

## 8. 關鍵文件索引

| 文件 | 內容 |
|------|------|
| [BONE-RATIO-SYSTEM.md](BONE-RATIO-SYSTEM.md) | 67 個骨骼比率完整定義、篩選方法論 |
| [IMAGE-NORMALIZATION.md](IMAGE-NORMALIZATION.md) | 正規化管線演算法規格（已驗證）|
| [face-structure-id-research.md](face-structure-id-research.md) | 完整研究過程記錄 |
| `sdk/src/face/structuralId.ts` | SDK 實作模組 |
| `tools/face-id-test.html` | 測試頁面原始碼 |

---

**維護者**: AegisRD Team
**建立日期**: 2026-03-20
