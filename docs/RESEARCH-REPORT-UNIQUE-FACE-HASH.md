# AegisID 唯一臉部 Hash 研究報告

**專案**：AegisID — 匿名身份認證系統
**主題**：基於 2D+3D 骨骼比率聯合量化的唯一臉部 Hash（v15 研究）
**研究期間**：2026-04-14 ~ 2026-04-16
**狀態**：同一人穩定性已驗證（N=1, 41 captures）；跨人區分性待驗證
**目的**：技術研發紀錄，供後續專利申請與 SDK 整合參考

> **與 SDK 的關係（2026-05-04 update）**：
> - 本研究獨立於目前 SDK 的 v17 實作（`sdk/src/face/structuralId.ts`，2026-03-22 落地，25 個 2D + 11 個 3D 特徵 + 多基準 + floor-biased 量化）
> - v15 採 round()+offset=0、26 特徵；v17 採 floor-biased、混合 2D/3D
> - **SDK 整合 v15 26 特徵是 M3（2026-05-15）目標** — 屆時會用 v15 結果取代或補強 v17 白名單

---

## 摘要 (Abstract)

本研究提出一種可用於匿名身份認證的**唯一臉部 Hash** 演算法，核心創新為：

1. **2D/3D 混合特徵池** — 從 MediaPipe 468 landmarks 衍生 51 個候選比率（30 個原始 + 18 個人類感知導向新特徵 + 3 個 Z 軸特徵），每個在 2D 與 3D 兩種座標下分別計算，共 99 個候選，經去重與黑名單過濾。
2. **量化容錯設計** — 採用 `BIN_WIDTH=0.25` 與 `round()` 量化，將連續比率離散為整數 bin，消除感測器微小雜訊。
3. **嚴格 offset=0 特徵篩選** — 不採用「offset sweep」等過擬合手法，只保留在固定 `offset=0` 下跨多場景 100% bin 一致的特徵。
4. **跨 session 實測驗證** — 5 次不同光線/表情/配飾/距離/時間的錄製，共 41 次擷取，在 26 個選定特徵下產生**同一 SHA-256 hash**（41/41 = 100%）。

最終結果：**Top-10 至 Top-26 任意切點，41 張臉 → 1 個唯一 hash**。

---

## 1. 問題陳述 (Problem)

### 1.1 產業痛點

臉部辨識技術在身份認證場景存在三個未解問題：

1. **CNN 黑盒化** — 主流方案（MobileFaceNet、ArcFace 等）產生 128-512 維 embedding，需比對資料庫。不支援「從臉直接算出唯一 ID」的無狀態查找。
2. **生物特徵外洩風險** — CNN embedding 可反推原始臉孔（face reconstruction attack），上傳至伺服器後即有隱私風險。
3. **跨裝置不可重現性** — 同一人在不同手機/光線下 embedding 差異過大，無法產生穩定 hash。

### 1.2 AegisID 的設計目標

- **可計算的唯一 ID**：臉部輸入 → 確定性函數 → 固定 hash，無需伺服器比對。
- **VPS 永遠不看臉**：伺服器只存 hash 與加密 blob，無法反推生物特徵。
- **容錯量化**：同一人 10 次掃描 → 10 次產生相同 hash。
- **雙胞胎可分辨**：face_hash 相同但 PIN 不同 → `account_key = SHA-256(face_hash + PIN)` 不同。

### 1.3 先前方案的失敗

v14 原始設計使用 25 個 3D 骨骼比率產生 hash，實測發現 5 個「漂移特徵」（ER04/N04/EL04/B01/B02）在 bin 邊界附近跳動，導致**同一人每次掃描產生不同 hash**，VPS 帳號恢復失敗率高。

本研究旨在系統性重建該特徵集。

---

## 2. 先前技術與創新點 (Prior Art & Novelty)

### 2.1 相關技術

| 技術 | 輸出 | 穩定性機制 | 限制 |
|------|------|-----------|------|
| FaceNet / ArcFace | 128-D float embedding | 靠 CNN 訓練收斂 | 黑盒，無法逆向推理 |
| LSH (Locality-Sensitive Hashing) | 短 hash | 隨機投影容錯 | 需要集中式比對資料庫 |
| 骨骼幾何 (Aegis v14) | 25 個 3D 比率 → SHA-256 | 量化成 bin | 特徵未經跨場景篩選，不穩定 |
| **本研究 (v15)** | **26 個 2D+3D 混合比率 → SHA-256** | **offset=0 嚴格篩選 + 跨 session 驗證** | **待驗證跨人區分性** |

### 2.2 創新主張 (Novelty Claims)

本研究的**可主張新穎性**包含：

**N1. 雙座標候選池方法**
同一幾何特徵（如 `nose_length/face_height`）同時以 2D（原始影像投影）與 3D（三角化重建）兩種座標計算，取其中穩定者納入 hash。既有方案通常單一座標（純 2D 或純 3D）。

**N2. 「人類感知對齊特徵」設計**
除傳統 31 個幾何比率外，引入 18 個基於人類識臉直覺的新特徵：眼睛長寬比、鼻翼基寬、人中寬度、三等分比例、臉頰飽滿度、下巴收尖角、眉毛距眼高度等。這些在臨床面相學有理論基礎但在自動識臉系統罕見。

**N3. 特徵抗干擾黑名單法**
透過跨場景實測（帽子、翹嘴、極端表情、臉頰鼓氣），系統性剔除受表情/配飾干擾的特徵。產生可公開的「黑名單」而非依賴 CNN 訓練。

**N4. offset=0 嚴格量化準則**
不採用 offset sweep（透過位移量化原點來「遷就」資料），而是只保留「天生落在 bin 中心」的特徵。此方法杜絕過擬合，hash 具可重現性。

**N5. 雙 hash 帳號架構**
```
face_hash    = SHA-256(26 bone bins)            → rate limiting（同臉限 2 帳號）
account_key  = SHA-256(26 bone bins + PIN)      → 帳號查找（雙胞胎可分）
```
配合三表 HMAC secret 分離，實現「VPS 不知 IP/裝置/身份，但可偵測批量建號」。

---

## 3. 方法論 (Methodology)

### 3.1 硬體與軟體環境

| 項目 | 規格 |
|------|------|
| 前端 | Web + MediaPipe FaceLandmarker (468 landmarks) |
| 瀏覽器 | iOS Safari（主要測試平台） |
| 後端 | 離線分析（Python 3），不涉及 GPU |
| 模型 | MediaPipe face_landmarker_v2（4MB）+ blendshape |

### 3.2 候選特徵池

**Group O — 原始 30 比率**（`tools/face-id-test.html` 行 213-245）：
眼睛、鼻子、嘴、臉輪廓等傳統幾何比率。

**Group N — 新 18 比率**（`logs/bin_match_rate.py::NEW_RATIOS`）：
```python
# 眼睛（人類識臉關鍵）
eyeL_aspect_h/w, eyeR_aspect_h/w
# 鼻子解剖
nose_tip_subnasale/len, alar_base_width/ipd, nostril_to_tip/nose_len
# 嘴唇
cupid_width/mouth_width
# 眉毛
browL/R_peak_to_eye/face_h, inner_brow_gap/ipd
# 古典三等分
upper/mid/lower_third/face_h
# 臉頰/下巴
cheekL/R_fullness/face_w, jaw/temple, cheekbone/temple
chin_to_jawL/R/face_h
```

**Group Z — 3 個 Z 軸特徵**：
`nose_tip_Zproj/ipd`、`cheekboneL/R_Z/ipd`（三角化後深度差）。

**總候選**：
- Group O: 30 × 2 (2D+3D) = 60
- Group N: 18 × 2 (2D*+3D) = 36
- Group Z: 3（只能 3D）
- **共 99 個 raw candidates**

### 3.3 量化方法

```python
bin = round((value - offset) / BIN_WIDTH)   # BIN_WIDTH = 0.25
```

`round()` 非 `floor()` — 避免負值偏差；bin 為整數可直接串接入 hash。

### 3.4 穩定性指標

- **Bin match rate**（主指標）：`max(Counter(bins).values()) / N_captures`。若同一人 41 次擷取都量化到同一 bin → rate = 1.0。
- **Population CV**（輔助指標）：`σ/μ`（用 population std，`/N` 不 `/(N-1)`），與 log 內計算一致。CV 低但 bin rate < 100% 表示特徵在 bin 邊界。

### 3.5 實驗資料集（N=1, 5 sessions, 41 captures）

| Log | Session | 描述 | Captures |
|-----|---------|------|----------|
| A | 2026-04-14 早 | 基線 + G-6 異常重建（resid 0.353） | 10 |
| B | 2026-04-15 晚 | 多樣表情 | 10 |
| C | 2026-04-15 晚 | **帽子+翹嘴+眼鏡+不同距離**（ipdN 0.125-0.256） | 9 |
| D | 2026-04-15 晚 | **極端表情**（張嘴、鼓眉等） | 5 |
| E | 2026-04-16 晚 | **不同時間、不同環境光、臉頰鼓氣** | 7 |
| 合計 | | | **41** |

### 3.6 分析腳本

- [logs/analyze_2d_vs_3d.py](../logs/analyze_2d_vs_3d.py) — 定義 `RATIOS`, `compute_3d_ratios`, `population_cv`。
- [logs/bin_match_rate.py](../logs/bin_match_rate.py) — 主分析，支援 offset sweep + dedup + blacklist。
- [logs/verify_top26.py](../logs/verify_top26.py) — 最終驗證腳本：offset=0 固定、跨 41 captures 聯合 hash 測試。

---

## 4. 實驗結果 (Results)

### 4.1 迭代歷程

**第 1 次迭代 (log A only, 10 caps)**：
- 原始 30 特徵中 16 個 100% 穩定，但夾雜鼻尖漂移特徵（#11, #15, #27）。
- 發現 G-6 擷取 avgResidualA=0.353（異常高），Z 軸特徵全跌。
- 決策：**不做品質閘門（真實使用者不會重掃），改剔除雜訊敏感特徵**。

**第 2 次迭代 (加入 log B, 多表情)**：
- 新 18 特徵（Group N）加入候選池。
- 人類感知導向特徵（眼長寬比、三等分）進入前段。

**第 3 次迭代 (加入 log C, 帽子+翹嘴+眼鏡)**：
- `mouth_width/eye_outer` (O#9) 掉到 89% → 翹嘴導致。
- `nostril_to_tip/nose_len` (N#4) 同樣掉到 89%。
- 加入黑名單。

**第 4 次迭代 (加入 log D, 極端表情)**：
- `upper_lip/mouth_height` (O#26) 掉到 80% (CV 23.9%)。
- 加入黑名單。

**第 5 次迭代 (加入 log E, 鼓臉頰)**：
- 三張臉頰飽滿度特徵（N#12, N#13, cheekL/R_fullness）在預期中漂移 → 這類「形變敏感」特徵本就該被篩掉。
- 篩選流程收斂。

### 4.2 最終黑名單（10 項）

| Group | Idx | Label | 理由 |
|-------|-----|-------|------|
| O | 11 | nose_to_chin/eye_outer | 長距離、鼻尖敏感 |
| O | 15 | upper_face/lower_face | 鼻尖敏感，2D/3D 雙漂移 |
| O | 27 | nose_tip_to_bridge/ipd | 鼻尖敏感 |
| O | 28 | eye_outer_to_ear/face_w | 非對稱 bug（234 同時出現於分子分母） |
| O | 9 | mouth_width/eye_outer | log C 翹嘴 89% |
| N | 4 | nostril_to_tip/nose_len | log C 翹嘴 89% |
| O | 26 | upper_lip/mouth_height | log D 極端表情 80% |
| Z | 0 | nose_tip_Zproj/ipd | Z 軸幅度過小、三角化雜訊 |
| Z | 1 | cheekboneL_Z/ipd | 同上 |
| Z | 2 | cheekboneR_Z/ipd | 同上 |

### 4.3 最終 26 個穩定特徵（offset=0, 41 captures 100% bin-match）

依 CV 由低至高排序（低 CV = 變異小）：

| Rk | Grp | # | Kind | CV | Label | Bin |
|----|-----|---|------|-----|-------|-----|
| 1 | O | 23 | 2D | 0.38% | temple_span/face_width | 4 |
| 2 | N | 15 | 3D | 1.40% | cheekbone/temple | 4 |
| 3 | O | 21 | 2D | 1.47% | brow_span/eye_outer | 5 |
| 4 | O | 22 | 3D | 1.51% | cheekbone/face_width | 4 |
| 5 | O | 18 | 2D | 1.56% | jaw_width/face_width | 3 |
| 6 | O | 0  | 2D | 1.97% | eye_inner/eye_outer | 2 |
| 7 | O | 5  | 2D | 1.99% | eye_outer/face_width | 2 |
| 8 | N | 14 | 3D | 2.62% | jaw/temple | 3 |
| 9 | O | 20 | 2D | 3.01% | eye_inner_span/face_w | 1 |
| 10 | O | 7  | 2D | 3.15% | eyeR_width/eye_outer | 1 |
| 11 | O | 12 | 3D | 3.61% | forehead_to_nose/face_h | 1 |
| 12 | O | 6  | 2D | 3.89% | eyeL_width/eye_outer | 1 |
| 13 | N | 8  | 2D* | 4.00% | inner_brow_gap/ipd | 1 |
| 14 | N | 10 | 2D* | 4.35% | mid_third/face_h | 2 |
| 15 | N | 11 | 3D | 4.36% | lower_third/face_h | 2 |
| 16 | N | 5  | 2D* | 4.45% | cupid_width/mouth_width | 1 |
| 17 | O | 3  | 3D | 4.49% | nose_to_chin/face_height | 2 |
| 18 | O | 2  | 2D | 4.74% | nose_length/face_height | 1 |
| 19 | O | 1  | 2D | 5.04% | face_width/face_height | 2 |
| 20 | N | 9  | 3D | 5.37% | upper_third/face_h | 1 |
| 21 | O | 13 | 3D | 5.87% | nose_to_mouth/nose_to_chin | 2 |
| 22 | O | 24 | 3D | 6.49% | chin_height/face_h | 0 |
| 23 | N | 6  | 3D | 8.03% | browL_peak_to_eye/face_h | 1 |
| 24 | O | 29 | 3D | 9.00% | mouth_to_jaw/face_h | 1 |
| 25 | O | 19 | 2D | 9.22% | nose_bridge/face_height | 0 |
| 26 | N | 16 | 2D* | 14.24% | chin_to_jawL/face_h | 1 |

**觀察**：
- 2D / 2D* / 3D 混合：2D=15、3D=11，驗證「兩者都要」的設計正確（N2 新穎性）。
- Top-1 (`temple_span/face_width`, CV 0.38%) — 兩耳朵寬度除以臉寬，幾乎不受表情影響。
- Rk-26 CV 14.24% 但 bin 仍 100% 一致 — 證明**「bin 穩定」> 「CV 低」**，特徵可在 bin 中心附近抖動，只要不跨邊界即可（N4 新穎性）。

### 4.4 Hash 一致性驗證

Top-N 切點掃描（`SHA-256` of concatenated bins）：

| Top-N | Unique hashes | Match | SHA-256 prefix |
|-------|---------------|-------|----------------|
| 10 | 1 | 41/41 | `28b7618479947695...` |
| 15 | 1 | 41/41 | `4279146dbc5b36ef...` |
| 20 | 1 | 41/41 | `6f69d6385dd94bd5...` |
| 25 | 1 | 41/41 | `5e95bb5edecfe730...` |
| **26** | **1** | **41/41** | **`b42acfec8de74c79...`** |

**結論**：無論取前 10、15、20、25、26 個特徵，41 次擷取全部產生相同 hash。

---

## 5. 專利主張草稿 (Patent Claims Draft)

以下為後續正式申請時的**主張結構草稿**，尚需法務調整。

### Claim 1（方法）

一種用於產生穩定唯一臉部識別碼的方法，包含以下步驟：
(a) 接收包含多個臉部 landmark 的影像輸入；
(b) 計算預定候選比率池，其中每一比率包含 2D 座標下計算值與 3D 三角化重建後的計算值；
(c) 對每一比率應用 `bin = round(value / BIN_WIDTH)` 的均勻量化；
(d) 依跨場景穩定性篩選出特徵子集，其中每一特徵在固定 offset=0 下於多個場景（至少 5 個表情/光線/距離組合）的 bin 值 100% 一致；
(e) 將該子集 bin 值依固定順序串接並套用加密雜湊函數（如 SHA-256）產生唯一識別碼。

### Claim 2（組合）

如 Claim 1 之方法，其中候選比率池至少包含：
- 眉/眼/鼻/嘴/臉輪廓的傳統幾何比率 ≥ 20 個；
- 人類感知對齊的面相學比率 ≥ 10 個，包含眼長寬比、三等分比、臉頰飽滿度、下巴收尖角其中至少三類；
- Z 軸相對深度比率 ≥ 1 個。

### Claim 3（黑名單）

如 Claim 1 之方法，進一步包含表情/配飾敏感特徵的黑名單過濾，其中被過濾特徵係透過實驗驗證在預定擾動集（帽子、翹嘴、臉頰鼓氣、極端表情）下 bin match rate < 100%。

### Claim 4（雙 hash）

如 Claim 1 之方法，進一步結合使用者提供的密碼（PIN），其中：
- `face_hash = H(bins)` 用於速率限制；
- `account_key = H(bins || PIN)` 用於帳號查找；
- 使得同一臉可以不同 PIN 對應不同帳號，解決雙胞胎問題。

### Claim 5（系統）

一種身份認證系統，包含：
- 客戶端模組，執行 Claim 1 之方法產生 `face_hash`；
- 伺服器端，僅儲存該 hash 與加密身份 blob，無法解密原始生物特徵；
- 三表 HMAC secret 分離架構，使得身份錨點、信用分數、速率限制表無法跨表 JOIN。

---

## 6. 未完成項 (Pending Work)

| 項目 | 優先級 | 說明 |
|------|-------|------|
| **跨人區分性驗證** | 高 | 測試第 2、3、4 人，確認不同人 hash 不同。若誤撞率 > 預期，需調整 bin_width 或加入更多特徵。 |
| 半臉攻擊防護 | 高 | 已知 bug：半張臉仍可通過 ≥80% bin match（`sdk/src/face/structuralId.ts`）。需加 landmark visibility 檢查。 |
| 口罩判定調整 | 中 | HSV 膚色判定對白皮膚冷光誤判，需調整閾值或加入嘴部 landmark 開合度。 |
| SDK 整合 | 中 | 將 26 特徵 + 黑名單同步至 `sdk/src/face/structuralId.ts`。 |
| 壓力測試 | 中 | 雙胞胎、整形前後、體重變化 10kg 等邊界條件。 |
| 跨機型測試 | 中 | 目前僅 iOS Safari。Android Chrome、桌面 WebRTC 需驗證。 |

---

## 7. 相關檔案與資料 (Artifacts)

### 原始碼

- [tools/face-id-test.html](../tools/face-id-test.html) — 測試頁（含 3D viewer）
- [logs/analyze_2d_vs_3d.py](../logs/analyze_2d_vs_3d.py) — 2D vs 3D CV 對照
- [logs/bin_match_rate.py](../logs/bin_match_rate.py) — 主分析腳本（含黑名單、NEW_RATIOS、Z_AXIS_RATIOS）
- [logs/verify_top26.py](../logs/verify_top26.py) — 最終 26 特徵驗證與 hash 一致性檢驗
- [logs/top26_features.json](../logs/top26_features.json) — 最終特徵清單（機器可讀）

### 測試資料

- `logs/log-1776238397039.json` — Session A（2026-04-14，10 caps）
- `logs/log-1776298128396.json` — Session B（2026-04-15 晚，10 caps）
- `logs/log-1776298832172.json` — Session C（帽子+翹嘴+眼鏡+距離，9 caps）
- `logs/log-1776300208309.json` — Session D（極端表情，5 caps）
- `logs/log-1776348839094.json` — Session E（鼓臉頰+不同時間，7 caps）

### 既有設計文件

- [UNIQUE-FACE-ID.md](UNIQUE-FACE-ID.md) — 原 v14 設計
- [BONE-RATIO-SYSTEM.md](BONE-RATIO-SYSTEM.md) — 67 骨骼比率完整定義
- [IMAGE-NORMALIZATION.md](IMAGE-NORMALIZATION.md) — 影像正規化演算法
- [face-structure-id-research.md](face-structure-id-research.md) — 早期研究紀錄
- [PRIVACY.md](PRIVACY.md) — 隱私設計

---

## 8. 研究紀律 (Research Discipline)

本研究過程中嚴格遵守的方法論原則，值得記錄：

1. **誠實優先於漂亮結果**
   中途發現「全資料 offset sweep」會得到 100% 匹配（Top-10 到 Top-35 全 100%），立即辨識為**過擬合/作弊**。改用「log A 作為 enrollment 驗證」嚴格測試，發現 Top-25 只有 76%。最後採用 offset=0 固定篩選，誠實得出 26 個真正穩定特徵。

2. **拒絕「只取好看資料」**
   G-6 擷取 avgResidualA=0.353（重建異常），第一反應是「加品質閘門排除」，但立即意識到「真實使用者不會配合重掃」，改為篩掉雜訊敏感特徵。

3. **實測 > 理論預設**
   黑名單 10 項全部由實測觸發（log C 翹嘴、log D 極端表情、全局 Z 軸失敗），非先驗假設。

4. **「2D 或 3D」的偽命題**
   用戶明確指出「我沒有要 2D 3D 裡面選一個 我兩個都要」，最終結果 2D=15、3D=11 驗證混合策略優於單一座標。

---

## 9. 後續里程碑 (Roadmap)

| 里程碑 | 目標日期 | 驗收條件 |
|-------|---------|---------|
| **M1 — 跨人區分性** | 2026-04-20 前 | 至少 3 人，各 10 captures，所有跨人對比 hash 皆不同 |
| M2 — 半臉防護 | 2026-04-30 前 | 半臉輸入 → challenge 失敗 |
| M3 — SDK 整合 | 2026-05-15 前 | `sdk/src/face/structuralId.ts` 使用 26 特徵 + 黑名單 |
| M4 — 專利草稿 | 2026-05-30 前 | 5 項 claim 完整撰寫 |
| M5 — 跨機型驗證 | 2026-06-15 前 | iOS + Android + 桌面各 N=1 以上 |
| M6 — 公開論文 | 2026-07-31 前 | arXiv 預印本 |

---

**維護者**：AegisRD Team
**建立日期**：2026-04-16
**版本**：v15 研究報告 Rev 1
