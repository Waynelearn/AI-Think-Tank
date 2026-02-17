"""SQLite database layer for persistent sessions and usage receipts."""

import sqlite3
import json
import uuid
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).parent / "thinktank.db"

# Server-side pricing table (per million tokens)
PRICING = {
    "claude-sonnet-4-5-20250929": (3.0, 15.0),
    "claude-haiku-4-5-20251001": (0.80, 4.0),
    "gpt-4o": (2.50, 10.0),
    "gpt-4o-mini": (0.15, 0.60),
    "o3-mini": (1.10, 4.40),
    "deepseek-chat": (0.27, 1.10),
    "deepseek-reasoner": (0.55, 2.19),
    "gemini-2.0-flash": (0.10, 0.40),
    "gemini-2.5-pro-preview-06-05": (1.25, 10.0),
    "llama-3.3-70b-versatile": (0.59, 0.79),
    "mixtral-8x7b-32768": (0.24, 0.24),
}


def estimate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    input_price, output_price = PRICING.get(model, (3.0, 15.0))
    return (input_tokens * input_price + output_tokens * output_price) / 1_000_000


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    conn = _get_conn()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            topic TEXT NOT NULL,
            agent_keys TEXT NOT NULL DEFAULT '[]',
            provider TEXT DEFAULT '',
            model TEXT DEFAULT '',
            current_round INTEGER DEFAULT 1,
            discussion_state TEXT NOT NULL DEFAULT '{}',
            file_context TEXT DEFAULT '',
            status TEXT DEFAULT 'active',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chat_receipts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            agent_name TEXT NOT NULL,
            round_num INTEGER NOT NULL,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            estimated_cost REAL DEFAULT 0.0,
            provider TEXT DEFAULT '',
            model TEXT DEFAULT '',
            timestamp TEXT NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        );

        CREATE INDEX IF NOT EXISTS idx_receipts_session ON chat_receipts(session_id);
        CREATE INDEX IF NOT EXISTS idx_receipts_timestamp ON chat_receipts(timestamp);
        CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    """)
    conn.close()


def create_session(topic: str, agent_keys: list[str], provider: str,
                   model: str, discussion_state: dict) -> str:
    session_id = uuid.uuid4().hex
    now = datetime.now().isoformat()
    conn = _get_conn()
    conn.execute(
        """INSERT INTO sessions (id, topic, agent_keys, provider, model,
           discussion_state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (session_id, topic, json.dumps(agent_keys), provider, model,
         json.dumps(discussion_state), now, now),
    )
    conn.commit()
    conn.close()
    return session_id


def get_session(session_id: str) -> dict | None:
    conn = _get_conn()
    row = conn.execute(
        "SELECT * FROM sessions WHERE id = ? AND status = 'active'",
        (session_id,),
    ).fetchone()
    conn.close()
    if not row:
        return None
    return dict(row)


def update_session_state(session_id: str, discussion_state: dict, current_round: int):
    now = datetime.now().isoformat()
    conn = _get_conn()
    conn.execute(
        """UPDATE sessions SET discussion_state = ?, current_round = ?, updated_at = ?
           WHERE id = ?""",
        (json.dumps(discussion_state), current_round, now, session_id),
    )
    conn.commit()
    conn.close()


def end_session(session_id: str):
    now = datetime.now().isoformat()
    conn = _get_conn()
    conn.execute(
        """UPDATE sessions SET status = 'ended', discussion_state = '{}', updated_at = ?
           WHERE id = ?""",
        (now, session_id),
    )
    conn.commit()
    conn.close()


def log_receipt(session_id: str, agent_name: str, round_num: int,
                input_tokens: int, output_tokens: int, estimated_cost: float,
                provider: str, model: str):
    now = datetime.now().isoformat()
    conn = _get_conn()
    conn.execute(
        """INSERT INTO chat_receipts
           (session_id, agent_name, round_num, input_tokens, output_tokens,
            estimated_cost, provider, model, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (session_id, agent_name, round_num, input_tokens, output_tokens,
         estimated_cost, provider, model, now),
    )
    conn.commit()
    conn.close()


def get_usage_summary(start_date: str | None = None, end_date: str | None = None) -> dict:
    conn = _get_conn()

    date_filter = ""
    params: list = []
    if start_date:
        date_filter += " AND r.timestamp >= ?"
        params.append(start_date)
    if end_date:
        date_filter += " AND r.timestamp <= ?"
        params.append(end_date + "T23:59:59")

    # Totals
    row = conn.execute(f"""
        SELECT COUNT(DISTINCT r.session_id) as total_sessions,
               COALESCE(SUM(r.input_tokens), 0) as total_input_tokens,
               COALESCE(SUM(r.output_tokens), 0) as total_output_tokens,
               COALESCE(SUM(r.estimated_cost), 0) as total_estimated_cost
        FROM chat_receipts r
        WHERE 1=1 {date_filter}
    """, params).fetchone()
    totals = dict(row)

    # By provider/model
    by_provider = conn.execute(f"""
        SELECT r.provider, r.model,
               COUNT(DISTINCT r.session_id) as sessions,
               SUM(r.input_tokens) as input_tokens,
               SUM(r.output_tokens) as output_tokens,
               SUM(r.estimated_cost) as cost
        FROM chat_receipts r
        WHERE 1=1 {date_filter}
        GROUP BY r.provider, r.model
        ORDER BY cost DESC
    """, params).fetchall()

    # Recent sessions
    session_filter = ""
    session_params: list = []
    if start_date:
        session_filter += " AND s.created_at >= ?"
        session_params.append(start_date)
    if end_date:
        session_filter += " AND s.created_at <= ?"
        session_params.append(end_date + "T23:59:59")

    recent = conn.execute(f"""
        SELECT s.id, s.topic, s.provider, s.model, s.status, s.created_at,
               COALESCE(SUM(r.input_tokens), 0) as input_tokens,
               COALESCE(SUM(r.output_tokens), 0) as output_tokens,
               COALESCE(SUM(r.estimated_cost), 0) as total_cost
        FROM sessions s
        LEFT JOIN chat_receipts r ON r.session_id = s.id
        WHERE 1=1 {session_filter}
        GROUP BY s.id
        ORDER BY s.created_at DESC
        LIMIT 50
    """, session_params).fetchall()

    conn.close()

    return {
        **totals,
        "by_provider": [dict(r) for r in by_provider],
        "recent_sessions": [dict(r) for r in recent],
    }
