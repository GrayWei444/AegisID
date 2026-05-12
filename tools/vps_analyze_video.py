#!/opt/mp-venv/bin/python
"""
VPS-side MediaPipe video analysis — research-stage only.

Input:   /var/www/aegisrd/face-id-test/video-{ts}.webm
Output:  /var/www/aegisrd/face-id-test/analysis-{ts}.json

Schema (matches browser v32 rawFrames/matrices):
{
  "ts": <int>,
  "videoFile": "video-{ts}.webm",
  "fps": <float>,
  "frameCount": <int>,
  "width": <int>,
  "height": <int>,
  "rawFrames": [ [[x,y,z], ...468], ... ],   # 4-decimal precision
  "matrices":  [ [16 floats], ... ],          # 4x4 row-major, 4-decimal
  "blendshapes": [ [{c,s}, ...52], ... ]      # optional, reduced
}

Usage: vps_analyze_video.py <video_path> [output_json]
"""
import sys, os, json, time
from pathlib import Path

import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision as mp_vision

MODEL_PATH = '/opt/mp-venv/models/face_landmarker.task'


def r4(x):
    return round(float(x), 4)


def analyze(video_path: str, output_path: str):
    t0 = time.time()
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f'cannot open video: {video_path}')

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    print(f'[analyze] {Path(video_path).name}: {width}x{height} @ {fps:.1f}fps, {frame_count} frames', flush=True)

    base_opts = mp_python.BaseOptions(model_asset_path=MODEL_PATH)
    options = mp_vision.FaceLandmarkerOptions(
        base_options=base_opts,
        running_mode=mp_vision.RunningMode.VIDEO,
        num_faces=1,
        output_face_blendshapes=True,
        output_facial_transformation_matrixes=True,
        min_face_detection_confidence=0.5,
        min_face_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    landmarker = mp_vision.FaceLandmarker.create_from_options(options)

    raw_frames = []
    matrices = []
    blendshapes = []
    detected = 0
    frame_idx = 0

    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            # cv2 BGR -> RGB for MediaPipe
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            ts_ms = int((frame_idx / fps) * 1000)
            result = landmarker.detect_for_video(mp_image, ts_ms)

            if result.face_landmarks and len(result.face_landmarks) > 0:
                lms = result.face_landmarks[0]
                raw_frames.append([[r4(p.x), r4(p.y), r4(p.z)] for p in lms])

                if result.facial_transformation_matrixes:
                    mat = result.facial_transformation_matrixes[0]
                    matrices.append([r4(v) for v in np.asarray(mat).flatten().tolist()])
                else:
                    matrices.append(None)

                if result.face_blendshapes:
                    bs = result.face_blendshapes[0]
                    blendshapes.append([{'c': c.category_name, 's': r4(c.score)} for c in bs])
                else:
                    blendshapes.append(None)
                detected += 1
            else:
                raw_frames.append(None)
                matrices.append(None)
                blendshapes.append(None)

            frame_idx += 1

    finally:
        landmarker.close()
        cap.release()

    elapsed = time.time() - t0
    print(f'[analyze] done: {detected}/{frame_idx} frames detected in {elapsed:.1f}s', flush=True)

    out = {
        'ts': int(time.time() * 1000),
        'videoFile': Path(video_path).name,
        'fps': round(fps, 2),
        'frameCount': frame_idx,
        'width': width,
        'height': height,
        'detectedCount': detected,
        'elapsedSec': round(elapsed, 2),
        'rawFrames': raw_frames,
        'matrices': matrices,
        'blendshapes': blendshapes,
    }
    Path(output_path).write_text(json.dumps(out, ensure_ascii=False))
    print(f'[analyze] wrote {output_path} ({os.path.getsize(output_path)/1024:.0f} KB)', flush=True)
    return out


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('usage: vps_analyze_video.py <video_path> [output_json]', file=sys.stderr)
        sys.exit(1)
    vid = sys.argv[1]
    if len(sys.argv) >= 3:
        out = sys.argv[2]
    else:
        stem = Path(vid).stem  # video-{ts}
        ts = stem.replace('video-', '')
        out = str(Path(vid).parent / f'analysis-{ts}.json')
    analyze(vid, out)
