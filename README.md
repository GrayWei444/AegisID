# AegisID

> **匿名身份認證系統 — 知道是同一人，但不知道是誰**

AegisID 是 AegisRD 生態系的身份層，提供：

- **身份唯一性** — CNN FaceID + PIN 行為指紋聯合認證
- **匿名信用** — 累積交易信用，不洩露真實身份
- **防批量建號** — 多維度 rate limiting，48 小時自動清除
- **跨裝置恢復** — 刷臉 + PIN 即可在新裝置恢復帳號

## 核心原則

| 能做到 | 不能做到 |
|--------|----------|
| 知道 Session A 和 Session B 是同一人 | 知道這個人是誰 |
| 知道這個人的信用分數 | 從資料反推真實身份 |
| 知道這個人是真人 | 跨表關聯不同維度的記錄 |
| 阻擋深偽、雙胞胎、機器人 | 獲取用戶名字/電話/Email |

## 技術架構

```
客戶端 SDK (TypeScript)          VPS API (Python FastAPI)
┌─────────────────────┐        ┌──────────────────┐
│ CNN FaceID 512維     │        │ identity_anchors │ ← 身份查找
│ PIN 行為指紋 18維    │  HTTP  │ credit_scores    │ ← 信用累積
│ LSH 模糊匹配        │ ────→ │ rate_limits      │ ← 防濫用(48hr)
│ 身份包加密/解密      │ ←──── │                  │
│ 活體偵測            │        │ 三表分離，不可關聯 │
└─────────────────────┘        └──────────────────┘
```

## 專案結構

```
AegisID/
├── README.md
├── CLAUDE.md              # AI 助手開發指南
├── ROADMAP.md             # 開發階段規劃
├── HANDOVER.md            # 架構決策記錄
├── api/                   # VPS API (Python FastAPI)
├── sdk/                   # 客戶端 SDK (TypeScript)
│   └── src/
│       ├── face/          # CNN 臉部辨識（從 AegisTalk Phase 26 遷移）
│       ├── behavior/      # PIN 行為指紋（18 維重新設計）
│       ├── lsh/           # LSH 模糊匹配
│       ├── identity/      # 身份包加密/裝置指紋
│       └── credit/        # 信用 token
├── components/            # React UI 元件
├── models/                # ONNX 模型
├── docs/                  # 設計文件
└── tools/                 # 測試工具
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
