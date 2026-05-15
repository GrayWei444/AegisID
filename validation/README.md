# AegisID Validation — 臉部唯一身份的驗證流程

> **這份文件屬於 AegisID 專案** (`/opt/webtop/projects/AegisID/validation/`)
> AegisID 的驗證**不需要**公開人臉資料集 (LFW/CASIA),因為我們驗的是「同一張臉是否產出相同 hash」,不是「相似度比對」。

---

## 為什麼 AegisID 不能用 LFW / CASIA-WebFace 直接驗證

| 項目 | 公開資料集 (LFW/CASIA) | AegisID 需要的資料 |
|---|---|---|
| 影像來源 | 名人合照,單張為主 | 同一人多次自拍 (≥20 次) |
| 評估指標 | 1:1 cosine similarity > 閾值 | hash exact match rate |
| 拍攝場景 | 戶外/活動隨拍 | 註冊用 3D 頭轉掃描 + 登入用平面刷臉 |
| 同人多影像 | 同一人通常只有 1-5 張 | 需要 20+ 張橫跨光線/時間 |

**結論**:LFW 只能驗證 baseline ArcFace embedding 模型的 1:1 準確率,
作為**對照數字**(industry baseline 99.83%),不能直接餵 AegisID 評分。

---

## 兩階段驗證:Phase 4 自驗 → Phase 5 跨人

### Phase 4 — 自驗 (intra-user consistency)

**問題**:同一張臉,在不同光線/角度/時間,是否永遠產出同一個 hash?

**做法**:
1. 你自己拍 20 次,涵蓋:室內光、戶外光、晨/午/夜、戴/不戴眼鏡、有/無瀏海
2. SDK 每次輸出 `final_identity_hash` 並寫入 `self_capture/captures.jsonl`
3. 執行驗證腳本

```bash
cd /opt/webtop/projects/AegisID/validation
python3 scripts/eval_aegisid.py \
  --captures self_capture/captures.jsonl \
  --phase 4 \
  --out reports/phase4_$(date +%Y%m%d).json
```

**目標指標**:
- `avg_exact_match_rate ≥ 0.85` (20 次中至少 17 次產出同一 hash)
- 不重複 hash 數量 ≤ 3 (容許 ≤3 個邊緣 case 的不同 hash)

### Phase 5 — 跨人 (inter-user collision)

**問題**:不同的人,是否會意外撞出同一個 hash?

**做法**:
1. 找 2-3 個朋友各拍 10 次
2. 全部紀錄合併到 `cross_user/captures.jsonl`
3. 執行驗證

```bash
python3 scripts/eval_aegisid.py \
  --captures cross_user/captures.jsonl \
  --phase 5 \
  --out reports/phase5_$(date +%Y%m%d).json
```

**目標指標**:
- `collision_rate = 0` (任何兩個不同 `user_id` 不得共享 hash)
- 若出現碰撞,需重新檢視 BIN_WIDTH 量化是否太粗

---

## 取樣紀錄格式

`captures.jsonl` 一行一筆:

```json
{"user_id": "gray", "capture_id": "001", "hash": "abc...sha256hex", "pin_hash": "...", "timestamp": "2026-05-15T10:00:00Z", "conditions": "室內,正面,白光"}
```

模板在 `self_capture/captures_template.jsonl`,直接複製改用。

---

## SDK 端需要的支援 (TODO)

目前 SDK `/sdk/src/face/` 計算出 hash 後**沒有 export 介面**。
需要加一個 debug 模式,把每次掃描的結果寫進 JSONL。

下一步:在 SDK 加 `exportCaptureRecord(hash, conditions)` 並寫到本地檔案。

---

## 報告產出位置

`reports/phase{N}_{YYYYMMDD}.json` — 直接可餵入商業計畫書「實測驗證」章節。
