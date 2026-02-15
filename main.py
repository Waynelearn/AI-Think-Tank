import json
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from agents.registry import AgentRegistry
from discussion.engine import DiscussionEngine

app = FastAPI(title="AI Think Tank")

registry = AgentRegistry()
engine = DiscussionEngine(registry)

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def root():
    return FileResponse("static/index.html")


@app.get("/api/agents")
async def list_agents():
    return registry.list_agents()


@app.websocket("/ws/discuss")
async def discuss(websocket: WebSocket):
    await websocket.accept()
    try:
        data = await websocket.receive_text()
        payload = json.loads(data)
        topic = payload.get("topic", "")
        rounds = min(int(payload.get("rounds", 2)), 5)

        if not topic.strip():
            await websocket.send_text(json.dumps({"type": "error", "message": "Topic cannot be empty"}))
            await websocket.close()
            return

        await engine.run(topic, rounds, websocket)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_text(json.dumps({"type": "error", "message": str(e)}))
        except Exception:
            pass


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
