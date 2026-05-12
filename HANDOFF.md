# HANDOFF — 3D 臉部特徵基礎研究

> **狀態（2026-05-04 update）**: 本份 HANDOFF 大部分已完成 — 研究於 2026-04-16 收斂出 26 個跨 41 captures 100% bin-stable 特徵，詳見 [docs/RESEARCH-REPORT-UNIQUE-FACE-HASH.md](docs/RESEARCH-REPORT-UNIQUE-FACE-HASH.md)。
> 後續還有：跨人區分性驗證（M1 已逾期）、SDK 整合（M3 目標 2026-05-15）。
> 以下為原始 4-14 交接內容，保留供歷史追蹤。

---

**日期**: 2026-04-14
**Session 目的**: 基礎研究階段，目標是把現有 SDK 的唯一臉部 ID hash 做得更穩（不是功能開發、不是 SDK 直接修改）

---

## 1. 當前任務目標

**研究「如何定義穩定的 3D 臉部特徵」，把 modelA (Route A triangulation) 的 3D 座標轉成可以進 hash 的特徵集。**

研究場所：`tools/face-id-test.html`（測試工具，獨立於 SDK，但演算法同源）。

不要急著動 SDK — 先在測試工具上把基礎研究做完。

---

## 2. 來龍去脈（重要背景）

### 2.1 現有架構

- SDK `sdk/src/face/structuralId.ts` 實作了 `buildTrue3DModel`（Route A triangulation）+ `compute3DFeatures`（32 個 G/T/E/N/F/A 六類特徵）
- 測試工具 `tools/face-id-test.html` 實作了**同一套** Route A 演算法（`buildModelRouteA_MP` / `build3DModelAC`），但**特徵還是 30 個 2D ratio**，還沒用 3D

### 2.2 本 session 的關鍵發現與踩雷

**踩雷 1（已修）：FACE_REGIONS 鏡像 bug**
- EyeL 用了 32 個非鏡像 landmark，EyeR 用 34 個 → 左右眼特徵計算不對稱
- 已改成 34 對鏡像 landmark

**踩雷 2（已修）：Canonical alignment 對稱平面擬合**
- 前一 session 已修，這 session 驗證 symResid 0.15→0.025

**踩雷 3（已修）：Auto-calibration 不可解**
- 想用 2D reprojection error / 3D ray residual 解 fx
- 數學上不可行（projective ambiguity：fx × distance 耦合不可觀測）
- 改用 **IPD=6.5cm 反推 fx**（假設 32cm 標準距離）

**踩雷 4（已修 — 本 session 最嚴重）：我分析時抓錯欄位**
- Log 裡同時存三份 3D 資料：`landmarksCanon` (legacy MediaPipe R^T)、`landmarksModelA` (Route A)、`landmarksModelC` (Route C EM 精修)
- 我第一次分析挑到 `landmarksCanon`，得出「Z 90% CV、軸亂轉、要放棄 Z」等錯誤結論
- **實際 modelA 資料一直是好的**：眼外角 Δx=1.00 Δz=0.01（水平）、鼻尖-鼻根 Δy=0.48 Δz=0.35（符合解剖）、CV 2-5%
- 用戶質疑「為何還會用錯」，我坦承是分析第一步沒列出所有 landmark 欄位就動手

### 2.3 本 session 完成的清理

為避免再挑錯資料，測試工具 log 現在**只匯出 `landmarksModelA`**：
- 刪 `landmarksCanon` 匯出（但記憶體保留給 σ 分析 UI 用）
- 刪 `landmarksModelC`（Route C 5 次都沒收斂，品質不可靠）
- `build3DModelAC` 不再呼叫 `refineModelRouteC`
- `reconstruction` metadata 精簡成純 A + IPD calibration 欄位

**未動**：σ 穩定度 UI、遮擋偵測、A/B/C/D/E/F 單幀 2D 拍攝、CSV 匯出 — 這些都是獨立管線，跟模型無關。

---

## 3. 目前驗證過的事實（基礎已確定）

### fx / Z / modelA 現況
- IPD-derived fx 方案運作中：`fx = 32 × ipdN / 6.5`
- 最新兩次掃描（同距離）：fx=0.790 vs 0.819（差 4%）、ipdN=0.160 vs 0.166
- 前次 5 次掃描（不同距離）：fx=0.67~1.02（距離越遠 fx 越小）
- modelA 的幾何軸向正確：眼外水平 Δx≈1、Δz≈0.02；鼻尖-鼻根 Y+Z 混合
- Euclidean_3D / IPD_3D 的 CV：大部分特徵 2-5%，連 Z-heavy 的鼻尖-鼻根也只有 4.5%

### 測試工具目前的特徵
- **30 個 ratio 全部是 2D**（line 213-245 的 `RATIOS[]`，用 `dist2(x,y)`，不碰 Z）
- **modelA 的 3D 座標目前只用於視覺化和跨 scan σ 分析，還沒生成任何特徵**
- 眼睛/鼻子/嘴寬的「大小」ratio 都有 2D 版本，但沒 3D 版本

---

## 4. 未解決 / 待討論的事

> **2026-05-04 update**：4.1~4.4 多數已在 4-15/16 的 v15 研究中收斂解決，詳見 RESEARCH-REPORT。剩餘待辦見最下方「2026-05 後續待辦」段。

### 4.1 焦距（fx）問題**沒討論完**

- [ ] 不同距離下 fx 變動 50%（0.67~1.02），是否可接受？hash 穩定性受影響嗎？
- [ ] IPD=6.5cm 假設對不同人偏差（成人 5.5~7.5cm）會讓 fx 偏 ±15%，對 hash 衝擊？
- [ ] `ipdNorm in [0.12, 0.28]` sanity 區間怎麼定的？該不該收緊？
- [ ] 要不要讓使用者保持固定距離（例如 ~30cm）以減少變動？

### 4.2 Z 值穩定性**測試不足**

- [ ] 目前只驗證「同一人不同距離」— Z-heavy 特徵 CV 4.5%
- [ ] 未測：不同光線（暗、側光、逆光）下 Z 還穩嗎？
- [ ] 未測：極端頭部角度（pitch 俯仰）會不會讓 Z 系統性偏移？
- [ ] 未測：不同人之間 Z 分布差異多大？（決定 hash 的區分度，不只穩定度）

> **解決狀態**：v15 研究最終把 3 個 Z 軸特徵全進黑名單（雜訊太大），改用 2D + 3D distance（非純 Z）。fx 漂移雖未根治，但 26 特徵在跨距離 sessions 中仍 100% bin 一致。

### 4.3 3D 特徵定義**尚未開始**

> **解決狀態（2026-04-16）**：採取「同特徵 2D/3D 雙座標都算」，從 99 個候選經 offset=0 嚴格篩選 + 黑名單，得 26 個（2D=15、3D=11）。

### 4.4 Hash 挑選策略

> **解決狀態**：BIN_WIDTH=0.25 保留，量化方式 v17 SDK 用 floor-biased、v15 研究用 round() 配 offset=0。雙路線同時存在，SDK 整合是 M3。

---

## 2026-05 後續待辦

- [ ] 跨人區分性驗證（M1 原訂 4-20，已逾期）
- [ ] v15 26 特徵整合進 `sdk/src/face/structuralId.ts`（M3 目標 5-15）
- [ ] 半臉攻擊防護（landmark visibility 檢查）
- [ ] 口罩判定誤判修復（白皮膚冷光下 skinRatio 偏低）
- [ ] 跨機型驗證（Android Chrome / 桌面 WebRTC）

---

## 5. 用戶的原則（本 session 學到的）

1. **不要急著轉換目標** — 基礎研究要慢慢來，一個問題討論完再進下一個
2. **資料乾淨是第一要務** — 只存用得到的，legacy 全砍掉避免再踩雷
3. **UI 分析和模型研究是兩條獨立管線** — 不要混為一談
4. **先測試工具再 SDK** — 不要看到什麼都往 SDK 想
5. **信心度很重要** — 結論來回翻會動搖信心，要穩定推進

---

## 6. 相關檔案

| 檔案 | 說明 |
|------|------|
| `tools/face-id-test.html` | 主要測試工具，本 session 清理過 |
| `sdk/src/face/structuralId.ts` | SDK 的 3D 特徵實作（32 個特徵，6 類） |
| `docs/UNIQUE-FACE-ID.md` | 唯一 ID 設計文件 |
| `docs/BONE-RATIO-SYSTEM.md` | 骨骼比率系統定義 |
| `HANDOFF.md` | 本檔 |

**Log 分析用資料**（本 session 用過的）：
- `log-1776154242793.json` ~ `log-1776158666811.json`（前面 5 次掃描的多種測試）
- `log-1776177598328.json`（清理後第一份 log，只有 modelA，2 次掃描）

**部署方式**：MCP server `https://mcp.aegisrd.com/mcp` 的 `write_file` 到 `/var/www/aegisrd/face-id-test/index.html` → URL `https://aegisrd.com/face-id-test/`

---

## 7. 下一 session 建議開頭

1. 讀這份 HANDOFF.md
2. **不要急** — 先把 4.1 / 4.2 的 fx 和 Z 問題討論透
3. 可能要請用戶補測：不同距離、不同光線、不同人的 G 掃描
4. 4.1 / 4.2 結論出來後，才進 4.3（特徵定義）
5. 絕對不要再一眼抓 `landmarksCanon` — log 裡現在只剩 `landmarksModelA`，但還是要在分析前先 print 欄位確認
