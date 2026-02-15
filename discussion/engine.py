import json
from fastapi import WebSocket
from agents.registry import AgentRegistry
from .models import Discussion, Message


class DiscussionEngine:
    def __init__(self, registry: AgentRegistry):
        self.registry = registry

    async def run(self, topic: str, rounds: int, websocket: WebSocket):
        """Orchestrate a multi-round discussion, streaming results via WebSocket."""
        discussion = Discussion(topic=topic, total_rounds=rounds)
        agents = self.registry.get_discussion_order()

        for round_num in range(1, rounds + 1):
            await self._send(websocket, {
                "type": "round_start",
                "round": round_num,
                "total_rounds": rounds,
            })

            for agent in agents:
                # Skip mediator in early rounds (only speaks in final round)
                if agent.name == "The Mediator" and round_num < rounds:
                    continue

                messages = self._build_messages(discussion, topic, round_num)

                await self._send(websocket, {
                    "type": "agent_start",
                    "agent": agent.name,
                    "color": agent.color,
                    "avatar": agent.avatar,
                    "round": round_num,
                })

                full_response = ""
                async for chunk in agent.stream_response(messages):
                    full_response += chunk
                    await self._send(websocket, {
                        "type": "agent_chunk",
                        "agent": agent.name,
                        "chunk": chunk,
                    })

                discussion.add_message(Message(
                    agent_name=agent.name,
                    content=full_response,
                    round_num=round_num,
                ))

                await self._send(websocket, {
                    "type": "agent_done",
                    "agent": agent.name,
                })

            await self._send(websocket, {
                "type": "round_end",
                "round": round_num,
            })

        await self._send(websocket, {"type": "discussion_end"})

    def _build_messages(self, discussion: Discussion, topic: str, current_round: int) -> list[dict]:
        """Build the message history for the Claude API call."""
        if current_round == 1:
            return [{"role": "user", "content": f"The discussion topic is: {topic}\n\nPlease share your perspective."}]

        transcript = discussion.get_transcript()
        return [
            {
                "role": "user",
                "content": (
                    f"The discussion topic is: {topic}\n\n"
                    f"Here is the discussion so far:\n{transcript}\n\n"
                    f"This is round {current_round}. Please respond to the other panelists' points, "
                    f"build on ideas you agree with, and challenge those you disagree with."
                ),
            }
        ]

    async def _send(self, websocket: WebSocket, data: dict):
        await websocket.send_text(json.dumps(data))
