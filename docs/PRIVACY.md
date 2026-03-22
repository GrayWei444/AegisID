# AegisID 隱私設計文件

> 本文件記錄 AegisID 的隱私設計決策，可用於合規審計。

---

## 核心原則

**知道是同一人，但不知道是誰。不能知道是誰。不能連結到誰。**

---

## 資料分類

### 永不離開用戶裝置的資料

| 資料 | 說明 |
|------|------|
| Ed25519 私鑰 | 用 PIN 加密後存本地 |
| 正面骨骼 bins (24 bin indices) | 登入比對基準，只存本機 |
| PIN 明文 | 只在記憶體中存在 |
| PIN hash/salt | 本地 Argon2id |
| 行為 baseline (18維 float) | 存在加密身份包中 |

### 上傳到 VPS 的資料（匿名化）

| 資料 | 型態 | 可反推？ | 壽命 |
|------|------|---------|------|
| face_structure_hash | SHA-256 | 不可反推臉部（量化 bin 不可逆） | 永久 |
| fraud_risk_score | float | 風險分數，跟著唯一 ID | 永久 |
| encrypted_blob | AES-256-GCM 密文 | 需 PIN 才能解密 | 永久 |
| credit_token | HMAC hash | 不可反推 pubkey | 永久 |
| ip_token | HMAC hash | 不可反推 IP | 48hr |
| device_token | HMAC hash | 不可反推裝置 | 48hr |

### VPS 上絕不存在的資料

- 用戶名字、電話、Email
- 原始 IP 地址
- 原始裝置指紋
- 原始 face embedding
- 原始 PIN 行為特徵
- pubkey 或 pubkey_hash（在 identity_anchors 中）

---

## 三表分離的數學保證

```
identity_anchors 表的 key:   face_structure_hash（SHA-256 of 骨骼比率 bins）
credit_scores 表的 key:      face_structure_hash（同一張臉 = 同一個風險分數）
rate_limits 表的 key:        HMAC(各維度 hash, dimension_secret)

注意：identity_anchors 和 credit_scores 現在共用 face_structure_hash 作為 key。
這是有意設計 — 詐騙風險分數必須跟著唯一臉部 ID 走。
但 rate_limits 仍使用獨立 HMAC secret，無法關聯。

安全性：face_structure_hash 是 SHA-256(量化 bin indices)，
        24 個 bin index 無法反推出原始臉部結構。
```

---

## VPS 被入侵的最壞情況分析

### 場景 1：只取得資料庫

攻擊者看到：
- N 行 (face_structure_hash, encrypted_blob)
- M 行 (face_structure_hash, fraud_risk_score)
- K 行 (token, dimension, count)（最多 48hr 資料）

攻擊者不能：
- 解密任何 blob（沒有 PIN）
- 反推任何臉部特徵（LSH 是單向的）
- 關聯三張表（不同 key space）
- 知道任何人的身份

### 場景 2：取得資料庫 + HMAC secrets

額外能做的：
- 如果有某人的 pubkey_hash → 可算出 credit_token → 查到信用分數
- 但仍無法跟 identity_anchors 關聯（input 不同）

不能做的：
- 仍無法從 face_lsh_hash 反推臉部
- 仍無法從 ip_token 反推 IP（HMAC 是單向的）
- 仍無法解密 blob

### 場景 3：取得資料庫 + secrets + 某人的 PIN

能做的：
- 解密那一個人的 blob → 得到 privateKey
- 但需要先知道是哪個 blob（需要 face_lsh_hash）

不能做的：
- 解密其他人的 blob（每人不同 PIN）

---

## 合規準備

### 台灣個資法

第 6 條：生物辨識資料為特種個資。

AegisID 的立場：
- face_lsh_hash 是從 embedding 經 LSH 產出的 hash
- 無法從 hash 反推 embedding，更無法反推臉部影像
- 但保守做法：取得用戶明確同意

建議文案（註冊時顯示）：
「AegisTalk 使用臉部特徵的單向雜湊值來確認帳號唯一性。此雜湊值無法還原為臉部影像或辨識您的真實身份。」

### GDPR

第 9 條：生物辨識資料處理需明確同意。

AegisID 的做法：
- 註冊時明確勾選同意
- 提供「刪除我的身份」功能（刪除 identity_anchors 記錄）
- 48hr rate_limits 自動清除符合 data minimization 原則

---

**維護者**: AegisRD Team
**建立日期**: 2026-03-14
