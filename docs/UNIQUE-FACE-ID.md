# AegisID 唯一臉部 ID 設計文件

> **版本**: 1.0.0
> **日期**: 2026-03-20
> **狀態**: 研究階段 — 影像正規化已驗證，特徵提取方案選型中
> **測試頁面**: https://aegisrd.com/face-id-test/

---

## 1. 目標：唯一 ID，不是辨識通過

### 1.1 傳統臉部辨識 vs AegisID

**傳統臉部辨識**（Apple FaceID、MobileFaceNet）的目標：
```
f(臉A, 臉B) → similarity > threshold → 通過/不通過
```
這是**模糊匹配**：512 維 embedding 的 cosine similarity > 0.80 就通過。
同一個人每次產出的 embedding 不同，只是「夠接近」。

**AegisID 的目標**：
```
f(同一張臉, 任意條件) → 永遠相同的唯一 ID
f(不同人的臉) → 永遠不同的唯一 ID
```
這是**確定性唯一身份**：同一個人不管什麼時間、什麼光線、什麼裝置掃臉，
產出的 ID 永遠是同一個。不同人的 ID 永遠不同。

### 1.2 為什麼需要唯一 ID

| 需求 | 模糊匹配能做 | 唯一 ID 能做 |
|------|:---:|:---:|
| 解鎖手機 | ✅ | ✅ |
| 防批量建號（同一張臉不能建第二個帳號）| ⚠️ 需要 1:N 遍歷 | ✅ 直接 hash 查重 |
| 跨裝置恢復帳號 | ⚠️ 需要保存 embedding | ✅ 重新掃臉 = 同一個 ID |
| 去中心化身份（無伺服器也能驗證）| ❌ | ✅ hash 比對即可 |
| 隱私保護（伺服器只存 hash）| ⚠️ embedding 可反推 | ✅ hash 不可逆 |
| AegisPay 收款人信任分數 | ⚠️ 需要 embedding 比對 | ✅ 直接用 ID 查表 |

**核心價值**：唯一 ID 讓 AegisID 從「辨識工具」升級為「身份基礎設施」。
帳號不再綁定裝置或電話號碼，而是綁定臉本身。

### 1.3 與現有 AegisID 架構的關係

現有 MobileFaceNet 512 維 embedding + LSH 模糊匹配繼續保留，作為**輔助驗證**
（cosine similarity 作為二次確認、活體偵測等）。唯一 ID 是新增的主要唯一性判定路線。

兩條路線並行：
```
                    ┌─────────────────────────────┐
                    │        AegisID 認證          │
                    │                             │
  掃臉 ──→ ┌───────┴───────┐    ┌────────────────┴──────┐
           │ 路線A: 唯一 ID │    │ 路線B: CNN 模糊匹配    │
           │ 確定性 hash    │    │ 512維 cosine > 0.80   │
           │ → 防建號/查重  │    │ → 活體/輔助驗證        │
           └───────┬───────┘    └────────────────┬──────┘
                   │                             │
                   └──────────┬──────────────────┘
                              │
                     聯合信心分數
```

---

## 2. 已驗證：影像正規化管線

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
正規化灰度圖 112×112 ← 這是所有後續特徵提取的輸入
```

### 2.2 驗證結果（2026-03-20，Samsung Z Fold）

**測試條件**：頭不動，連續拍 5 張

| 指標 | 結果 | 說明 |
|------|------|------|
| **SSIM** | avg 0.993, min 0.991 | >0.95 = 穩定 ✅ |
| **pHash 4×4 (15bit)** | 100% exact match | 5/5 全部相同 ✅ |
| **maxΔ (像素差)** | 39-105 | 個別像素最大差異，在可接受範圍 |

### 2.3 管線設計決策記錄

| 決策 | 採用 | 原因 |
|------|------|------|
| 光線正規化 | 全局直方圖均衡化 | 只做整體亮度分佈拉均勻，不扭曲局部結構 |
| ~~CLAHE~~ | ❌ 棄用 | 分區自適應均衡會扭曲五官邊界，影響後續骨骼提取 |
| ~~Gaussian blur~~ | ❌ 棄用 | 模糊掉五官細節，SSIM 高但資訊丟失 |
| ~~DoG (Difference of Gaussians)~~ | ❌ 棄用 | 邊緣圖 + min-max normalize 導致 1px 漂移被放大，SSIM 降至 0.43 |
| 背景處理 | 橢圓臉部遮罩 | ArcFace 對齊後臉部位置固定，遮罩消除背景變化的影響 |
| 遮罩外填充 | 固定 128（中性灰）| 確定性，不引入額外變量 |

### 2.4 關鍵發現

1. **背景是最大干擾源**：沒有遮罩時，頭微動導致天花板/牆壁進入 112×112 的不同位置，CLAHE 對整張圖重新均衡 → 臉部結構改變
2. **不需要模糊**：SSIM 0.993 是在不模糊的情況下達成的，模糊反而丟失有用資訊
3. **全局 histEq 足夠**：不需要分區處理，全局均衡已經消除了不同曝光的差異

---

## 3. 三條特徵路線（測試中）

### 3.1 路線 A：骨骼比率（MediaPipe landmarks）

**原理**：用 468 個 landmarks 計算 12 個骨骼距離比率（IPD/臉寬、鼻長/臉高等）。

**現狀**：bin width 0.05，穩定性約 75-83%。部分比率在 bin 邊界跳動。

**問題**：MediaPipe landmark 本身是 CNN 輸出，有推論不確定性。landmark 座標的微小漂移 → 比率微變 → bin 邊界跳動。

**可能方向**：
- 只保留最穩定的 6 個比率（r01, r05, r07, r10, r14, r15）
- 加大 bin width 犧牲區分力換穩定性
- 作為輔助特徵，不作為主要唯一性判定

### 3.2 路線 B：單目深度 + 曲率場（Depth Anything V2）

**原理**：用 Depth Anything V2 Small INT8 (27MB) 產出深度圖 → ArcFace 對齊裁切 → 橢圓遮罩 → Laplacian 曲率場 → 4×4 grid 統計。

**現狀**：手機推論 ~12,600ms（WASM），記憶體壓力大（OOM 風險）。曲率特徵 48 維。

**問題**：
- 深度模型推論不確定性（同一幀跑兩次結果不完全相同）
- 手機記憶體不足（518×518×3 Float32 輸入 + 27MB 模型）
- bbox 裁切已改為 ArcFace alignment + 橢圓遮罩（改善中）

**可能方向**：
- 在電腦端測試穩定性（記憶體充足）
- 多次推論取平均（註冊時可接受，驗證時用粗量化）
- Laplacian 曲率場是二階微分，對距離天然不變，理論上比絕對深度穩定

### 3.3 路線 C：感知 hash pHash（DCT 傅立葉）

**原理**：正規化圖 → 降到 32×32 → 2D DCT → 取低頻係數 → median 閾值 → binary hash

**現狀**：
- 4×4 (15 bit)：100% exact match ✅
- 8×8 (63 bit)：avg diff 2-4 bit（不穩定的 bit 在 median 附近跳動）

**優勢**：純數學運算、確定性、極快、設計目標就是「看起來一樣 → 同一個 hash」
**劣勢**：15 bit = 32768 組合，區分力不足做唯一 ID。63 bit 區分力夠但不夠穩定

**可能方向**：
- 作為快速預篩（pHash 4×4 相同 → 可能是同一人 → 再用 CNN 確認）
- 組合：pHash + 穩定骨骼比率 + PIN 行為指紋 → 聯合 hash

---

## 4. 組合策略（規劃中）

單一路線都無法同時滿足「穩定性」和「區分力」。最終方案可能是多路線組合：

```
正規化圖 112×112
    ↓
┌──────────────┬──────────────┬──────────────┐
│ pHash 4×4    │ 穩定骨骼比率  │ CNN cosine   │
│ 15 bit       │ 6 ratios     │ 512 維       │
│ 穩定性: 100% │ 穩定性: ~100%│ 穩定性: 相似度│
│ 區分力: 低   │ 區分力: 中   │ 區分力: 高   │
└──────┬───────┴──────┬───────┴──────┬───────┘
       │              │              │
       └──────────────┼──────────────┘
                      │
            組合策略（待定）
                      │
              唯一 Face ID
              + PIN 行為指紋
                      │
              AegisID 唯一身份
```

### 4.1 候選組合方案

**方案 A：確定性組合 hash**
```
穩定特徵 = concat(pHash_4x4, bone_top6_quantized, depth_curv_coarse)
Face Structure ID = SHA-256(穩定特徵)
```

**方案 B：CNN embedding 量化**
```
CNN 512 維 → PCA 降至 32 維 → 粗量化 → hash
需要大量人臉數據訓練 PCA
```

**方案 C：分層判定**
```
Layer 1: pHash exact match → 快速篩選候選
Layer 2: CNN cosine > 0.90 → 確認
Layer 3: PIN 行為指紋 → 最終確認
不做確定性 hash，但用分層組合達到實質唯一性
```

---

## 5. 橢圓臉部遮罩規格

ArcFace 5 點對齊後，臉部在 112×112 圖中的位置是固定的。遮罩參數：

```
大小: 112×112
橢圓中心: (56, 68)
水平半徑: 40 px
垂直半徑: 44 px
遮罩外填充: 128（Uint8）或 0.5（Float32，深度圖）

ArcFace 參考點:
  左眼: (38.29, 51.70)
  右眼: (73.53, 51.50)
  鼻尖: (56.03, 71.74)
  左嘴角: (41.55, 92.37)
  右嘴角: (70.73, 92.20)
```

深度圖使用相同遮罩按比例縮放至 56×56：
```
中心: (28, 34.3)
半徑: (20, 22)
```

---

## 6. 測試頁面

**URL**: https://aegisrd.com/face-id-test/
**原始碼**: `/var/www/aegisrd/face-id-test/index.html`
**深度模型**: `/var/www/aegisrd/face-id-test/models/depth_anything_v2_small_int8.onnx` (27.3MB)

### 測試頁面功能

- ArcFace 5 點對齊 + 正規化管線視覺化
- 骨骼比率計算 + bin match 比較
- 深度圖推論 + ArcFace alignment + Laplacian（lazy load，OOM 自動跳過）
- SSIM 圖像穩定性量化
- pHash (DCT) 4×4 / 8×8
- 差異熱力圖（紅色 = 有差異）

---

## 7. 已有資源

| 資源 | 位置 | 狀態 |
|------|------|------|
| ArcFace alignment | `sdk/src/face/cnnInference.ts` | ✅ 可複用 |
| MobileFaceNet 512維 | `models/face_recognition.onnx` (13MB) | ✅ |
| MiniFASNetV2SE 防偽 | `models/anti_spoof.onnx` (612KB) | ✅ |
| MediaPipe FaceLandmarker | CDN | ✅ |
| Depth Anything V2 Small INT8 | VPS `/var/www/aegisrd/face-id-test/models/` | ✅ 27.3MB |
| 測試頁面 | `https://aegisrd.com/face-id-test/` | ✅ |

---

## 8. 後續步驟

### Phase A：特徵穩定性量化（進行中）
- [x] 影像正規化管線 — SSIM > 0.99 ✅
- [ ] 骨骼比率 — 找出 bin width 使穩定性 > 95%
- [ ] 深度曲率場 — 在電腦端測試穩定性
- [ ] CNN embedding — 測試正規化圖的 cosine similarity 穩定性

### Phase B：區分力驗證
- [ ] 至少 3 個不同人各拍 10 次
- [ ] 確認不同人的特徵確實不同
- [ ] 確定最佳特徵組合方案

### Phase C：唯一 ID 整合
- [ ] 實作 `structuralId.ts` 模組
- [ ] 嵌入 `useFaceRecognition.ts` 的註冊/驗證流程
- [ ] VPS `aegisid/register` 加入結構 ID 去重（1:N）
- [ ] 更新 `identity_anchors` 表

### Phase D：PIN 行為指紋聯合
- [ ] Face Structure ID + PIN 行為指紋 hash → AegisID 唯一身份
- [ ] 跨裝置恢復測試
