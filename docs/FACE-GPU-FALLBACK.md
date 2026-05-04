# Face Landmarker GPU → CPU Fallback

**Status**: shipped 2026-05-04 (AegisID commit `e5997db`)
**Files**: `sdk/src/face/faceMesh.ts`, `sdk/src/face/useFaceRecognition.ts`

---

## 問題

部分 Android Chrome 設備（已知至少一台 owner 機種）跑 MediaPipe Tasks Vision
FaceLandmarker GPU delegate 會壞掉：

1. **`face_geometry` calculator 崩潰**
   ```
   procrustes_solver.cc: design_matrix.norm() > kAbsoluteErrorEps (0 vs. 1e-09)
   Design matrix norm is too small!
   Failed to estimate face geometry for multiple faces
   ```
   只在 `outputFacialTransformationMatrixes: true` 時這 calculator 才跑。

2. **整個 detect 拋例外**：calculator 死後 detectForVideo throw，後續所有 frame 都壞。

3. **不拋例外但回 garbage landmark**：座標非 normalized 0-1（觀察到 x 高達 1572，
   合理的 normalized 應 ≤1）。EAR 算出 0.039（正常 0.25-0.35），眨眼偵測完全失靈。

A/B 測試（同台 Android Chrome）：

| Delegate | face frames | EAR | xRange | 結果 |
|---|---|---|---|---|
| GPU | 卡 6 frame 不增長 | 0.037 | 1572（garbage）| ❌ blink challenge fail |
| CPU | 持續增長 | 0.140 | 0.29（normalized）| ✅ blink 通過 |

桌面 Chrome、iPhone Safari 沒事 — Metal/discrete GPU 跟 Android 內顯 driver
shader compile 行為差異。

## 修法（A+B fallback）

### A. GPU + 關掉觸發崩潰的 calculator

```ts
outputFacialTransformationMatrixes: false
```

關掉後 face_geometry calculator 不跑，procrustes solver 不會被觸發。

下游影響：MediaPipe 不再吐 4×4 transformation matrix。**檢查過 codebase
下游不依賴這個** —— `structuralId.ts:15` 註解明寫「Landmark-based rotation 不
依賴 MediaPipe matrix」，yaw 直接從 landmark 幾何算（faceMesh.ts:154-160）。
matrix 之前只是當 debug field 帶著走，可安全關。

### B. GPU 證實壞掉時自動切 CPU

只關 A 不夠 —— 上述 garbage landmark 是另一條獨立失敗路徑，不是 face_geometry
觸發的。所以加 runtime 健檢 + fallback：

```ts
// detect throw → 立刻切
try { result = landmarkerInstance.detect(video); }
catch (err) {
  if (currentDelegate === 'GPU') void fallbackToCpu('detect threw');
  return null;
}

// landmark x/y 不在 [0,1] = garbage
if (currentDelegate === 'GPU' && isGarbageLandmarks(landmarks)) {
  gpuBadFrameCount++;
  if (gpuBadFrameCount >= GPU_BAD_FRAME_THRESHOLD /* 5 */) {
    void fallbackToCpu(`${gpuBadFrameCount} consecutive garbage frames`);
  }
  return null;
}
```

`fallbackToCpu()`：close 現有 GPU instance → 重 init 用 CPU delegate → 標記
`localStorage.aegisid_face_gpu_failed = '1'`。下次 user 再開直接讀 localStorage
走 CPU init，不浪費時間試壞 GPU。

## 配套改動 (`useFaceRecognition.ts`)

### `DETECTION_INTERVAL: 100 → 200ms`

100ms (10fps) 在 Android GPU 上連續打 detectForVideo 會 backlog；200ms (5fps)
給 GPU pipeline 喘息。眨眼動作 100-300ms、轉頭數秒，5fps 完全足夠。

### `getUserMedia` 拿掉硬寫死的 width/height

```diff
- video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
+ video: { facingMode: 'user' }
```

手機前鏡頭 sensor native 多為 portrait（720x1280），強制 640x480 會被瀏覽器
壓進 4:3 框造成 vertically squashed 畫面 → landmark Y 軸全擠成一條線
（EAR ~0.039）。讓瀏覽器給原生比例最穩。

實測：拿掉後拿到 480x640 portrait（aspectRatio=0.75，正確垂直），EAR 從
0.039 變正常 0.14+。

### 診斷 log

加了 4 個 `[DIAG:*]` log 給未來除錯這類詭異設備問題：

| Log | 內容 |
|---|---|
| `[DIAG:CAMERA]` | video 解析度 + track settings + facingMode |
| `[DIAG:PIXELS]` | 64x64 canvas 取樣統計 RGB / luma min-max / non-zero ratio（驗證鏡頭真的有 pixel 進來）|
| `[DIAG:RAW0]` | 第一個 face landmark 完整 dump（看是不是 normalized 0-1）|
| `[DIAG:LANDMARK]` | 全 landmark x/y range + 眼瞼 Y 差（驗證座標系統）|

production 環境靠 `[RemoteDebug] Enabled` MQTT subscriber 撈得到（CLAUDE.md §12）。

## API 變更

新增 export 給 UI 顯示「目前用什麼 delegate」：

```ts
export function getCurrentDelegate(): 'GPU' | 'CPU'
```

可在 face setup 畫面右下角小字顯示，使用者能看到「目前 CPU 模式」之類提示。

## 為什麼之前沒撞到

- iOS Safari：用 Metal-based WebKit，GPU shader compile 走完全不同 pipeline
- 桌面 Chrome：discrete GPU + 大量 VRAM，driver 成熟
- Android Chrome：integrated GPU + 緊張的 thermal/power budget，driver 各廠
  （Adreno/Mali/PowerVR）implementation 各異

加上 Chrome / Android 系統會自動更新，某次更新後 ANGLE / WebGL impl 微變
就可能跨過閾值。owner 自己機種大約在 2026-04~05 之間踩中。

## 開發者除錯 SOP

如果未來又有「臉部偵測在某設備偵測不到」回報：

1. 該設備開 https://talk.aegisrd.com?debug=1 啟用 remoteDebugger（CLAUDE.md §12）
2. VPS 跑 `node /opt/webtop/projects/AegisTalk/scripts/debug-subscriber.js android`
3. 用戶觸發掃臉，看 log：
   - `[DIAG:CAMERA]` 解析度合理嗎？aspectRatio 對嗎？
   - `[DIAG:PIXELS]` luma 有對比嗎？非 0 比例 100%？
   - `[DIAG:RAW0]` lm0.x 在 0-1 嗎？
4. 如果鏡頭 OK 但 landmark garbage → fallback 路徑會自動處理；確認 console
   有 `[FaceMesh] GPU broken (...), falling back to CPU`
5. 如果 fallback 後仍壞，可能是 CPU delegate 也撞到問題（罕見），需要進一步
   測試或考慮第三種 backend

## 還能再做的事（沒做）

- **TTL 重試**：`localStorage` 標記永久。理論上 Chrome 升級後 GPU 可能修好，
  目前不會自動重試。可以加 7 天 TTL 後重試 GPU。
- **UI 提示**：fallback 發生時通知使用者「您的設備 face 偵測使用 CPU 模式，
  可能稍慢」。目前只在 console log，沒 UI。
- **`outputFaceBlendshapes: true` 是否也是觸發點**：blendshapes calculator
  也會跑額外運算。雖然 A+B 已經能跑，但有空可以驗證關掉 blendshapes 後
  GPU 是否完全 stable（口罩偵測就不能用了，trade-off）。

---

Co-debugged 2026-05-04 with AegisTalk owner（@graywei）on real Android device。
