# AegisID

> **匿名身份認證系統 — 知道是同一人，但不知道是誰**

AegisID 是 AegisRD 生態系的身份層，提供：

- **唯一臉部 ID** — 骨骼比率 3D hash，同一人永遠同一個 ID
- **匿名信用** — 詐騙風險分數跟著臉走，不洩露真實身份
- **防批量建號** — 唯一 ID O(1) 查重 + rate limiting
- **跨裝置恢復** — 轉頭掃臉 → 唯一 ID → VPS 查表 → 恢復帳號
- **日常登入** — 平面刷臉 + Anti-spoof + PIN 三層驗證

## 核心原則

| 能做到 | 不能做到 |
|--------|----------|
| 知道 Session A 和 Session B 是同一人 | 知道這個人是誰 |
| 知道這個人的詐騙風險分數 | 從資料反推真實身份 |
| 知道這個人是真人（anti-spoof） | 跨表關聯不同維度的記錄 |
| 阻擋深偽、雙胞胎、機器人 | 獲取用戶名字/電話/Email |

## 技術架構

```
客戶端 SDK (TypeScript)               VPS API (Python FastAPI)
┌───────────────────────────┐        ┌──────────────────────┐
│ 骨骼比率臉部辨識（統一系統）│        │ identity_anchors     │
│  註冊: 3D 掃描 → 唯一 ID  │  HTTP  │  face_structure_hash │ ← 唯一 ID
│  登入: 平面 → bin match   │ ────→ │  encrypted_blob      │ ← 加密身份包
│ Anti-spoof 防偽           │ ←──── │ credit_scores        │ ← 詐騙風險分數
│ PIN 行為指紋 18維         │        │ rate_limits          │ ← 防濫用(48hr)
│ 身份包加密/解密           │        │                      │
└───────────────────────────┘        └──────────────────────┘
```

## 專案結構

```
AegisID/
├── README.md
├── CLAUDE.md              # AI 助手開發指南
├── ROADMAP.md             # 開發階段規劃
├── HANDOVER.md            # 架構決策記錄（ADR-001~016）
├── sdk/                   # 客戶端 SDK (TypeScript)
│   └── src/
│       ├── face/          # 骨骼比率臉部辨識 + Anti-spoof
│       ├── behavior/      # PIN 行為指紋（18 維）
│       ├── lsh/           # LSH 匹配
│       ├── identity/      # 身份包加密/裝置指紋
│       └── credit/        # 信用 token
├── models/                # ONNX 模型（anti-spoof）
├── docs/                  # 設計文件
└── tools/                 # 測試工具（face-id-test.html v14）
```

## 快速開始

```bash
# 安裝 SDK
npm install @aegisrd/aegisid

# 使用
import { AegisID } from '@aegisrd/aegisid';
const aegisId = new AegisID({ apiUrl: 'https://api.aegisrd.com' });
```

## 相關專案

| 專案 | 關係 |
|------|------|
| [AegisTalk](https://github.com/GrayWei444/Aegistalk) | 主要消費者，E2EE 通訊 + AI 防詐 |
| [AegisAI](https://github.com/GrayWei444/AegisAI) | Rust WASM AI 核心 |
| [AegisBot](https://github.com/GrayWei444/AegisBOT) | AI 自動化系統 |

## 授權

Proprietary - AegisRD

---

**維護者**: AegisRD Team
**GitHub**: GrayWei444
