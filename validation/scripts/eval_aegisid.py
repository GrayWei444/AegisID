#!/usr/bin/env python3
"""
AegisID Phase 4/5 驗證器
========================
輸入: 一個資料夾,內含多人多次拍攝的 face_id_hash 紀錄
輸出: 同一人 hash 一致率 (intra-user) + 跨人 hash 碰撞率 (inter-user)

預期資料格式 (JSON Lines, 每行一筆):
  {"user_id": "gray", "capture_id": "001", "hash": "abc123...", "pin_hash": "...", "timestamp": "..."}

或 CSV:
  user_id,capture_id,hash,pin_hash,timestamp
  gray,001,abc123...,xyz...,2026-05-15T10:00:00Z

用法:
  python3 eval_aegisid.py --captures /opt/aegis-data/validation/aegisid/self_capture/captures.jsonl \
                          --out /opt/aegis-data/validation/reports/aegisid_phase4_$(date +%Y%m%d).json

Phase 4 (自驗): 只給單一 user_id 的資料 → 算 intra-user consistency
Phase 5 (跨人): 給多個 user_id → 算 intra + inter, 確認不同人 hash 不碰撞
"""
import argparse
import csv
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path


def load_captures(path: str):
    """支援 JSONL 或 CSV 自動偵測"""
    p = Path(path)
    captures = []
    if p.suffix == ".jsonl":
        with open(p, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                captures.append(json.loads(line))
    elif p.suffix == ".csv":
        with open(p, encoding="utf-8") as f:
            for row in csv.DictReader(f):
                captures.append(row)
    else:
        print(f"[err] 不支援的格式: {p.suffix}", file=sys.stderr)
        sys.exit(1)
    return captures


def analyze_intra_user(captures):
    """
    同一人多次拍攝 → hash 一致率
    指標: exact_match_rate = (最常見 hash 的出現次數) / (該 user 總次數)
    """
    by_user = defaultdict(list)
    for c in captures:
        by_user[c["user_id"]].append(c["hash"])

    results = {}
    for user, hashes in by_user.items():
        counter = Counter(hashes)
        most_common_hash, most_common_count = counter.most_common(1)[0]
        results[user] = {
            "total_captures": len(hashes),
            "unique_hashes": len(counter),
            "most_common_hash": most_common_hash[:16] + "...",
            "exact_match_rate": round(most_common_count / len(hashes), 4),
            "hash_distribution": {h[:16] + "...": cnt for h, cnt in counter.most_common(5)},
        }
    return results


def analyze_inter_user(captures):
    """
    跨人 hash 碰撞: 不同 user_id 是否產出相同 hash
    """
    by_hash = defaultdict(set)
    for c in captures:
        by_hash[c["hash"]].add(c["user_id"])

    collisions = []
    for h, users in by_hash.items():
        if len(users) > 1:
            collisions.append({
                "hash": h[:16] + "...",
                "users": sorted(users),
                "user_count": len(users),
            })

    total_unique_hashes = len(by_hash)
    collision_count = len(collisions)
    return {
        "total_unique_hashes": total_unique_hashes,
        "collision_count": collision_count,
        "collision_rate": round(collision_count / max(1, total_unique_hashes), 4),
        "collisions": collisions[:10],  # 只列前 10 筆
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--captures", required=True, help="JSONL 或 CSV 資料")
    ap.add_argument("--phase", choices=["4", "5", "auto"], default="auto",
                    help="4=只算 intra-user, 5=intra+inter, auto=依資料判斷")
    ap.add_argument("--out", required=True, help="輸出 JSON 報告")
    args = ap.parse_args()

    print(f"[1/3] 載入 captures: {args.captures}", file=sys.stderr)
    captures = load_captures(args.captures)
    user_ids = set(c["user_id"] for c in captures)
    print(f"      共 {len(captures)} 筆, {len(user_ids)} 個 user_id", file=sys.stderr)

    phase = args.phase
    if phase == "auto":
        phase = "5" if len(user_ids) > 1 else "4"
    print(f"[2/3] 執行 Phase {phase} 分析", file=sys.stderr)

    report = {
        "version": "v0.1",
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "phase": phase,
        "total_captures": len(captures),
        "user_count": len(user_ids),
    }

    intra = analyze_intra_user(captures)
    report["intra_user_consistency"] = intra
    avg_match_rate = sum(r["exact_match_rate"] for r in intra.values()) / max(1, len(intra))
    report["avg_exact_match_rate"] = round(avg_match_rate, 4)

    if phase == "5":
        report["inter_user_collisions"] = analyze_inter_user(captures)

    print(f"[3/3] 寫入報告: {args.out}", file=sys.stderr)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print("", file=sys.stderr)
    print("=" * 60, file=sys.stderr)
    print(f"Phase {phase} 結果:", file=sys.stderr)
    print(f"  平均 hash 一致率 (intra-user): {avg_match_rate:.2%}", file=sys.stderr)
    if phase == "5":
        col = report["inter_user_collisions"]
        print(f"  跨人 hash 碰撞: {col['collision_count']}/{col['total_unique_hashes']} ({col['collision_rate']:.2%})", file=sys.stderr)
    print("=" * 60, file=sys.stderr)


if __name__ == "__main__":
    main()
