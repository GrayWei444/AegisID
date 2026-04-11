# SECURITY_ADVISORY — 供應鏈與構建安全備忘

> **起因**: 2026-03-31 Anthropic Claude Code 原始碼外洩事件
> **適用**: AegisRD 全線專案
> **建立日期**: 2026-04-01

---

## 事件摘要

Claude Code v2.1.88 的 npm 發佈包中，因未排除 `.map` source map 檔案，
導致完整 TypeScript 原始碼（1,900 檔案 / 512,000+ 行）被公開下載。
同一時段 axios npm 套件遭供應鏈攻擊，惡意版本內嵌遠端存取木馬（RAT）。

**根因**: Bun bundler 預設生成 source map + `.npmignore` / build config 未排除 → 打包時意外夾帶。

---

## 對 AegisRD 的啟示

雖然我們的專案皆為 **private repo + App 發佈**，不經 npm registry 公開分發，
但以下風險面仍然適用：

### 1. Build 產出物審計

- **Source Map**: 確保 production build 不包含 `.map` 檔案
  - Vite: `build.sourcemap = false`（預設即 false，但應明確設定）
  - Capacitor build 後檢查 `dist/` 與 APK/IPA 內容
- **Debug 資訊**: production 模式下不應包含 `console.log` 敏感輸出、內部 API endpoint、feature flag 名稱等
- **定期抽查**: 每次重大版本發佈前，手動檢查 build 產出：
  ```bash
  # 檢查是否有 source map 被打包
  find dist/ -name "*.map" -type f
  # 檢查 APK 內容（Android）
  unzip -l app-release.apk | grep -E "\.map$|\.ts$"
  ```

### 2. 供應鏈依賴安全

- **鎖定版本**: `package-lock.json` / `yarn.lock` 必須提交至 git，避免 floating version 拉到被劫持的套件
- **定期審計**:
  ```bash
  npm audit
  npm outdated
  ```
- **最小依賴原則**: 能用標準庫完成的，不引入第三方套件
- **關注高風險套件**: axios、lodash 等高 star 套件反而是攻擊者的首選目標
- **Rust/WASM 依賴**: `cargo audit` 同樣適用於 AegisAI 的 Rust crate

### 3. 機敏資訊不進 Build

- API Key、MQTT 憑證、內部 endpoint 一律透過環境變數或執行期注入
- `.env` 檔案加入 `.gitignore`（已執行，持續確認）
- Build 產出中搜尋機敏關鍵字：
  ```bash
  # 掃描 dist 是否意外包含憑證
  grep -rn "password\|secret\|api_key\|mqtt.*admin" dist/ || echo "✅ Clean"
  ```

### 4. Git 與發佈衛生

- **`.gitignore` 定期複查**: 確保 `dist/`、`*.map`、`.env`、`node_modules/` 等皆在排除清單
- **Commit 前 diff review**: `git diff --cached` 確認無機敏內容
- **Tag & Release**: 正式版本打 git tag，確保可追溯
- **不在 commit message 暴露內部代號**: 避免洩漏未公開的功能名稱或架構細節

### 5. Capacitor / App 特定注意事項

- iOS IPA 與 Android APK 本質上是 zip 壓縮包，內部的 web assets 可被解壓檢視
- 即使是 App Store 發佈，也應假設 build 產出物可能被逆向
- **ProGuard/R8**（Android）與 **bitcode**（iOS）提供額外混淆層，但非萬能
- WebView 中的 JS 程式碼幾乎等同明文 — 核心邏輯應盡可能放在 Rust/WASM 或 Native 層

### 6. Docker / 部署環境

- Container image 不應包含 `.git/` 目錄、source map、測試資料
- Multi-stage build 確保 final image 只包含 runtime 必要檔案
- 定期檢查已部署的 web assets：
  ```bash
  find /var/www/aegisrd/ -name "*.map" -type f
  ```

---

## Checklist（每次重大發佈前）

- [ ] `dist/` 內無 `.map` 檔案
- [ ] `dist/` 內無 `.ts` / `.tsx` 原始碼
- [ ] 無硬編碼的 API Key / 憑證 / 內部 endpoint
- [ ] `package-lock.json` 已提交且版本鎖定
- [ ] `npm audit` 無 critical / high vulnerability
- [ ] APK/IPA 解壓後無敏感檔案
- [ ] Git tag 已打，commit history 乾淨
- [ ] Docker image 不含開發期 artifacts

---

## 參考事件

| 日期 | 事件 | 根因 | 影響 |
|------|------|------|------|
| 2026-03-31 | Claude Code 原始碼外洩 | npm 包夾帶 source map | 512K 行原始碼、feature flags、產品路線圖全部公開 |
| 2026-03-31 | axios 供應鏈攻擊 | npm 套件被植入 RAT | 安裝特定版本的開發者機器可能被完全入侵 |
| 2026-03-28 | Anthropic 內部文件外洩 | 公開 data cache 未限制存取 | 未發佈模型代號與能力細節曝光 |

---

## 結語

> 「安全不是功能，是習慣。」
>
> 即使我們是 private repo、App-only 發佈，也不能假設 build 產出物永遠不會被第三方看到。
> 每一次 build 都應該假設產出物會被逆向分析，並據此決定什麼該包含、什麼不該包含。

---

*AegisRD — 讓詐騙在你身邊無所遁形*
