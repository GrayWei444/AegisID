# AegisID 唯一臉部 ID 設計文件

> **版本**: 3.0.0
> **日期**: 2026-03-20
> **狀態**: v14 統一架構 — 3D 註冊 + 平面登入，24/24 比率穩定
> **測試頁面**: https://aegisrd.com/face-id-test/

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

### 1.3 統一架構（v14）

**一套骨骼比率系統做到底**，取代雙軌 CNN+骨骼。MobileFaceNet CNN 不再需要。

```
                    ┌─────────────────────────────────────┐
                    │          AegisID v14 認證            │
                    │                                     │
  ┌─────────────────┼─────────────────────────────────────┼──┐
  │ 註冊/帳號恢復    │                                     │  │
  │                 │  3D 轉頭掃描                         │  │
  │  landmarks ×N → 3D 重建 → 24 骨骼 bins → SHA-256     │  │
  │                 │  + Anti-spoof + PIN 行為指紋         │  │
  │                 │  → 唯一 ID 上傳 VPS（防重複建號）     │  │
  │                 │  → 正面基準存本機（供登入比對）       │  │
  ├─────────────────┼─────────────────────────────────────┤  │
  │ 日常登入        │                                     │  │
  │                 │  平面刷臉                            │  │
  │  landmarks → 24 骨骼 bins → 比對本機正面基準          │  │
  │                 │  + Anti-spoof + PIN 碼               │  │
  │                 │  → bin match ≥ 80% → 通過           │  │
  └─────────────────┴─────────────────────────────────────┘  │
                    │                                        │
                    │  每個唯一 ID 綁定詐騙風險分數           │
                    │  （跟著臉走，不跟裝置）                 │
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

## 6. 統一架構（v14 確定版）

### 6.1 最終參數

```
量化方式: round()（邊界移至 0.125, 0.375, 0.625, 0.875）
BIN_WIDTH: 0.25
穩定比率: 24 個（從 67 個篩選）
3D 重建: MediaPipe landmarks × 多角度 → inverse rotation → canonical → median
測試結果: 3 輪 3D Multi-Test → 24/24 bins 100% 一致 ✅
區分力: 24 ratios × ~5 bins = 5^24 ≈ 6×10^16 組合
```

### 6.2 穩定比率白名單（24 個）

```
F01, F03,
EL02, EL04, EL06, EL08,
ER02, ER03, ER04, ER06, ER08,
B01, B02, B04, B06,
N01, N02,
M04, M07,
J02, J03, J05,
X03, X05
```

### 6.3 註冊流程（3D 掃描 + PIN 行為）

```
轉頭 3D 掃描（15s 自動截圖）
    ↓
MediaPipe 468 landmarks × 多角度
    ↓
3D 重建（inverse rotation → canonical space → median fusion）
    ↓
24 穩定骨骼比率 → round(v / 0.25) → bin indices
    ↓
SHA-256(F01:bin|F03:bin|...) = 唯一 Face ID
    ↓
同時：取最佳正面幀 → 2D 骨骼 bins → 存本機（登入基準）
    ↓
+ Anti-spoof 防偽 + PIN 行為指紋（防雙胞胎）
    ↓
上傳 VPS: face_structure_hash + encrypted_blob + fraud_risk_score
    ↓
VPS 查重: hash 已存在? → 拒絕（同一張臉已有帳號）
                        → 允許，儲存新身份
```

### 6.4 日常登入流程（平面刷臉）

```
平面刷臉（5 幀取 median）
    ↓
24 骨骼比率 → bins
    ↓
比對本機存的正面基準 bins
    ↓
bin match rate 計算
    ↓
≥ 80% → 通過    + Anti-spoof ✓ + PIN ✓ → 放行
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

### Phase A：穩定性篩選 ✅ 完成

- [x] 影像正規化管線 — SSIM 0.993 ✅
- [x] 骨骼比率擴充到 67 個 ✅
- [x] 3D 視頻掃描 + 自動截圖 ✅
- [x] Bin 邊界研究 — floor() vs round()，BIN_WIDTH 最佳化 ✅
- [x] BIN_WIDTH=0.25 + round() → 24/24 穩定 ✅
- [x] 3D Multi-Test 3 輪全部一致 ✅

### Phase B：登入驗證（進行中）

- [x] 正面基準提取 — 3D 掃描時自動取最佳正面幀 ✅
- [x] Login Test 模式 — 平面刷臉 vs 正面基準 ✅
- [ ] 3D vs 平面 match rate 驗證（目標 ≥80%）
- [ ] 多次登入穩定性測試

### Phase C：區分力驗證

- [ ] 至少 3 個不同人各掃 3 次 3D
- [ ] 確認不同人的唯一 ID 不同
- [ ] 確認不同人的登入 bin match < 65%

### Phase D：SDK + VPS 整合

- [ ] 實作 `structuralId.ts` 完整模組（3D 重建 + 登入比對）
- [ ] VPS `aegisid/register` 改用 face_structure_hash
- [ ] VPS `identity_anchors` 表新增 face_structure_hash 欄位
- [ ] VPS `credit_scores` 表 key 改為 face_structure_hash
- [ ] 日常登入流程實作

### Phase E：PIN 聯合 + 詐騙分數

- [ ] 註冊時 PIN 行為指紋聯合（防雙胞胎）
- [ ] 詐騙風險分數初始化與更新機制
- [ ] 跨裝置恢復端到端測試
- [ ] AegisPay 收款人信任查詢整合

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
