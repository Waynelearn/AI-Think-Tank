import json
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from agents.registry import AgentRegistry
from agents.providers import get_providers_for_api
from discussion.engine import DiscussionEngine
from discussion.models import Discussion
from discussion.files import process_file
from database import (
    init_db, create_session, get_session, get_usage_summary,
    list_sessions, count_sessions, delete_session,
)

app = FastAPI(title="AI Think Tank")

registry = AgentRegistry()
engine = DiscussionEngine(registry)

file_contexts: dict[str, str] = {}

init_db()

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def root():
    return FileResponse("static/index.html")


@app.get("/help")
async def help_page():
    return FileResponse("static/help.html")


@app.get("/admin")
async def admin_page():
    return FileResponse("static/admin.html")


@app.get("/api/agents")
async def list_agents():
    return registry.list_agents()


@app.get("/api/providers")
async def list_providers():
    return get_providers_for_api()


@app.get("/api/sessions/{session_id}")
async def get_session_info(session_id: str):
    session = get_session(session_id)
    if not session:
        return {"error": "Session not found or ended"}
    return {
        "session_id": session["id"],
        "topic": session["topic"],
        "agent_keys": json.loads(session["agent_keys"]),
        "current_round": session["current_round"],
        "status": session["status"],
        "provider": session["provider"],
        "model": session["model"],
    }


@app.get("/api/sessions")
async def list_sessions_api(client_id: str = ""):
    sessions = list_sessions(client_id=client_id, limit=10)
    for s in sessions:
        s["agent_keys"] = json.loads(s["agent_keys"])
    return {"sessions": sessions, "count": count_sessions(client_id=client_id)}


@app.delete("/api/sessions/{session_id}")
async def delete_session_api(session_id: str):
    delete_session(session_id)
    return {"ok": True}


@app.get("/api/admin/usage")
async def admin_usage(start_date: str = None, end_date: str = None):
    return get_usage_summary(start_date, end_date)


@app.post("/api/upload")
async def upload_files(files: list[UploadFile] = File(...)):
    """Process uploaded files and return extracted text context."""
    parts = []
    filenames = []
    for f in files:
        content = await f.read()
        extracted = process_file(f.filename or "unknown", content)
        parts.append(extracted)
        filenames.append(f.filename)
    combined = "\n\n".join(parts)
    file_session_id = str(hash(combined))[:12]
    file_contexts[file_session_id] = combined
    return {"file_session_id": file_session_id, "filenames": filenames, "preview": combined[:500]}


@app.websocket("/ws/discuss")
async def discuss(websocket: WebSocket):
    await websocket.accept()
    try:
        # First message: session init
        data = await websocket.receive_text()
        payload = json.loads(data)
        topic = payload.get("topic", "")
        agent_keys = payload.get("agents", None)
        file_session_id = payload.get("file_session_id", "")
        session_id = payload.get("session_id", "")
        prior_export = payload.get("prior_discussion", None)
        api_keys = payload.get("api_keys", {})
        client_id = payload.get("client_id", "")
        viewpoints = payload.get("viewpoints", [])

        prior_discussion = None

        # Try to resume existing persistent session
        if session_id:
            session = get_session(session_id)
            if session and session["status"] == "active":
                discussion_state = json.loads(session["discussion_state"])
                prior_discussion = Discussion.from_export(discussion_state)
                topic = session["topic"]
                agent_keys = json.loads(session["agent_keys"])
            else:
                session_id = ""  # Session not found or ended, will create new

        if not topic.strip():
            await websocket.send_text(json.dumps({"type": "error", "message": "Topic cannot be empty"}))
            await websocket.close()
            return

        file_context = file_contexts.get(file_session_id, "")

        # Load from prior_export if provided (file load) and no persistent session
        if prior_export and not prior_discussion:
            prior_discussion = Discussion.from_export(prior_export)

        # Create new persistent session if none loaded
        if not session_id:
            discussion_for_db = Discussion(
                topic=topic,
                agent_keys=agent_keys or [],
                file_context=file_context,
            )
            session_id = create_session(
                topic=topic,
                agent_keys=agent_keys or [],
                provider=api_keys.get("provider", ""),
                model=api_keys.get("model", ""),
                discussion_state=discussion_for_db.export(),
                client_id=client_id,
            )

        # Tell frontend the session_id so it can persist it
        await websocket.send_text(json.dumps({
            "type": "session_created",
            "session_id": session_id,
        }))

        # Hand off to command-driven session loop
        await engine.run_session(
            websocket, topic,
            agent_keys=agent_keys,
            file_context=file_context,
            prior_discussion=prior_discussion,
            api_keys=api_keys,
            session_id=session_id,
            viewpoints=viewpoints,
        )
    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_text(json.dumps({"type": "error", "message": str(e)}))
        except Exception:
            pass
    finally:
        if websocket.client_state.name != "DISCONNECTED":
            await websocket.close()


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
