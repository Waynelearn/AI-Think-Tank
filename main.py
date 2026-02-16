import json
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from agents.registry import AgentRegistry
from discussion.engine import DiscussionEngine
from discussion.models import Discussion
from discussion.files import process_file

app = FastAPI(title="AI Think Tank")

registry = AgentRegistry()
engine = DiscussionEngine(registry)

file_contexts: dict[str, str] = {}

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def root():
    return FileResponse("static/index.html")


@app.get("/help")
async def help_page():
    return FileResponse("static/help.html")


@app.get("/api/agents")
async def list_agents():
    return registry.list_agents()


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
    session_id = str(hash(combined))[:12]
    file_contexts[session_id] = combined
    return {"session_id": session_id, "filenames": filenames, "preview": combined[:500]}


@app.websocket("/ws/discuss")
async def discuss(websocket: WebSocket):
    await websocket.accept()
    try:
        # First message: session init
        data = await websocket.receive_text()
        payload = json.loads(data)
        topic = payload.get("topic", "")
        agent_keys = payload.get("agents", None)
        session_id = payload.get("session_id", "")
        prior_export = payload.get("prior_discussion", None)
        api_keys = payload.get("api_keys", {})

        if not topic.strip():
            await websocket.send_text(json.dumps({"type": "error", "message": "Topic cannot be empty"}))
            await websocket.close()
            return

        file_context = file_contexts.get(session_id, "")
        prior_discussion = Discussion.from_export(prior_export) if prior_export else None

        # Hand off to command-driven session loop
        await engine.run_session(
            websocket, topic,
            agent_keys=agent_keys,
            file_context=file_context,
            prior_discussion=prior_discussion,
            api_keys=api_keys,
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
