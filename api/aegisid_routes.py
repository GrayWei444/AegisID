"""
AegisID API Routes

身份認證、同源偵測、身份錨點相關的 API 端點。
從 AegisTalk api/main.py 遷移而來，作為獨立模組供任何 FastAPI 應用引入。

使用方式：
    from aegisid_routes import create_aegisid_router
    router = create_aegisid_router(get_db, get_real_client_ip, verify_internal_token, api_secret)
    app.include_router(router)
"""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from typing import Optional, List
import sqlite3
import hashlib
import hmac
import time
import uuid
from contextlib import contextmanager
from collections.abc import Callable, Generator


# ============================================
# Pydantic Models
# ============================================

class FingerprintCheckRequest(BaseModel):
    """註冊時的指紋檢查請求"""
    user_pubkey: str = Field(..., min_length=1, max_length=500)
    canvas_hash: Optional[str] = None
    webgl_hash: Optional[str] = None
    network_hash: Optional[str] = None
    pin_behavior_hash: Optional[str] = None


class FingerprintCheckResponse(BaseModel):
    """指紋檢查回應"""
    risk_level: str  # 'low' | 'medium' | 'high' | 'blocked'
    risk_score: float
    reasons: List[str]
    allowed: bool


class SameSourceCheckRequest(BaseModel):
    """同源偵測請求（純 IP 檢查）"""
    user_pubkey: str = Field(..., min_length=1, max_length=500)


class SameSourceCheckResponse(BaseModel):
    """同源偵測回應"""
    risk_level: str  # 'low' | 'medium' | 'high' | 'blocked'
    risk_score: float
    reasons: List[str]
    allowed: bool
    recent_registrations: int  # 同 IP 24hr 內註冊數


class AegisIdRegisterRequest(BaseModel):
    """註冊身份錨點"""
    face_lsh_hash: str = Field(..., min_length=16, max_length=64)
    behavior_lsh_hash: str = Field(..., min_length=8, max_length=32)
    encrypted_blob: str = Field(..., min_length=1)
    blob_salt: str = Field(..., min_length=1)
    blob_iv: str = Field(..., min_length=1)


class AegisIdLookupRequest(BaseModel):
    """查找身份錨點"""
    face_lsh_hash: str = Field(..., min_length=16, max_length=64)
    behavior_lsh_hash: str = Field(default="", max_length=32)


# ============================================
# IP Hashing Helpers
# ============================================

def is_ipv6(ip: str) -> bool:
    """判斷是否為 IPv6 地址"""
    return ':' in ip


def hash_ip_segment(ip: str) -> str:
    """
    將 IP 地址雜湊化（網段層級 - 用於同源偵測）

    IPv4: 取 /24 網段
    例如: 192.168.1.123 -> SHA256("192.168.1")

    IPv6: 取 /64 前綴
    例如: 2001:db8:1234:5678:abcd:ef01:2345:6789 -> SHA256("2001:db8:1234:5678")
    """
    if is_ipv6(ip):
        # IPv6: 取前 4 組 (/64 前綴)
        parts = ip.split(':')
        # 處理 :: 縮寫
        if '' in parts:
            idx = parts.index('')
            missing = 8 - len([p for p in parts if p])
            parts = parts[:idx] + ['0'] * missing + parts[idx+1:]
        segment = ':'.join(parts[:4])  # /64 前綴
    else:
        # IPv4: 取前三段 (/24)
        parts = ip.split('.')
        if len(parts) == 4:
            segment = '.'.join(parts[:3])
        else:
            segment = ip
    return hashlib.sha256(segment.encode()).hexdigest()[:32]


def hash_ipv6_device(ip: str) -> str | None:
    """
    將 IPv6 完整地址雜湊化（用於同設備偵測）

    IPv6 的介面 ID（後 64 bits）通常與設備綁定
    完整 IPv6 地址可以作為設備識別

    Returns:
        IPv6 hash 或 None（如果是 IPv4）
    """
    if not is_ipv6(ip):
        return None

    # 展開 IPv6 地址
    parts = ip.split(':')
    if '' in parts:
        idx = parts.index('')
        missing = 8 - len([p for p in parts if p])
        parts = parts[:idx] + ['0'] * missing + parts[idx+1:]

    full_ip = ':'.join(parts)
    return hashlib.sha256(full_ip.encode()).hexdigest()[:32]


def _hex_hamming_similarity(h1: str, h2: str) -> float:
    """計算兩個 hex hash 的 LSH 相似度（基於 Hamming distance）"""
    if len(h1) != len(h2):
        return 0.0
    # 轉為二進位比較
    total_bits = 0
    same_bits = 0
    for c1, c2 in zip(h1, h2):
        v1, v2 = int(c1, 16), int(c2, 16)
        xor = v1 ^ v2
        diff_bits = bin(xor).count('1')
        total_bits += 4  # 每個 hex char = 4 bits
        same_bits += 4 - diff_bits
    return same_bits / total_bits if total_bits > 0 else 0.0


# ============================================
# Risk Evaluation Functions
# ============================================

def evaluate_registration_risk(
    conn: sqlite3.Connection,
    fingerprint: FingerprintCheckRequest,
    ip_hash: str,
    time_window_hours: int = 24
) -> tuple[float, str, list[str]]:
    """
    評估註冊風險 (v2 - 強化版)

    改進：
    1. 收緊 IP 閾值 (10+ 開始警告，而非 20+)
    2. 新增 1 小時短時間爆發偵測
    3. 提高 WebGL 權重 (5+ 開始計分)
    4. 新增 PIN 行為指紋偵測
    5. 組合指標偵測（多個指標同時異常加重）

    Returns:
        (risk_score, risk_level, reasons)
    """
    cursor = conn.cursor()
    now = int(time.time())
    cutoff_24h = now - (time_window_hours * 3600)
    cutoff_1h = now - 3600  # 1 小時內

    score = 0.0
    reasons = []
    anomaly_count = 0  # 計算異常指標數量

    # ============================================
    # 1. 同設備指紋 (Canvas Hash) - 最高權重
    # ============================================
    if fingerprint.canvas_hash:
        # 24 小時內
        cursor.execute("""
            SELECT COUNT(*) as cnt FROM registration_fingerprints
            WHERE canvas_hash = ? AND created_at > ?
        """, (fingerprint.canvas_hash, cutoff_24h))
        same_canvas_24h = cursor.fetchone()["cnt"]

        # 1 小時內
        cursor.execute("""
            SELECT COUNT(*) as cnt FROM registration_fingerprints
            WHERE canvas_hash = ? AND created_at > ?
        """, (fingerprint.canvas_hash, cutoff_1h))
        same_canvas_1h = cursor.fetchone()["cnt"]

        # 1 小時內快速建號（更嚴格）
        if same_canvas_1h >= 3:
            score += 70  # 1hr 內同設備 3+ 次：直接阻擋
            reasons.append(f"⚠️ 同設備 1hr 內已註冊 {same_canvas_1h} 次（快速批量建號）")
            anomaly_count += 2
        elif same_canvas_24h >= 5:
            score += 70  # 24hr 內 5+ 次：阻擋
            reasons.append(f"同設備 24hr 內已註冊 {same_canvas_24h} 次（批量建號）")
            anomaly_count += 2
        elif same_canvas_24h >= 3:
            score += 40  # 3-4 次：高風險
            reasons.append(f"同設備 24hr 內已註冊 {same_canvas_24h} 次")
            anomaly_count += 1
        elif same_canvas_24h >= 2:
            score += 20  # 2 次：可疑
            reasons.append(f"同設備 24hr 內已註冊 {same_canvas_24h} 次")
        # 1 次：不扣分，可能是重試

    # ============================================
    # 2. 同 IP 網段 - 收緊閾值
    # ============================================
    # 24 小時內
    cursor.execute("""
        SELECT COUNT(*) as cnt FROM registration_fingerprints
        WHERE ip_hash = ? AND created_at > ?
    """, (ip_hash, cutoff_24h))
    same_ip_24h = cursor.fetchone()["cnt"]

    # 1 小時內
    cursor.execute("""
        SELECT COUNT(*) as cnt FROM registration_fingerprints
        WHERE ip_hash = ? AND created_at > ?
    """, (ip_hash, cutoff_1h))
    same_ip_1h = cursor.fetchone()["cnt"]

    # 1 小時內快速建號
    if same_ip_1h >= 5:
        score += 50  # 1hr 內同 IP 5+ 次：高度可疑
        reasons.append(f"⚠️ 同 IP 1hr 內已註冊 {same_ip_1h} 個帳號（爆發式建號）")
        anomaly_count += 1
    elif same_ip_1h >= 3:
        score += 30  # 1hr 內同 IP 3-4 次：可疑
        reasons.append(f"同 IP 1hr 內已註冊 {same_ip_1h} 個帳號")

    # 24 小時內（收緊閾值）
    if same_ip_24h >= 15:
        score += 50  # 15+ 次：幾乎確定是批量（原本 20）
        reasons.append(f"同 IP 24hr 內已註冊 {same_ip_24h} 個帳號")
        anomaly_count += 1
    elif same_ip_24h >= 8:
        score += 30  # 8-14 次：可疑（原本 10）
        reasons.append(f"同 IP 24hr 內已註冊 {same_ip_24h} 個帳號")
    elif same_ip_24h >= 5:
        score += 15  # 5-7 次：輕微風險（新增）
        reasons.append(f"同 IP 24hr 內已註冊 {same_ip_24h} 個帳號")

    # ============================================
    # 3. 同 WebGL 指紋 - 提高權重
    # ============================================
    if fingerprint.webgl_hash:
        cursor.execute("""
            SELECT COUNT(*) as cnt FROM registration_fingerprints
            WHERE webgl_hash = ? AND created_at > ?
        """, (fingerprint.webgl_hash, cutoff_24h))
        same_webgl = cursor.fetchone()["cnt"]

        if same_webgl >= 8:
            score += 40  # 8+ 次：高風險
            reasons.append(f"同 GPU 特徵 24hr 內已註冊 {same_webgl} 次（模擬器特徵）")
            anomaly_count += 1
        elif same_webgl >= 5:
            score += 25  # 5-7 次：可疑
            reasons.append(f"同 GPU 特徵 24hr 內已註冊 {same_webgl} 次")
        elif same_webgl >= 3:
            score += 10  # 3-4 次：輕微
            reasons.append(f"同 GPU 特徵 24hr 內已註冊 {same_webgl} 次")

    # ============================================
    # 4. 同網路拓撲
    # ============================================
    if fingerprint.network_hash:
        cursor.execute("""
            SELECT COUNT(*) as cnt FROM registration_fingerprints
            WHERE network_hash = ? AND created_at > ?
        """, (fingerprint.network_hash, cutoff_24h))
        same_network = cursor.fetchone()["cnt"]

        if same_network >= 10:
            score += 20  # 10+ 次：可疑
            reasons.append(f"同網路環境 24hr 內已註冊 {same_network} 次")
        elif same_network >= 5:
            score += 10  # 5-9 次：輕微

    # ============================================
    # 5. PIN 行為指紋 - 新增
    # ============================================
    if fingerprint.pin_behavior_hash:
        cursor.execute("""
            SELECT COUNT(*) as cnt FROM registration_fingerprints
            WHERE pin_behavior_hash = ? AND created_at > ?
        """, (fingerprint.pin_behavior_hash, cutoff_24h))
        same_behavior = cursor.fetchone()["cnt"]

        if same_behavior >= 3:
            score += 50  # 相同行為指紋 3+ 次：高度可疑（可能是腳本）
            reasons.append(f"⚠️ 相同 PIN 行為模式 24hr 內已註冊 {same_behavior} 次（自動化腳本特徵）")
            anomaly_count += 1
        elif same_behavior >= 2:
            score += 25  # 2 次：可疑
            reasons.append(f"相同 PIN 行為模式 24hr 內已註冊 {same_behavior} 次")

    # ============================================
    # 6. 組合指標加權 - 多個異常指標同時出現
    # ============================================
    if anomaly_count >= 3:
        score += 30  # 3+ 個異常指標：額外加重
        reasons.append(f"多重異常指標 ({anomaly_count} 項)")
    elif anomaly_count >= 2:
        score += 15  # 2 個異常指標：輕微加重
        reasons.append(f"多重可疑指標 ({anomaly_count} 項)")

    # ============================================
    # 決定風險等級
    # ============================================
    if score >= 70:
        risk_level = "blocked"
    elif score >= 50:
        risk_level = "high"
    elif score >= 30:
        risk_level = "medium"
    else:
        risk_level = "low"

    return score, risk_level, reasons


def evaluate_same_source_risk(
    conn: sqlite3.Connection,
    ip_hash: str,
    ipv6_device_hash: str | None = None,
    time_window_hours: int = 24
) -> tuple[float, str, list[str], int, bool]:
    """
    評估同源風險（IP 檢查 + IPv6 同設備偵測）

    Returns:
        (risk_score, risk_level, reasons, recent_registrations, is_same_device)
    """
    cursor = conn.cursor()
    cutoff = int(time.time()) - (time_window_hours * 3600)

    score = 0.0
    reasons = []
    is_same_device = False

    # 1. 檢查同 IP 網段註冊數（同源偵測）
    cursor.execute("""
        SELECT COUNT(*) as cnt FROM registration_fingerprints
        WHERE ip_hash = ? AND created_at > ?
    """, (ip_hash, cutoff))
    same_ip = cursor.fetchone()["cnt"]

    if same_ip >= 20:
        score += 70  # 20+ 次：幾乎確定是批量
        reasons.append(f"同 IP 網段 24hr 內已註冊 {same_ip} 個帳號")
    elif same_ip >= 10:
        score += 50  # 10-19 次：可疑
        reasons.append(f"同 IP 網段 24hr 內已註冊 {same_ip} 個帳號")
    elif same_ip >= 5:
        score += 30  # 5-9 次：警告
        reasons.append(f"同 IP 網段 24hr 內已註冊 {same_ip} 個帳號")
    # 1-4 次：不扣分，可能是家庭/辦公室

    # 2. 檢查 IPv6 同設備（如果有 IPv6）
    if ipv6_device_hash:
        cursor.execute("""
            SELECT user_pubkey FROM registration_fingerprints
            WHERE ipv6_device_hash = ? AND created_at > ?
            LIMIT 1
        """, (ipv6_device_hash, cutoff))
        existing = cursor.fetchone()
        if existing:
            is_same_device = True
            score += 50  # 同設備重複註冊
            reasons.append(f"同設備 (IPv6) 已註冊帳號")

    # 決定風險等級
    if score >= 70:
        risk_level = "blocked"
    elif score >= 50:
        risk_level = "high"
    elif score >= 30:
        risk_level = "medium"
    else:
        risk_level = "low"

    return score, risk_level, reasons, same_ip, is_same_device


# ============================================
# DB Schema (Tables + Indexes)
# ============================================

def create_aegisid_tables(cursor: sqlite3.Cursor) -> None:
    """建立 AegisID 相關的資料表（在主應用初始化時呼叫）"""

    # 註冊指紋資料表（同源偵測）
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS registration_fingerprints (
            id TEXT PRIMARY KEY,
            user_pubkey TEXT NOT NULL,

            -- IP Hash
            ip_hash TEXT,
            ipv6_device_hash TEXT,
            ip_version INTEGER,

            -- 設備指紋 Hash
            canvas_hash TEXT,
            webgl_hash TEXT,
            network_hash TEXT,
            pin_behavior_hash TEXT,

            -- 風險評估
            risk_score REAL DEFAULT 0,
            risk_level TEXT DEFAULT 'low',

            -- 元資料
            created_at INTEGER NOT NULL,

            UNIQUE(user_pubkey)
        )
    """)

    # 資料庫遷移：添加新欄位（如果不存在）
    for col in ["ipv6_device_hash TEXT", "ip_version INTEGER"]:
        try:
            cursor.execute(f"ALTER TABLE registration_fingerprints ADD COLUMN {col}")
        except sqlite3.OperationalError:
            pass  # 欄位已存在

    # 建立索引加速查詢
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_fp_canvas ON registration_fingerprints(canvas_hash)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_fp_ipv6_device ON registration_fingerprints(ipv6_device_hash)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_fp_ip ON registration_fingerprints(ip_hash)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_fp_created ON registration_fingerprints(created_at)")

    # 身份錨點（跨裝置身份驗證）
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS identity_anchors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            face_lsh_hash TEXT NOT NULL,
            face_seg_0 TEXT,
            face_seg_1 TEXT,
            face_seg_2 TEXT,
            face_seg_3 TEXT,
            behavior_lsh_hash TEXT,
            encrypted_blob TEXT,
            blob_salt TEXT,
            blob_iv TEXT,
            created_at INTEGER DEFAULT (strftime('%s','now')),
            updated_at INTEGER DEFAULT (strftime('%s','now'))
        )
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_face_seg_0 ON identity_anchors(face_seg_0)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_face_seg_1 ON identity_anchors(face_seg_1)")

    # 註冊速率限制
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS registration_rate_limits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dimension TEXT NOT NULL,
            hmac_hash TEXT NOT NULL,
            created_at INTEGER DEFAULT (strftime('%s','now'))
        )
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_rate_dim_hash ON registration_rate_limits(dimension, hmac_hash)")


# ============================================
# Router Factory
# ============================================

def create_aegisid_router(
    get_db: Callable[[], Generator],
    get_real_client_ip: Callable[[Request], str],
    verify_internal_token: Callable[[Request], bool],
    api_secret: str,
) -> APIRouter:
    """
    建立 AegisID API Router

    Args:
        get_db: 資料庫連線 context manager
        get_real_client_ip: 取得客戶端 IP 的函式
        verify_internal_token: 驗證內部 token 的函式
        api_secret: HMAC 簽名密鑰（用於 rate limiting）
    """
    router = APIRouter()

    # ------------------------------------------
    # Fingerprint Check Endpoints
    # ------------------------------------------

    @router.post("/api/fingerprint/check", response_model=FingerprintCheckResponse)
    async def check_fingerprint(request: FingerprintCheckRequest, req: Request):
        """Phase 11: 同源偵測 - 檢查註冊指紋"""
        client_ip = get_real_client_ip(req)
        ip_hash = hash_ip_segment(client_ip)

        with get_db() as conn:
            score, risk_level, reasons = evaluate_registration_risk(
                conn, request, ip_hash
            )

            allowed = risk_level != "blocked"

            cursor = conn.cursor()
            cursor.execute("""
                INSERT OR REPLACE INTO registration_fingerprints
                (id, user_pubkey, canvas_hash, webgl_hash, ip_hash, network_hash,
                 pin_behavior_hash, risk_score, risk_level, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                str(uuid.uuid4()),
                request.user_pubkey,
                request.canvas_hash,
                request.webgl_hash,
                ip_hash,
                request.network_hash,
                request.pin_behavior_hash,
                score,
                risk_level,
                int(time.time())
            ))
            conn.commit()

            return FingerprintCheckResponse(
                risk_level=risk_level,
                risk_score=score,
                reasons=reasons if reasons else ["無異常"],
                allowed=allowed
            )

    @router.get("/api/fingerprint/stats")
    async def get_fingerprint_stats(req: Request):
        """取得同源偵測統計（管理用，需 internal token）"""
        if not verify_internal_token(req):
            raise HTTPException(status_code=403, detail="Unauthorized: admin endpoint")
        with get_db() as conn:
            cursor = conn.cursor()

            cursor.execute("SELECT COUNT(*) as total FROM registration_fingerprints")
            total = cursor.fetchone()["total"]

            cutoff_24h = int(time.time()) - (24 * 3600)
            cursor.execute("""
                SELECT COUNT(*) as cnt FROM registration_fingerprints
                WHERE created_at > ?
            """, (cutoff_24h,))
            last_24h = cursor.fetchone()["cnt"]

            cursor.execute("""
                SELECT risk_level, COUNT(*) as cnt
                FROM registration_fingerprints
                GROUP BY risk_level
            """)
            risk_distribution = {row["risk_level"]: row["cnt"] for row in cursor.fetchall()}

            cursor.execute("""
                SELECT COUNT(*) as cnt FROM registration_fingerprints
                WHERE risk_level = 'blocked' AND created_at > ?
            """, (cutoff_24h,))
            blocked_24h = cursor.fetchone()["cnt"]

            return {
                "total_registrations": total,
                "last_24h_registrations": last_24h,
                "blocked_24h": blocked_24h,
                "risk_distribution": risk_distribution
            }

    # ------------------------------------------
    # Same Source Check Endpoints
    # ------------------------------------------

    @router.post("/api/same-source/check", response_model=SameSourceCheckResponse)
    async def check_same_source(request: SameSourceCheckRequest, req: Request):
        """Phase 11: 同源偵測 - IP 檢查 + IPv6 同設備偵測"""
        client_ip = get_real_client_ip(req)

        ip_hash = hash_ip_segment(client_ip)
        ipv6_device_hash = hash_ipv6_device(client_ip)
        ip_version = 6 if is_ipv6(client_ip) else 4

        with get_db() as conn:
            score, risk_level, reasons, recent_registrations, _ = evaluate_same_source_risk(
                conn, ip_hash, ipv6_device_hash
            )

            allowed = risk_level != "blocked"

            cursor = conn.cursor()
            cursor.execute("""
                INSERT OR REPLACE INTO registration_fingerprints
                (id, user_pubkey, ip_hash, ipv6_device_hash, ip_version, risk_score, risk_level, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                str(uuid.uuid4()),
                request.user_pubkey,
                ip_hash,
                ipv6_device_hash,
                ip_version,
                score,
                risk_level,
                int(time.time())
            ))
            conn.commit()

            return SameSourceCheckResponse(
                risk_level=risk_level,
                risk_score=score,
                reasons=reasons if reasons else ["無異常"],
                allowed=allowed,
                recent_registrations=recent_registrations
            )

    @router.get("/api/same-source/stats")
    async def get_same_source_stats(req: Request):
        """取得同源偵測統計（管理用，需 internal token）"""
        if not verify_internal_token(req):
            raise HTTPException(status_code=403, detail="Unauthorized: admin endpoint")
        with get_db() as conn:
            cursor = conn.cursor()

            cursor.execute("SELECT COUNT(*) as total FROM registration_fingerprints")
            total = cursor.fetchone()["total"]

            cutoff_24h = int(time.time()) - (24 * 3600)
            cursor.execute("""
                SELECT COUNT(*) as cnt FROM registration_fingerprints
                WHERE created_at > ?
            """, (cutoff_24h,))
            last_24h = cursor.fetchone()["cnt"]

            cursor.execute("""
                SELECT COUNT(*) as cnt FROM registration_fingerprints
                WHERE risk_level = 'blocked' AND created_at > ?
            """, (cutoff_24h,))
            blocked_24h = cursor.fetchone()["cnt"]

            cursor.execute("""
                SELECT ip_hash, COUNT(*) as cnt
                FROM registration_fingerprints
                WHERE created_at > ?
                GROUP BY ip_hash
                ORDER BY cnt DESC
                LIMIT 10
            """, (cutoff_24h,))
            top_ip_segments = [
                {"ip_hash": row["ip_hash"][:16] + "...", "count": row["cnt"]}
                for row in cursor.fetchall()
            ]

            return {
                "total_registrations": total,
                "last_24h_registrations": last_24h,
                "blocked_24h": blocked_24h,
                "top_ip_segments": top_ip_segments
            }

    # ------------------------------------------
    # Identity Anchor Endpoints
    # ------------------------------------------

    @router.post("/aegisid/register")
    async def aegisid_register(req: Request, body: AegisIdRegisterRequest):
        """
        註冊身份錨點

        - 接收 face LSH hash + behavior LSH hash + 加密的身份包
        - Rate limiting: 同一 face/behavior 組合 48hr 內只能註冊一次
        - VPS 永遠不知道原始生物特徵，只儲存 LSH hash
        """
        client_ip = get_real_client_ip(req)
        now = int(time.time())
        ttl = 48 * 3600  # 48 小時

        with get_db() as conn:
            cursor = conn.cursor()

            # Rate limiting: 用 HMAC 匿名化 face+behavior 組合
            combo_raw = f"{body.face_lsh_hash}:{body.behavior_lsh_hash}"
            combo_hmac = hmac.new(
                api_secret.encode(), combo_raw.encode(), hashlib.sha256
            ).hexdigest()

            # 檢查 48hr 內是否已註冊
            cursor.execute("""
                SELECT COUNT(*) FROM registration_rate_limits
                WHERE dimension = 'combo' AND hmac_hash = ? AND created_at > ?
            """, (combo_hmac, now - ttl))
            if cursor.fetchone()[0] > 0:
                raise HTTPException(status_code=429, detail="Already registered recently")

            # IP rate limiting: 每 IP 24hr 最多 5 次
            ip_hmac = hmac.new(
                api_secret.encode(), client_ip.encode(), hashlib.sha256
            ).hexdigest()
            cursor.execute("""
                SELECT COUNT(*) FROM registration_rate_limits
                WHERE dimension = 'ip' AND hmac_hash = ? AND created_at > ?
            """, (ip_hmac, now - 24 * 3600))
            if cursor.fetchone()[0] >= 5:
                raise HTTPException(status_code=429, detail="Too many registrations from this IP")

            # 儲存身份錨點
            face_hash = body.face_lsh_hash
            seg_len = 8
            segs = [
                face_hash[i:i + seg_len] if i + seg_len <= len(face_hash) else None
                for i in range(0, seg_len * 4, seg_len)
            ]

            cursor.execute("""
                INSERT INTO identity_anchors
                (face_lsh_hash, face_seg_0, face_seg_1, face_seg_2, face_seg_3,
                 behavior_lsh_hash, encrypted_blob, blob_salt, blob_iv)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                face_hash,
                segs[0] if len(segs) > 0 else None,
                segs[1] if len(segs) > 1 else None,
                segs[2] if len(segs) > 2 else None,
                segs[3] if len(segs) > 3 else None,
                body.behavior_lsh_hash,
                body.encrypted_blob,
                body.blob_salt,
                body.blob_iv,
            ))

            anchor_id = cursor.lastrowid

            # 記錄 rate limit
            cursor.execute("""
                INSERT INTO registration_rate_limits (dimension, hmac_hash) VALUES ('combo', ?)
            """, (combo_hmac,))
            cursor.execute("""
                INSERT INTO registration_rate_limits (dimension, hmac_hash) VALUES ('ip', ?)
            """, (ip_hmac,))

            conn.commit()

        return {"success": True, "anchor_id": str(anchor_id)}

    @router.post("/aegisid/lookup")
    async def aegisid_lookup(body: AegisIdLookupRequest):
        """
        查找身份錨點

        - 用 face LSH hash 的前兩段做 bucket 篩選
        - 對候選結果計算完整的 Hamming similarity
        - 綜合分數 = 0.6 × face_sim + 0.4 × behavior_sim
        - confidence ≥ 0.80 才返回加密的身份包
        """
        face_hash = body.face_lsh_hash
        seg_len = 8
        seg_0 = face_hash[:seg_len] if len(face_hash) >= seg_len else None
        seg_1 = face_hash[seg_len:seg_len * 2] if len(face_hash) >= seg_len * 2 else None

        with get_db() as conn:
            cursor = conn.cursor()

            # Bucket 查找：至少一個 segment 匹配
            if seg_0 and seg_1:
                cursor.execute("""
                    SELECT id, face_lsh_hash, behavior_lsh_hash,
                           encrypted_blob, blob_salt, blob_iv
                    FROM identity_anchors
                    WHERE face_seg_0 = ? OR face_seg_1 = ?
                    ORDER BY updated_at DESC LIMIT 50
                """, (seg_0, seg_1))
            elif seg_0:
                cursor.execute("""
                    SELECT id, face_lsh_hash, behavior_lsh_hash,
                           encrypted_blob, blob_salt, blob_iv
                    FROM identity_anchors
                    WHERE face_seg_0 = ?
                    ORDER BY updated_at DESC LIMIT 50
                """, (seg_0,))
            else:
                return {"found": False, "confidence": 0.0}

            candidates = cursor.fetchall()

        if not candidates:
            return {"found": False, "confidence": 0.0}

        # 對每個候選計算相似度
        best_match = None
        best_score = 0.0

        for row in candidates:
            cand_face = row[1]
            cand_behavior = row[2]

            face_sim = _hex_hamming_similarity(face_hash, cand_face)

            # 行為相似度（如果提供了 behavior hash）
            behavior_sim = 0.5  # 預設中性
            if body.behavior_lsh_hash and cand_behavior:
                behavior_sim = _hex_hamming_similarity(
                    body.behavior_lsh_hash, cand_behavior
                )

            # 綜合分數
            score = 0.6 * face_sim + 0.4 * behavior_sim

            if score > best_score:
                best_score = score
                best_match = row

        # 只有 confidence ≥ 0.80 才返回加密包
        if best_match and best_score >= 0.80:
            return {
                "found": True,
                "confidence": round(best_score, 4),
                "encrypted_blob": best_match[3],
                "blob_salt": best_match[4],
                "blob_iv": best_match[5],
            }

        return {
            "found": False,
            "confidence": round(best_score, 4) if best_score > 0 else 0.0,
        }

    return router
