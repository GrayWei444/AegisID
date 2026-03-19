# AegisID 唯一臉部結構 ID 研究報告

> **版本**: 0.2.0
> **日期**: 2026-03-19
> **目標**: 同一張臉 → 任何時間、任何光線、任何角度 → 永遠同一個 hash ID
> **測試頁面**: https://aegisrd.com/face-id-test/

---

## 1. 目標

```
f(任意條件下拍的同一張臉) → 永遠相同的 SHA-256 hash
f(不同人的臉) → 永遠不同的 SHA-256 hash
```

不是模糊匹配（similarity > threshold），是確定性的唯一 ID。

---

## 2. 核心架構：確定性影像處理管線

```
相機 RGB 原圖
    ↓
┌─────────────────────────────────────────────┐
│ Stage 1: 幾何正規化（消除位置/旋轉/縮放）    │
│   ArcFace 5 點 similarity transform → 112×112 │
│   已有實作: cnnInference.ts                    │
└─────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────┐
│ Stage 2: 光線正規化（消除亮度/對比/色溫）    │
│   ① 灰度化（消除色溫差異）                    │
│   ② CLAHE 自適應直方圖均衡化（消除局部明暗）  │
│   ③ Gaussian blur σ=1（消除相機感測器雜訊）   │
│   目標: 同一張臉在不同光線下 → 相同灰度圖    │
└─────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────┐
│ Stage 3: 結構特徵提取（確定性算法，無 CNN）   │
│   Path A: Gabor filter bank                   │
│   Path B: 深度圖 → Laplacian 曲率場           │
│   Path C: LBP 紋理模式                        │
│   同輸入 → 永遠同輸出，零隨機性               │
└─────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────┐
│ Stage 4: 量化 → hash                         │
│   特徵值 → 量化 bin → 串接 → SHA-256          │
│   正規化夠好 → 同一人的特徵值差異小於 bin 寬度 │
│   → hash 永遠相同                              │
└─────────────────────────────────────────────┘
    ↓
Face Structure ID (SHA-256)
    +
PIN 行為指紋 hash
    ↓
AegisID 唯一身份
```

**核心思路**: 問題不在量化，不在取樣幾幀。問題在 Stage 2 和 Stage 3 — 如果正規化能把光線/雜訊的影響完全消除，那同一張臉每次經過管線後得到的數據就是一樣的，hash 自然一樣。

---

## 3. Stage 2: 光線正規化（核心優化點）

### 3.1 為什麼光線是最大敵人

測試中 hash 不穩定的根因：即使頭不動，環境光的微小變化（螢幕反光、身體微動造成的陰影變化）改變了像素值，進而改變所有下游特徵。

Apple FaceID 用 IR 結構光，完全不受環境光影響。我們用 RGB 相機，必須用軟體消除光線影響。

### 3.2 正規化管線

```
ArcFace aligned 112×112 RGB
    ↓
① RGB → Grayscale（加權灰度: 0.299R + 0.587G + 0.114B）
   目的: 消除色溫差異（同一張臉在日光燈 vs 黃燈下色調不同但結構相同）
    ↓
② CLAHE（Contrast Limited Adaptive Histogram Equalization）
   參數: clipLimit=2.0, tileGridSize=8×8
   目的: 把整張圖的亮度分佈正規化到統一範圍
         不是全局直方圖均衡（會破壞局部結構），而是分區自適應
         暗處提亮、亮處壓暗，結構保留
    ↓
③ Gaussian blur σ=1.0, kernel 3×3
   目的: 消除相機感測器雜訊（每幀略有不同的高頻雜訊）
         只消除 1-2px 的雜訊，不破壞臉部結構
    ↓
④ 最終正規化: 像素值線性映射到 [0, 255]
   min-max normalization 確保不同曝光條件的圖片在同一範圍
    ↓
正規化灰度圖 112×112
```

### 3.3 實作方式

全部在 Canvas 2D + 純 JS 中實作，不需要任何外部庫：

- **灰度化**: `getImageData` → 逐 pixel 計算加權灰度
- **CLAHE**: 分 8×8 tile，每個 tile 做 histogram equalization，tile 之間雙線性插值
- **Gaussian blur**: 3×3 convolution，可用 separable filter 加速
- **Min-max normalize**: 遍歷一次找 min/max，遍歷一次映射

這些操作是**完全確定性的**（不像 CNN 有浮點精度差異），同樣的輸入永遠得到同樣的輸出。

### 3.4 驗證方法

測試：同一人在 3 種光線條件下各拍 1 張 → ArcFace align → 光線正規化 → 比較 3 張正規化後的圖片的 pixel-level 差異（PSNR / SSIM）。如果正規化做得好，SSIM 應該 > 0.95。

---

## 4. Stage 3: 結構特徵提取

正規化後的灰度圖，用以下確定性算法提取臉部結構。三條路線並行測試，最終選擇最穩定的一條或組合。

### 4.1 Path A: Gabor Filter Bank

**原理**: Gabor filter 是一個在特定方向和頻率上敏感的帶通濾波器。對正規化臉部圖片施加一組 Gabor filter，響應反映的是該方向和頻率上的紋理強度。

```
Gabor 參數:
  方向: 0°, 45°, 90°, 135°（4 個方向）
  頻率: λ = 4, 8, 16 px（3 個頻率）
  → 4 × 3 = 12 個 filter

每個 filter 施加到 112×112 正規化圖 → 112×112 響應圖
響應圖分 4×4 grid → 每個 grid cell 取平均響應能量
→ 12 filters × 16 cells = 192 個特徵值
```

**為什麼穩定**: Gabor 響應反映的是臉部結構的方向和頻率特性。眼睛是水平方向的低頻結構，鼻樑是垂直方向的結構，這些不會因為光線改變（前提是 Stage 2 的正規化有效）。

**為什麼能區分不同人**: 不同人的五官形狀、位置、比例不同，導致 Gabor 響應模式不同。192 維的特徵空間足夠大。

**量化**: 每個特徵值 → round(value / bin_width) → 192 個 bin → 串接 → SHA-256

### 4.2 Path B: 深度圖 + Laplacian 曲率場

**原理**: Depth Anything V2 產出深度圖後，不直接用深度值（受距離影響），而是計算 Laplacian（二階導數），得到**曲率場**。曲率反映的是 3D 表面哪裡凸出、哪裡凹陷，對平移和縮放天然不變。

```
RGB 原圖 → Depth Anything V2 → 深度圖
    ↓
ArcFace alignment 裁切臉部（與 Stage 1 同一個 transform）
    ↓
正規化到 [0, 1]（除以 max-min，消除絕對距離影響）
    ↓
Laplacian 運算: ∇²D = D(x+1,y) + D(x-1,y) + D(x,y+1) + D(x,y-1) - 4D(x,y)
    ↓
曲率場 → 分 4×4 grid → 每個 cell 統計:
  - 正曲率平均（凸出區域，如鼻子、顴骨）
  - 負曲率平均（凹陷區域，如眼窩、太陽穴）
  - 曲率方向直方圖（4 bins）
→ 16 cells × 6 統計量 = 96 個特徵值
```

**為什麼比絕對深度穩定**: 曲率是微分量，不受全局偏移影響。鼻子的突出程度（正曲率）不會因為你離相機遠一點就改變。

**問題**: Depth Anything V2 本身的推論確定性。同一張圖跑兩次，深度值不完全一樣。需要測試 Laplacian 後的曲率是否夠穩定。

### 4.3 Path C: LBP（Local Binary Pattern）

**原理**: 對每個像素，跟周圍 8 個鄰居比較大小，得到一個 8-bit 二進位模式（0-255）。這個模式反映的是局部紋理結構，對全局光線變化天然不變（因為只比較相對大小，不看絕對值）。

```
正規化灰度圖 112×112
    ↓
每個像素 → 跟 8 鄰居比較 → 8-bit LBP code
    ↓
分 8×8 grid → 每個 cell 統計 LBP histogram（59 uniform patterns）
→ 64 cells × 59 bins = 3776 維... 太大
    ↓
降維: 每個 cell 只取 top-10 最頻繁的 pattern
→ 64 × 10 = 640 個特徵值
```

**優勢**: LBP 對單調光線變化（整體變亮/變暗）是**數學上不變**的，因為它只比較鄰居間的大小關係，不看絕對值。這比 Gabor 的光線魯棒性更強。

**劣勢**: LBP 對雜訊敏感 — 一個像素的雜訊就能翻轉一個 bit。需要先做 Gaussian blur。

### 4.4 Path D: DCT 低頻感知 hash（pHash 變體）

**原理**: 對正規化圖片做 DCT（離散餘弦變換），取左上角低頻成分。低頻反映的是臉部的整體形狀和大區域的明暗分佈，對高頻雜訊和微小變化不敏感。

```
正規化灰度圖 112×112
    ↓
resize 到 32×32（只保留低頻結構）
    ↓
2D DCT 轉換
    ↓
取左上角 8×8 = 64 個 DCT 係數
    ↓
計算 64 個係數的中位數
每個係數 > 中位數 → 1，< → 0
    ↓
64-bit hash
```

**優勢**: 極度簡潔，計算快，對微小變化非常魯棒。
**劣勢**: 只有 64 bit，區分力可能不夠（2^64 的空間理論上足夠，但如果很多 bit 不穩定，有效空間會縮小）。

---

## 5. 兩條路線的深度圖優化

### 5.1 裁切穩定性

**問題**: 當前用 landmark bbox 裁切臉部深度圖，bbox 每幀漂移。

**解法**: 用跟 RGB 完全相同的 ArcFace 5 點 similarity transform 裁切深度圖。需要把 RGB 的 landmark 座標映射到深度圖座標。

### 5.2 多次推論平均

**問題**: Depth Anything V2 單次推論有浮點精度差異。

**解法**: 對同一幀 RGB 跑 3 次深度推論，每個像素取平均。確定性提升但速度 ×3。在註冊時可接受（等 30 秒），驗證時只跑 1 次配合更粗的量化。

### 5.3 曲率場代替絕對深度

深度值 → Laplacian → 曲率場。曲率是二階微分，消除一階的全局偏移（距離）和二階以下的漂移。同一張臉的曲率模式是骨骼決定的物理常數。

---

## 6. 當前測試數據分析

### 6.1 Path A（骨骼比率）失敗的真因

不是「多取幾幀平均」就能解決。根因：

1. **MediaPipe landmark 本身是 CNN 輸出**，有推論不確定性
2. **沒有做光線正規化**，光線微變 → landmark 位置微漂
3. **取的是 landmark 座標的比率**，而不是圖片本身的結構特徵

**結論**: 放棄「從 landmark 座標算比率」的思路。改為「從正規化後的圖片直接提取結構特徵」。landmark 只用來做 ArcFace alignment（Stage 1），不用於特徵計算。

### 6.2 Path B（深度圖）失敗的真因

1. **bbox 裁切不穩定**，每次裁切的像素範圍不同
2. **用了絕對深度值**，受距離和模型推論波動影響
3. **bin 太細**，微小漂移就跨 bin

**結論**: 改用 ArcFace alignment 裁切 + Laplacian 曲率場 + 粗粒度量化。

---

## 7. 完整最終架構

```
┌─────────────────────────────────────────────────────────┐
│                    相機 RGB 原圖                         │
└─────────────────────┬───────────────────────────────────┘
                      ↓
┌─────────────────────┴───────────────────────────────────┐
│ MediaPipe FaceLandmarker → 468 landmarks (只用於對齊)    │
└─────────────────────┬───────────────────────────────────┘
                      ↓
         ┌────────────┴────────────┐
         ↓                         ↓
┌────────────────┐        ┌────────────────────┐
│ RGB 管線        │        │ 深度管線            │
│                │        │                    │
│ ArcFace align  │        │ Depth Anything V2  │
│ → 112×112 RGB  │        │ → 深度圖            │
│ → Grayscale    │        │ → ArcFace align    │
│ → CLAHE        │        │   裁切 112×112     │
│ → Gauss blur   │        │ → 正規化 [0,1]     │
│ → normalize    │        │ → Laplacian 曲率場  │
│                │        │                    │
│ Gabor bank     │        │ 曲率統計特徵        │
│ → 192 維特徵   │        │ → 96 維特徵         │
│                │        │                    │
│ LBP            │        │                    │
│ → N 維特徵     │        │                    │
└───────┬────────┘        └─────────┬──────────┘
        ↓                           ↓
┌───────┴───────────────────────────┴──────────┐
│ 聯合特徵向量 → 量化 → SHA-256 = Face ID      │
│ + PIN 行為指紋 hash                           │
│ = AegisID 唯一身份                            │
└──────────────────────────────────────────────┘
```

---

## 8. 後續步驟

### Phase 1: 影像正規化管線（2-3 天）

**測試頁面中實作完整的 Stage 2 正規化:**

1. 在現有測試頁面加入 CLAHE + Grayscale + Gaussian blur
2. 顯示正規化前/後的對比圖
3. 同一人在不同光線下拍多張，比較正規化後的 SSIM
4. **驗收標準**: 正規化後同一人不同光線的 SSIM > 0.90

### Phase 2: Gabor + LBP 特徵提取（2-3 天）

**在正規化圖片上實作確定性特徵提取:**

1. 實作 Gabor filter bank（4 方向 × 3 頻率，純 JS Canvas 運算）
2. 實作 LBP（8-neighbor，uniform patterns）
3. 同一人拍 10 次 → 看特徵值的變異係數
4. **驗收標準**: 同一人的特徵值變異 < bin 寬度

### Phase 3: 深度曲率場（3-5 天）

**深度圖的結構化處理:**

1. ArcFace alignment 應用到深度圖裁切
2. Laplacian 曲率場計算
3. 曲率統計特徵提取
4. 穩定性測試
5. **驗收標準**: 同一人曲率特徵的變異 < bin 寬度

### Phase 4: 量化與 hash 整合（1-2 天）

1. 確定每個特徵的最佳 bin 寬度（基於 Phase 2/3 的變異數據）
2. 串接所有穩定特徵 → SHA-256
3. 同一人 20 次測試 → exact hash match rate
4. **驗收標準**: exact hash match ≥ 95%

### Phase 5: 區分力驗證（1-2 天）

1. 至少 3 個不同人各拍 10 次
2. 確認不同人的 hash 永遠不同
3. + PIN 行為指紋聯合測試
4. **驗收標準**: 不同人 hash 碰撞率 = 0%

### Phase 6: 整合到 AegisID SDK（2-3 天）

1. `structuralId.ts` — 完整的影像處理管線
2. 嵌入 `useFaceRecognition.ts` 的註冊/驗證流程
3. VPS `aegisid/register` 加入結構 ID 去重
4. 更新 `identity_anchors` 表

---

## 9. 技術備註

### 9.1 所有影像處理在瀏覽器端完成

CLAHE、Gabor、LBP、DCT 全部是純數學運算，用 Canvas 2D + TypedArray 在 WASM 或純 JS 中實作。不需要額外的 ONNX 模型（除了 Depth Anything V2 用於深度路線）。

### 9.2 確定性保證

CNN 模型（MediaPipe、MobileFaceNet）的輸出有浮點精度差異。本架構中 CNN 只用於:
- MediaPipe: 取得 5 個 alignment landmarks（容許微小偏差，因為後續正規化會吸收）
- Depth Anything V2: 取得深度圖（後續用 Laplacian + 粗量化吸收推論差異）

特徵提取本身（Gabor、LBP、曲率統計）是確定性的數學運算。

### 9.3 與現有 AegisID 的關係

現有 MobileFaceNet 512 維 embedding 保留用於**輔助驗證**（cosine similarity 作為二次確認）。結構 ID hash 是主要的唯一性判定，CNN embedding 是備用。

---

## 10. 已有資源

| 資源 | 位置 | 狀態 |
|------|------|------|
| 測試頁面 | https://aegisrd.com/face-id-test/ | ✅ 運行中 |
| Depth Anything V2 Small INT8 | VPS `/var/www/aegisrd/face-id-test/models/` | ✅ 27.3MB |
| ArcFace alignment 實作 | `AegisID/sdk/src/face/cnnInference.ts` | ✅ 可複用 |
| MediaPipe FaceLandmarker | CDN | ✅ |
| MobileFaceNet | `AegisID/models/face_recognition.onnx` | ✅ 備用 |
| MiniFASNetV2SE 防偽 | `AegisID/models/anti_spoof.onnx` | ✅ 備用 |
| 測試數據（6 captures） | 手動測試 | ✅ 已分析 |

---

## 11. 關鍵決策

| 決策 | 理由 |
|------|------|
| 不用 CNN embedding 做 hash | CNN 推論有隨機性，無法確定性 hash |
| 不用 landmark 座標比率做特徵 | landmark 是 CNN 輸出，不穩定；且忽略了圖片本身的豐富結構資訊 |
| 不用 Hamming distance 做匹配 | 模糊匹配，不是唯一 ID |
| 不用多幀取樣做穩定化 | 治標不治本，掩蓋了正規化不足的問題 |
| 從影像處理管線本身優化 | 正確方向：消除變異的根源（光線/雜訊），而非統計手段掩蓋變異 |
| Gabor + LBP 而非 CNN 特徵 | 確定性算法，同輸入永遠同輸出 |
| Laplacian 曲率場而非絕對深度 | 對距離和全局偏移天然不變 |
