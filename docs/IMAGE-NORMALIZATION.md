# AegisID 影像正規化演算法規格

> **版本**: 1.0.0 (已驗證)
> **日期**: 2026-03-20
> **狀態**: ✅ SSIM 0.993 已驗證

---

## 管線流程

```
輸入: 相機 video frame + MediaPipe 468 landmarks
輸出: 112×112 Uint8 灰度圖（臉部遮罩內為正規化像素，遮罩外 = 128）

Step 1: ArcFace 5 點 Similarity Transform
Step 2: RGB → Grayscale
Step 3: 全局直方圖均衡化
Step 4: 橢圓臉部遮罩
```

---

## Step 1: ArcFace 5 點 Similarity Transform

從 MediaPipe 468 landmarks 取 5 個關鍵點，映射到 ArcFace 標準座標：

### 來源點（MediaPipe landmark indices）

```
左眼中心:  (lm[33] + lm[133]) / 2
右眼中心:  (lm[263] + lm[362]) / 2
鼻尖:      lm[1]
左嘴角:    lm[61]
右嘴角:    lm[291]
```

### 目標點（ArcFace 112×112 標準座標）

```
左眼: (38.2946, 51.6963)
右眼: (73.5318, 51.5014)
鼻尖: (56.0252, 71.7366)
左嘴角: (41.5493, 92.3655)
右嘴角: (70.7299, 92.2041)
```

### Similarity Transform（最小二乘法）

求解 a, b, tx, ty 使得：
```
dst_x = a * src_x - b * src_y + tx
dst_y = b * src_x + a * src_y + ty
```

然後用 Canvas 2D `setTransform(a, b, -b, a, tx, ty)` + `drawImage` 完成變換。

**注意**: 使用 `OffscreenCanvas` 或 `document.createElement('canvas')` 作為 fallback。

---

## Step 2: RGB → Grayscale

```javascript
gray[i] = Math.round(0.299 * R + 0.587 * G + 0.114 * B)
```

標準 ITU-R BT.601 加權灰度。

---

## Step 3: 全局直方圖均衡化

**不是 CLAHE。** 全局處理，不分區。

```javascript
function histEq(gray) {
  // 1. 統計直方圖
  hist[0..255] = count of each gray value

  // 2. 計算 CDF
  cdf[i] = cdf[i-1] + hist[i]

  // 3. 找 CDF 最小非零值
  cdfMin = first non-zero cdf value

  // 4. 映射
  out[i] = round((cdf[gray[i]] - cdfMin) / (totalPixels - cdfMin) * 255)
}
```

**作用**: 把任意曝光條件下的灰度分佈拉到均勻分佈。亮環境和暗環境拍同一張臉，
均衡後的灰度分佈趨於一致。

**為什麼不用 CLAHE**: CLAHE 分區自適應均衡會扭曲局部結構，特別是五官邊界。
後續若接骨骼結構提取或 CNN，被扭曲的結構會導致錯誤。

---

## Step 4: 橢圓臉部遮罩

```javascript
function applyFaceMask(gray) {
  const cx = 56, cy = 68;  // 橢圓中心
  const rx = 40, ry = 44;  // 半徑

  for (y = 0; y < 112; y++) {
    for (x = 0; x < 112; x++) {
      dx = (x - cx) / rx;
      dy = (y - cy) / ry;
      if (dx*dx + dy*dy > 1.0) {
        out[y * 112 + x] = 128;  // 遮罩外 → 固定中性灰
      } else {
        out[y * 112 + x] = gray[y * 112 + x];  // 遮罩內 → 保留
      }
    }
  }
}
```

**為什麼需要遮罩**:
ArcFace 對齊只對齊五官，不裁切背景。頭微動時天花板、牆壁、衣服進入 112×112
的不同位置，影響所有後續特徵計算。遮罩消除背景干擾。

**為什麼用固定 128**: 任何確定性的固定值都可以。128 是 Uint8 的中間值，
不會把遮罩邊界的梯度推向極端。

---

## 棄用方案記錄

| 方案 | 棄用原因 |
|------|---------|
| CLAHE (clipLimit=2, 8×8 tiles) | 分區處理扭曲五官邊界結構 |
| Gaussian blur σ=2 | 磨掉五官細節，SSIM 高但資訊丟失 |
| Gaussian blur σ=1 (3×3 kernel) | 同上，程度較輕但仍不必要 |
| DoG (σ=1 vs σ=4) | 邊緣圖 + min-max 放大 1px 漂移，SSIM 降至 0.43 |
| Min-max normalize 在 histEq 之後 | histEq 本身已經映射到 0-255，不需要再做 |

---

## 驗證數據

### 測試 1: 2026-03-20 Samsung Z Fold, 室內

管線: gray → histEq → mask (無 blur, 無 CLAHE)

| Capture | SSIM vs #1 | maxΔ | pHash 4×4 |
|---------|-----------|------|-----------|
| #1 (ref) | — | — | 8674 |
| #2 | 0.9915 | 131 | 8674 ✅ |
| #3 | 0.9912 | 105 | 8674 ✅ |
| #4 | 0.9949 | 93 | 8674 ✅ |
| #5 | 0.9939 | 99 | 8674 ✅ |

**結論**: SSIM avg 0.993, pHash 4×4 100% exact match。影像正規化管線已驗證。
