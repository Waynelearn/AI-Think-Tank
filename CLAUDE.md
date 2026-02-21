# AI Think Tank — Project Documentation

## Quick Start

```bash
# Environment
conda activate ai_think_tank
python main.py
# → http://localhost:8000

# Shell quirk (Windows): conda not on PATH in bash, use powershell:
powershell.exe -Command "conda activate ai_think_tank; python main.py"
```

**Port:** Default 8000. Check if occupied before starting.

---

## Project Overview

Multi-agent AI discussion platform where 20 AI personas debate topics across philosophy, finance, strategy, geopolitics, and more. Users select agents, enter a topic, and control a queue-driven discussion via WebSocket. Two silent "observer" agents run behind the scenes for quality control and sentiment analysis.

**Stack:** FastAPI + WebSocket backend, vanilla JS frontend (no frameworks/libraries), SQLite persistence, Canvas 2D for charts.

---

## File Structure

```
├── main.py                    # FastAPI app, WebSocket handler, REST endpoints
├── config.py                  # Environment variables (API keys, defaults)
├── database.py                # SQLite layer: sessions, receipts, usage tracking
├── requirements.txt           # Python dependencies
├── .env / .env.example        # API keys (never commit .env)
├── thinktank.db               # SQLite database (gitignored)
│
├── agents/
│   ├── base.py                # Agent class: stream_response(), tool handling
│   ├── personas.py            # 22 persona definitions (20 regular + 2 observers)
│   ├── providers.py           # LLM abstraction: Anthropic, OpenAI, DeepSeek, Gemini, Groq
│   └── registry.py            # AgentRegistry: loads personas, excludes observers from public API
│
├── discussion/
│   ├── engine.py              # DiscussionEngine: command loop, sentiment, curator
│   ├── models.py              # Discussion + Message dataclasses
│   ├── files.py               # File upload processing (CSV, PDF, Excel, images, etc.)
│   └── search.py              # Brave Search + Image Search tool definitions
│
└── static/
    ├── index.html             # Single-page app (main UI)
    ├── app.js                 # All frontend logic (~2025 lines)
    ├── style.css              # Component styles (~1230 lines)
    ├── theme.css              # CSS custom properties for dark/light themes
    ├── utils.js               # Shared helpers: escapeHtml(), formatTokens(), formatDate()
    ├── help.html              # Help/guide page (self-contained)
    └── admin.html             # Usage dashboard (self-contained)
```

---

## Architecture

### Backend Flow

1. User opens `/` → serves `index.html`
2. Frontend fetches `/api/agents` and `/api/providers` on load
3. User clicks Start → WebSocket connects to `/ws/discuss`
4. First WS message: `{topic, agents, api_keys, client_id, ...}`
5. Backend creates a session in SQLite, sends `session_created`
6. **Command loop**: Frontend sends actions, backend processes one at a time:
   - `run_agent` → stream agent response → `agent_start` / `agent_chunk` / `agent_done` → curator check → `ready`
   - `user_message` → echoed back → `ready`
   - `new_round` → sentiment analysis → `round_start` → `ready`
   - `end` → sentiment analysis → `discussion_end` (closes session)
   - `ping` → `pong` (heartbeat)
   - `get_export` → `export_data`

### Frontend Flow

- All state is in module-level variables (no framework)
- Queue-driven: user controls execution order via drag-and-drop queue panel
- Agent chips (top bar) toggle selection; queue is rebuilt on selection change
- Messages streamed chunk-by-chunk via `appendChunk()`, rendered as markdown on `agent_done`
- Auto-scroll only if user is near bottom (`isNearBottom()` — 150px threshold)
- Session persistence: `client_id` (UUID) in localStorage, session state in SQLite

### Provider Abstraction

Two provider classes in `providers.py`:
- `AnthropicProvider` — native Anthropic API (Claude models)
- `OpenAICompatibleProvider` — OpenAI, DeepSeek, Gemini, Groq (all use OpenAI-compatible API format)

Both normalize to `LLMResponse` with `text`, `tool_calls`, `stop_reason`, `usage`.

Tool support: `web_search` and `image_search` via Brave Search API (optional, requires Brave API key).

---

## Personas (22 total)

### 20 Discussion Agents

| Key | Name | Specialty | Avatar |
|-----|------|-----------|--------|
| `dr_nova` | Dr. Nova | Science & Technology | 🔬 |
| `philosopher_phil` | Philosopher Phil | Philosophy & Ethics | 🏛️ |
| `biz` | Biz | Business Strategy | 📊 |
| `creatia` | Creatia | Creativity & Arts | 🎨 |
| `devils_advocate` | Devil's Advocate | Critical Analysis | 😈 |
| `the_mediator` | The Mediator | Synthesis & Consensus | ⚖️ |
| `risk_taker` | Rex Risk | High-Risk Strategy | 🔥 |
| `yolo_trader` | YOLO Max | Speculative Trading | 🚀 |
| `stock_analyst` | Samantha Street | Equity Research | 📈 |
| `economist` | Dr. Macro | Macroeconomics | 🌍 |
| `systems_engineer` | Systems Sage | Systems Design | ⚙️ |
| `behavioral_psychologist` | Dr. Bias | Behavioral Psychology | 🧠 |
| `long_term_allocator` | Capital Steward | Capital Allocation | 🏦 |
| `geopolitical_strategist` | Atlas | Geopolitics | 🛰️ |
| `comfortable_complicit` | The Complicit | Status Quo Defense | 🛋️ |
| `operational_realist` | The Operator | Transactional Pragmatism | 🧮 |
| `lucid_cynic` | The Cynic | Existential Critique | 🌑 |
| `sovereign_agent` | The Sovereign | Amoral Optimization | ♟️ |
| `pragmatic_defector` | The Defector | Conditional Nihilism | 🎲 |
| `the_judge` | The Judge | Discussion Quality & Productivity | 🧑‍⚖️ |

### 2 Observer Agents (hidden from UI, silent)

| Key | Name | Role |
|-----|------|------|
| `sentiment_analyst` | Sentiment Analyst | Identifies 2 opposing viewpoints, scores each panelist -1 to +1 |
| `the_curator` | The Curator | Detects incomplete/truncated agent responses, re-queues them |

### Persona System

- All discussion agents share `_COMPETITIVE_SUFFIX` — a directive that enforces disagreement, prevents groupthink, and keeps debates competitive
- The Mediator has a **custom prompt** (no competitive suffix) — synthesizes but doesn't paper over disagreements
- The Judge has a **custom prompt** — evaluates discussion quality, issues verdicts (APPROVED/NEEDS WORK/REJECTED)
- Observer agents: `"observer": True` flag in persona definition → excluded from `list_agents()` and `get_discussion_order()`

---

## Key Features

### Queue System
- Frontend-driven execution: user controls who speaks and when
- Drag-and-drop reordering
- The Mediator always pinned second-to-last; The Judge pinned last
- Shuffle randomizes non-pinned agents (Fisher-Yates)
- User prompts can be queued alongside agents (select "Your Prompt" from dropdown)
- Auto-play mode: processes queue items sequentially until empty or paused

### Sentiment Analysis
- **Trigger:** Runs once per round when "New Round" or "End" is clicked
- **Process:** Silent LLM call to Sentiment Analyst, returns JSON `{viewpoints, scores}`
- **UI — Spectrum Strip:** Horizontal bar with colored dots positioned by score (-1 to +1), hover tooltips
- **UI — Time-Series Chart:** Canvas 2D line chart, HiDPI-aware, theme-aware, shows agent movement across rounds
- Click strip to expand/collapse chart
- Designed for future 3+ viewpoint support (radar chart when scores become arrays)

### The Curator (Incomplete Response Detection)
- Runs after every `agent_done` event
- Silent LLM call checks if response was truncated
- If incomplete: sends `curator_requeue` event → frontend shows notice and re-queues agent at front
- Also has client-side `handleIncompleteResponse()` for WebSocket disconnections

### Theme System
- Dark (default) and light themes via `data-theme` attribute on `<html>`
- CSS custom properties in `theme.css` for all colors
- Persisted in localStorage (`thinktank_theme`)
- Chart redraws on theme toggle

### Font Scaling
- A+/A- buttons control `--font-size-chat` CSS variable (px-based: 12, 13, 14, 15, 16, 18, 20)
- Only affects chat content, not UI chrome
- Persisted in localStorage (`thinktank_font_size_idx`)

### File Attachments
- Upload endpoint `/api/upload` processes files into text context
- Supported: CSV, Excel, PDF, HTML, text, Markdown, JSON, Python, JS, TS, Word, images, video
- Text extracted and passed to agents as `file_context`

### Session Persistence
- Each browser gets a UUID `client_id` (localStorage)
- Sessions stored in SQLite with full discussion state
- Session limit: 10 per client
- History panel shows recent chats with resume/delete
- Local message cache in localStorage for fast reload

### Admin Dashboard
- `/admin` — self-contained HTML page
- Shows usage by provider/model, cost estimates, session list
- Date range filtering

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Serve main app |
| GET | `/help` | Help page |
| GET | `/admin` | Admin dashboard |
| GET | `/api/agents` | List non-observer agents |
| GET | `/api/providers` | List available LLM providers |
| GET | `/api/sessions?client_id=X` | List sessions for client |
| GET | `/api/sessions/{id}` | Get session details |
| DELETE | `/api/sessions/{id}` | Delete session |
| GET | `/api/admin/usage` | Usage summary (optional date filters) |
| POST | `/api/upload` | Upload files, returns extracted text |
| WS | `/ws/discuss` | WebSocket discussion session |

---

## WebSocket Protocol

### Client → Server (actions)

```json
{"action": "run_agent", "agent_key": "dr_nova"}
{"action": "run_batch", "agent_keys": ["dr_nova", "biz"]}
{"action": "user_message", "message": "What about X?"}
{"action": "new_round"}
{"action": "end"}
{"action": "ping"}
{"action": "get_export"}
```

### Server → Client (events)

```json
{"type": "session_created", "session_id": "..."}
{"type": "ready", "round": 1}
{"type": "round_start", "round": 2}
{"type": "agent_start", "agent": "Dr. Nova", "color": "#4A90D9", "avatar": "🔬", "round": 1, "agent_key": "dr_nova"}
{"type": "agent_chunk", "agent": "Dr. Nova", "chunk": "text..."}
{"type": "agent_done", "agent": "Dr. Nova", "usage": {"input_tokens": 500, "output_tokens": 200}}
{"type": "user_message", "content": "...", "round": 1}
{"type": "sentiment_update", "round": 1, "data": {"viewpoints": [...], "scores": {...}}}
{"type": "curator_requeue", "agent_key": "dr_nova", "agent_name": "Dr. Nova", "last_topic": "..."}
{"type": "discussion_end", "export": {...}}
{"type": "export_data", "export": {...}}
{"type": "error", "message": "..."}
{"type": "pong"}
```

---

## Configuration

### Environment Variables (`.env`)

```
ANTHROPIC_API_KEY=sk-ant-...     # Server-side default (optional if users provide keys)
DEFAULT_PROVIDER=anthropic
DEFAULT_MODEL=claude-sonnet-4-5-20250929
BRAVE_API_KEY=BSA...             # For web/image search (optional)
BRAVE_SAFESEARCH=moderate
```

### config.py Constants

- `MAX_TOKENS = 1024` — max tokens per agent response

### Frontend Settings (localStorage)

- `thinktank_client_id` — browser UUID
- `thinktank_session_id` — current active session
- `thinktank_theme` — "dark" or "light"
- `thinktank_font_size_idx` — index into FONT_SIZES array
- `thinktank_provider` — selected provider key
- `thinktank_model_{provider}` — selected model per provider
- `thinktank_api_key_{provider}` — stored API key per provider
- `thinktank_api_key_brave` — Brave Search key
- `thinktank_word_limit` — per-agent word limit
- `thinktank_messages_{sessionId}` — cached messages for fast resume

---

## Development Notes

### Adding a New Persona

1. Add entry to `PERSONAS` dict in `agents/personas.py`
2. Use `_prompt("Your core description...")` to include the competitive suffix
3. Or write a custom `system_prompt` string for special roles (like Mediator, Judge)
4. Set `"observer": True` if the agent should be hidden from the UI

### Adding a New Provider

1. Add entry to `PROVIDERS` dict in `agents/providers.py` with `name`, `models`, `key_prefix`, `base_url`
2. Add pricing to `PRICING` dict in both `database.py` and `app.js`
3. If the provider uses OpenAI-compatible API, no code changes needed beyond the config

### Cache Busting

Static files use `?v=N` query params in `index.html`. Bump the version number when changing JS/CSS files to force browser cache refresh. Current version: `v=5`.

### CSS Architecture

- `theme.css` — CSS custom properties only (dark default, light override via `[data-theme="light"]`)
- `style.css` — all component styles, imports theme.css
- Uses `var(--token)` pattern throughout — never hardcode colors
- Mobile breakpoints: 700px (phone), 960px (tablet)

### Database

- SQLite with WAL mode for concurrent reads
- Two tables: `sessions` (discussion state) and `chat_receipts` (token usage)
- Migration-safe: `ALTER TABLE` wrapped in try/except for the `client_id` column addition
- Cost estimation uses server-side pricing table in `database.py`

---

## Known Issues & Gotchas

- **MAX_TOKENS = 1024** in `config.py` — this is relatively low and can cause agents to get cut off mid-response. The Curator observer exists specifically to detect and re-queue truncated responses, but increasing this value would reduce the problem. Consider raising to 2048+ for longer discussions.
- **Sentiment Analyst avatar collision** — uses 📊 which is the same as Biz's avatar. Not a functional issue but can be confusing in the sentiment strip tooltips.
- **`word_limit`** is an instruction to the LLM, not a hard enforcement — models may exceed it.
- **Stale cache** — when updating JS/CSS, always bump the `?v=N` parameter in `index.html`. Users may need to hard-refresh (Ctrl+Shift+R) if they see stale behavior.
- **Session limit** — 10 sessions per client. Users must delete old sessions to create new ones. This is enforced both on the frontend (pre-check) and implicitly by the history panel showing delete buttons.

---

## Git & Deployment

```bash
# Push to remote
git push origin main

# .gitignore excludes:
# .env, __pycache__/, .claude/, *.db
```

Dependencies: `pip install -r requirements.txt` (or `conda install` in the ai_think_tank env).
