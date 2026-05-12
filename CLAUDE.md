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

### 2.1 統一骨骼比率系統（v17 + v20 PnP 3D，2026-05-10 更新）

**一套系統做到底** — 骨骼比率同時服務註冊和登入，不再需要 CNN。

**v17 2D 比率**（[sdk/src/face/structuralId.ts](sdk/src/face/structuralId.ts)）：
- **2D + 3D 混合**：25 個穩定 2D 比率（`STABLE_RATIO_WHITELIST`）+ 11 個穩定 3D 特徵（`STABLE_3D_FEATURES`，T/E/N/F/G 類）
- **多基準正規化**：垂直 → `fh`、水平 → `(IPD + browW) / 2`、自比率不需基準
- **floor-biased 量化**：`frac ≥ 0.80` 才進位（取代 v14 的 round），減少 bin 邊界跳動
- **聯合 hash**：`hashCombined = SHA-256(hash2D + hash3D) = 唯一 Face ID`
- 測試：3/3 穩定（同一人三次掃描 hash 一致）

**v20 PnP 3D 重建**（[sdk/src/face/build3DPnP.ts](sdk/src/face/build3DPnP.ts), 2026-05-10 取代 v17 multi-ray）：
- **Perspective camera + canonical face model**：每幀對 MediaPipe canonical 468 點跑 Gauss-Newton 解 R, T，再多射線三角測量
- **Robust against large yaw**：v17 orthographic 假設在大 yaw 時 IPD 透視壓縮 → 推算錯；v20 用真 perspective camera 解算精準
- **自動丟壞幀**：PnP finalErr ≥ 0.05 視為發散，該幀不參與三角測量
- **landmark-based YPR 初始化**：避免 GN 在大 yaw 從 identity 發散
- **canonical 化輸出**：tkCanonicalize 對齊軸 + 反射修正 + EOD 正規化（與測試頁完全同源）
- 來源：tools/face-id-test.html v39 buildPnPModel + canonical_face_model 468 vertices

**v15 平行研究**（[docs/RESEARCH-REPORT-UNIQUE-FACE-HASH.md](docs/RESEARCH-REPORT-UNIQUE-FACE-HASH.md)）：
- 26 個跨 41 captures 100% bin-stable 特徵，offset=0 嚴格篩選
- 同一人 N=1 已驗證，跨人區分性待驗證
- **尚未整合進 SDK**（M3 目標 2026-05-15）

```
┌─────────────────────────────────────────────────────────┐
│                    AegisID 身份認證                       │
│                                                         │
│  ┌───────────────────────┐  ┌────────────────────────┐  │
│  │ 註冊/帳號恢復（一次性） │  │ 日常登入（每次）        │  │
│  │                       │  │                        │  │
│  │ 3D 轉頭掃描           │  │ 平面刷臉               │  │
│  │ → 多角度 landmarks    │  │ → 正面 landmarks       │  │
│  │ → 真 3D 三角測量      │  │ → 25 個 2D bins        │  │
│  │ → 25 個 2D bins       │  │ → 比對本機正面基準      │  │
│  │ + 11 個 3D bins       │  │ → bin match rate       │  │
│  │ → hash2D + hash3D     │  │                        │  │
│  │ → SHA-256(combined)   │  │ + Anti-spoof 防偽      │  │
│  │ → face_hash (限速)    │  │ + 活體挑戰              │  │
│  │ → account_key (查找)  │  │   (blink/turn/mask)   │  │
│  │                       │  │ + PIN 碼驗證           │  │
│  │ + Anti-spoof 防偽     │  │                        │  │
│  │ + 活體挑戰 + PIN      │  │ → ≥80% bins match     │  │
│  │ + 裝置指紋 + IP 限速  │  │ → 通過                 │  │
│  │ → VPS 查重+存儲       │  │                        │  │
│  └───────────────────────┘  └────────────────────────┘  │
│                                                         │
│  每個帳號(face+PIN)綁定詐騙風險分數（跟帳號走，不跟裝置）  │
└─────────────────────────────────────────────────────────┘
```

### 2.2 註冊流程（3D 掃描 + 活體挑戰 + PIN）

```
活體挑戰序列：[remove_mask?] → blink → turn_head（口罩偵測時自動注入 remove_mask）
    ↓
轉頭 3D 掃描 → MediaPipe 468 landmarks × 多角度
    → 真 3D 三角測量（multi-ray least-squares）
    → 25 個 2D 穩定比率 + 11 個 3D 穩定特徵
    → BIN_WIDTH=0.25, floor-biased 量化（frac≥0.80 才 ceil）
    → hash2D + hash3D → SHA-256(combined) = 唯一 Face ID

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

### 2.3 日常登入流程（臉 + 活體 + PIN）

```
活體挑戰（liveness.ts）：
  - blink（自適應 EAR 下降偵測，2026-04 後改為相對閾值）
  - turn_head（完成後停留 2.5s 爭取 VPS 查詢時間）
  - remove_mask（偵測到口罩時動態注入到挑戰序列最前）

平面刷臉（5 幀取 median）
    → 25 個 2D 比率 → bins
    → 比對本機存的正面基準 bins
    → bin match rate ≥ 80% → 通過

+ Anti-spoof 防偽檢查（MiniFASNetV2SE）
+ 口罩偵測（HSV 膚色 AND Blendshape 嘴部，雙重判定）
+ PIN 碼驗證（解密本機身份包）

臉 + 活體 + PIN 多層確認 → 放行
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

### 2.6 骨骼比率臉部辨識（v17 SDK 實作）

- 引擎：MediaPipe FaceLandmarker (~4MB) — 468 landmarks
- **GPU/CPU fallback**（2026-05-04 shipped）：偵測 GPU shader 故障 / garbage landmark / detect throw 時自動切 CPU delegate，並寫入 `localStorage.aegisid_face_gpu_failed` 跳過下次 GPU 嘗試。詳見 [docs/FACE-GPU-FALLBACK.md](docs/FACE-GPU-FALLBACK.md)
- 防偽：MiniFASNetV2SE — 照片/面具/螢幕偵測 (612KB)
- **v17 特徵集**（[sdk/src/face/structuralId.ts](sdk/src/face/structuralId.ts)）：
  - 25 個穩定 2D 比率（`STABLE_RATIO_WHITELIST`：F02/F03、EL02-08、ER02-08、B01-07、N01-04/N10、X03/X05）
  - 11 個穩定 3D 特徵（`STABLE_3D_FEATURES`：T01/T02/T03/T05、E03-05、N05、F04/F05、G02）
- **多基準正規化**：垂直 → fh、水平 → (IPD+browW)/2、自比率不需基準
- **量化**：BIN_WIDTH=0.25，floor-biased（frac≥0.80 才 ceil）— 取代 v14 的 round()
- **v20 真 3D 三角測量**：PnP perspective + canonical face model + 多射線三角測量（取代 v17 orthographic landmark-rotation）— 詳見 [build3DPnP.ts](sdk/src/face/build3DPnP.ts)
- MobileFaceNet CNN 13MB 模型已移除，臉部辨識完全使用骨骼比率系統
- 完整實作：`computeBoneRatios`, `compute3DFeatures`, `buildPnPModel` (= `buildTrue3DModel` alias), `computeStructuralId`, `matchLoginBins`

詳見: `docs/UNIQUE-FACE-ID.md`, `docs/BONE-RATIO-SYSTEM.md`, `docs/IMAGE-NORMALIZATION.md`, `docs/FACE-GPU-FALLBACK.md`, `docs/RESEARCH-REPORT-UNIQUE-FACE-HASH.md`

### 2.6b 唯一 ID 演進（v14 → v17 SDK + v15 研究路線）

**v14（舊，已被 v17 取代）：** 25 個 3D bone ratio bins + round() 量化，bin 邊界跳動導致 hash 不穩定。

**v17（已落地於 SDK，2026-03-22）：**
```
hash2D = SHA-256(25 個 2D bin 序列)
hash3D = SHA-256(11 個 3D bin 序列)
hashCombined = SHA-256(hash2D + hash3D)  ← 寫入 VPS 的唯一 Face ID
account_key  = SHA-256(hashCombined + PIN)
```
- 多基準正規化避開單一參考量導致的 bin 邊界
- floor-biased 量化（frac≥0.80 才 ceil）抑制邊界跳動
- 3/3 同人重複掃描 hash 一致

**v15（並行研究路線，[docs/RESEARCH-REPORT-UNIQUE-FACE-HASH.md](docs/RESEARCH-REPORT-UNIQUE-FACE-HASH.md)）：**
- 從 99 個候選（51 ratio × 2D/3D 雙座標 + 3 個 Z 軸）中以 offset=0 嚴格篩選 + 跨 5 sessions 黑名單過濾
- 最終 26 個特徵跨 41 captures hash 100% 一致（同一人 N=1 已驗證）
- 跨人區分性、半臉攻擊防護、SDK 整合 — 仍是 pending（M3 目標 2026-05-15）

**待驗證：**
- 同一人 10 次掃描 → 10 次 hash 必須完全一致（v17 已 3/3，v15 已 41/41）
- 不同人 → hash 必須不同（**跨人區分性尚未驗證 — M1 待辦**）
- 雙胞胎 + 不同 PIN → account_key 不同

**相關檔案：**
- `sdk/src/face/structuralId.ts` — `computeStructuralId`, `compute3DFeatures`, `buildTrue3DModel`
- `sdk/src/face/faceMesh.ts` — GPU/CPU fallback, `getCurrentDelegate()`
- `sdk/src/face/liveness.ts` — challenge 序列, `injectOcclusionChallenges`
- `sdk/src/face/cnnInference.ts` — `checkSkinColorMask` + Blendshape 雙重 mask 判定
- `sdk/src/face/useFaceRecognition.ts` — 掃描流程, zone capture, challenge progress
- `sdk/src/anchor/identityAnchor.ts` — VPS 註冊/查找
- `tools/face-id-test.html` — v17~v38 測試工具
- `logs/verify_top26.py`, `logs/bin_match_rate.py` — v15 研究腳本

### 2.6c 分層防禦架構（v20, 2026-05-10 實測確立）

**核心決策**：單一遮擋閘門 + 身分閘門，不重疊不混用。

| 攻擊類型 | 負責防線 | 實作位置 |
|---------|---------|---------|
| **半臉 / 口罩 / 帽子 / 墨鏡 / 任何遮擋** | **v20 Occlusion Gate**（41 lm × Lap+RGB × 區域投票）| `occlusionGate.ts` |
| **不同人冒充**（cross-person） | LSH 身分區分 | `structuralLsh.ts` + `matchLoginLSH` |
| **照片 / 螢幕 / 面具** | Anti-spoof（z-depth + 微動）| `cnnInference.ts` |
| **靜態圖（不會動）** | 活體挑戰（眨眼/轉頭，僅註冊）| `liveness.ts` |
| **錯誤雙胞胎（同臉不同 PIN）** | account_key = SHA-256(face + PIN) | `structuralId.ts` |

**v20 Occlusion Gate（2026-05-10 實測驗證）**：
- 在 41 個關鍵 landmark 位置採 11×11 像素 patch
- 雙訊號：Laplacian 邊緣強度 + RGB 平均色差
- 個人化 baseline（首次註冊前 `calibrateGate()` 採 2 秒乾淨臉）
- 5 個區域投票（TOP/LEFT/RIGHT/BOTTOM/CENTER）— 任一區 ≥50% landmark 異常 → 該幀遮擋
- **註冊與登入共用同一閘門**：每幀進入下游 landmark 數學前先過閘門，被遮幀直接丟棄
- 實測（gate-log-1778417206067）：
  - 乾淨臉 0/104 誤判
  - 手遮左半 78/104 偵測（v19 是 0/104）
  - 手遮右半 102/102 偵測

**為何 LSH 擋不了半臉**（v18 v19 實測證明）：
- MediaPipe FaceLandmarker 對被遮的 landmark 用 3DMM 推測產生幻覺座標
- 推測對「該用戶」很準（同人遮 60% 仍能 Hamming=10/128 通過 LSH）
- 任何 hash/LSH 變體都救不了 — 輸入 landmark 已經被 MediaPipe「修復」過
- 必須在「畫面像素層」用看實際 RGB + 邊緣的閘門擋住，這就是 v20 Gate

**雙重保險已移除**（2026-05-10）：
- 舊的 HSV 膚色 + Blendshape 嘴部活動度（`checkSkinColorMask` + `checkBlendshapeMask`）已停用
- `detectOcclusion` 永遠回傳 `hasMask: false`，`remove_mask` challenge 不再注入
- 所有遮擋判定統一由 v20 Gate 處理

**登入 UX**：登入時 **不要求** 任何挑戰（不眨眼、不轉頭）— 純靜態正面 3 秒，閘門自動過濾遮擋幀。
**註冊 UX**：仍要求 blink + turn_head 挑戰（為了建 3D 模型），但這些挑戰只能在閘門通過的幀上推進。

**Hook API**（`useFaceRecognition`）：
- `gateBaselineReady: boolean` — 是否已校準
- `gateOcclusion: { region } | null` — 當前幀遮擋狀態（給 UI 顯示「請移除遮擋」用）
- `calibrateGate(durationMs?): Promise<boolean>` — 第一次註冊前呼叫一次

**測試頁與 AegisTalk 一致**：
- `tools/face-id-test.html` 的 v20 Gate 與 SDK 完全同源（同 41 landmark、同閾值、同區域定義）
- 在測試頁通過的閾值，在 AegisTalk 應該行為一致

### 2.6d 已知問題

**口罩判定誤判 (嚴重度：中)**
- 現有 `checkSkinColorMask()` HSV 膚色分析 + Blendshapes 雙重判定
- 問題：某些膚色/光線條件下誤判（白皮膚在冷光下 skinRatio 低 → 誤判有口罩）
- 問題：口罩已摘下但 blendshapes 延遲更新 → challenge 不通過
- 修復方向：調整 HSV 閾值範圍 + blendshapes 權重，考慮加入嘴巴 landmark 開合度作為第三重判定
- 相關檔案：`sdk/src/face/cnnInference.ts` (`checkSkinColorMask`, `OcclusionResult`)

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
│       ├── face/                      # ✅ 骨骼比率臉部辨識（v17 統一系統）
│       │   ├── structuralId.ts        # ✅ v17 唯一 Face ID（25 個 2D + 11 個 3D + 真 3D 三角測量 + SHA-256）
│       │   ├── cnnInference.ts        # ✅ Anti-spoof + 口罩偵測（HSV AND Blendshape）
│       │   ├── embedding.ts           # Landmark embedding (降級 fallback)
│       │   ├── faceMesh.ts            # ✅ MediaPipe wrapper + GPU/CPU 自動 fallback
│       │   ├── liveness.ts            # ✅ 活體偵測（blink + turn_head + remove_mask 動態注入）
│       │   ├── storage.ts             # ✅ 加密儲存（使用 DatabaseAdapter）
│       │   ├── types.ts               # 型別（含 LivenessChallenge：blink/turn_head/turn_left/turn_right/remove_mask）
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
│   ├── UNIQUE-FACE-ID.md                  # 唯一臉部 ID 核心設計文件
│   ├── BONE-RATIO-SYSTEM.md               # 67 骨骼比率系統（完整定義+篩選方法）
│   ├── IMAGE-NORMALIZATION.md             # 影像正規化演算法（已驗證 SSIM 0.993）
│   ├── face-structure-id-research.md      # 早期研究過程記錄
│   ├── RESEARCH-REPORT-UNIQUE-FACE-HASH.md # v15 研究報告（26 特徵 41/41 hash 一致）
│   ├── FACE-GPU-FALLBACK.md               # GPU shader fail 自動切 CPU 文件（2026-05-04 shipped）
│   └── PRIVACY.md                         # 隱私設計文件
│
├── logs/                                  # v15 研究腳本與 sessions log
│   ├── verify_top26.py                    # 26 特徵 hash 一致性驗證
│   ├── bin_match_rate.py                  # 主分析腳本（含黑名單）
│   ├── analyze_2d_vs_3d.py                # 2D/3D CV 對照
│   └── log-*.json                         # 5 sessions × 41 captures
│
├── tools/
│   └── face-id-test.html                  # 臉部辨識測試頁面（v17~v38 迭代）
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
| 骨骼比率 structuralId v17 | ✅ SDK + hook 整合完成 | 25 個 2D + 11 個 3D 特徵，多基準 + floor-biased |
| GPU/CPU fallback | ✅ 2026-05-04 shipped | `getCurrentDelegate()` + `aegisid_face_gpu_failed` localStorage |
| 活體挑戰 | ✅ | blink + turn_head + remove_mask（口罩偵測時動態注入） |
| v15 26 特徵研究 | 🔄 進行中 | 同人 41/41 已驗證；跨人區分性與 SDK 整合 pending（M3 目標 5/15） |
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

- 骨骼比率 v17 穩定性：3/3 同人重複掃描 hash 一致 ✅（BIN_WIDTH=0.25, floor-biased）
- v15 研究：26 特徵跨 41 captures 100% bin 一致 ✅（同人 N=1）
- **跨人區分性尚未驗證**（v17 與 v15 都未測） — M1 待辦
- **半臉攻擊防護未做** — 已知漏洞
- 登入 bin match 閾值 ≥80%（`LOGIN_MATCH_THRESHOLD` in structuralId.ts）

---

**維護者**: AegisRD Team
**建立日期**: 2026-03-14
**最後更新**: 2026-05-04（v17 + GPU fallback + mask challenge + adaptive blink）
