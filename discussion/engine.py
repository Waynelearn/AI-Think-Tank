import json
import asyncio
from fastapi import WebSocket
from agents.registry import AgentRegistry
from agents.providers import Usage
from .models import Discussion, Message
from database import log_receipt, update_session_state, end_session, estimate_cost


class DiscussionEngine:
    """Command-driven discussion engine. Processes one agent at a time on request."""

    def __init__(self, registry: AgentRegistry):
        self.registry = registry

    async def run_session(self, websocket: WebSocket, topic: str,
                          agent_keys: list[str] | None = None,
                          file_context: str = "",
                          prior_discussion: Discussion | None = None,
                          api_keys: dict | None = None,
                          session_id: str = ""):
        """Run an interactive session, processing commands from the frontend."""

        if prior_discussion:
            discussion = prior_discussion
            round_num = max((m.round_num for m in discussion.messages), default=0)
        else:
            discussion = Discussion(
                topic=topic, file_context=file_context,
                agent_keys=agent_keys or [],
            )
            round_num = 1
            await self._send(websocket, {
                "type": "round_start",
                "round": round_num,
            })

        # Send initial ready signal
        await self._send(websocket, {
            "type": "ready",
            "round": round_num,
        })

        # Command loop — frontend drives the flow
        while True:
            raw = await websocket.receive_text()
            cmd = json.loads(raw)
            action = cmd.get("action", "")

            if action == "ping":
                await self._send(websocket, {"type": "pong"})

            elif action == "run_agent":
                agent_key = cmd.get("agent_key", "")
                agent = self.registry.get_agent(agent_key) if agent_key in self.registry.agents else None
                if not agent:
                    await self._send(websocket, {"type": "error", "message": f"Unknown agent: {agent_key}"})
                    await self._send(websocket, {"type": "ready", "round": round_num})
                    continue

                await self._run_single_agent(websocket, agent, discussion, topic,
                                             round_num, file_context, api_keys, session_id)
                await self._send(websocket, {"type": "ready", "round": round_num})

            elif action == "run_batch":
                keys = cmd.get("agent_keys", [])
                for key in keys:
                    agent = self.registry.get_agent(key) if key in self.registry.agents else None
                    if agent:
                        await self._run_single_agent(websocket, agent, discussion, topic,
                                                     round_num, file_context, api_keys, session_id)
                await self._send(websocket, {"type": "ready", "round": round_num})

            elif action == "user_message":
                content = cmd.get("message", "").strip()
                if content:
                    discussion.add_message(Message(
                        agent_name="user",
                        content=content,
                        round_num=round_num,
                    ))
                    await self._send(websocket, {
                        "type": "user_message",
                        "content": content,
                        "round": round_num,
                    })
                    if session_id:
                        update_session_state(session_id, discussion.export(), round_num)
                await self._send(websocket, {"type": "ready", "round": round_num})

            elif action == "new_round":
                round_num += 1
                await self._send(websocket, {
                    "type": "round_start",
                    "round": round_num,
                })
                if session_id:
                    update_session_state(session_id, discussion.export(), round_num)
                await self._send(websocket, {"type": "ready", "round": round_num})

            elif action == "end":
                if session_id:
                    end_session(session_id)
                await self._send(websocket, {
                    "type": "discussion_end",
                    "export": discussion.export(),
                })
                break

            elif action == "get_export":
                await self._send(websocket, {
                    "type": "export_data",
                    "export": discussion.export(),
                })

            else:
                await self._send(websocket, {"type": "error", "message": f"Unknown action: {action}"})
                await self._send(websocket, {"type": "ready", "round": round_num})

    async def _run_single_agent(self, websocket: WebSocket, agent, discussion: Discussion,
                                 topic: str, round_num: int, file_context: str,
                                 api_keys: dict | None = None, session_id: str = ""):
        """Stream a single agent's response."""
        word_limit = int((api_keys or {}).get("word_limit", 0))
        messages = self._build_messages(discussion, topic, round_num, file_context, word_limit=word_limit)

        await self._send(websocket, {
            "type": "agent_start",
            "agent": agent.name,
            "color": agent.color,
            "avatar": agent.avatar,
            "round": round_num,
        })

        full_response = ""
        usage = Usage()
        async for item in agent.stream_response(messages, api_keys=api_keys):
            if isinstance(item, Usage):
                usage = item
            else:
                full_response += item
                await self._send(websocket, {
                    "type": "agent_chunk",
                    "agent": agent.name,
                    "chunk": item,
                })
                await self._drain_user_messages(websocket, discussion, round_num)

        discussion.add_message(Message(
            agent_name=agent.name,
            content=full_response,
            round_num=round_num,
        ))

        await self._send(websocket, {
            "type": "agent_done",
            "agent": agent.name,
            "usage": usage.to_dict(),
        })

        # Persist receipt and session state
        if session_id:
            model = (api_keys or {}).get("model", "")
            cost = estimate_cost(model, usage.input_tokens, usage.output_tokens)
            log_receipt(
                session_id=session_id,
                agent_name=agent.name,
                round_num=round_num,
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
                estimated_cost=cost,
                provider=(api_keys or {}).get("provider", ""),
                model=model,
            )
            update_session_state(session_id, discussion.export(), round_num)

    async def _drain_user_messages(self, websocket: WebSocket, discussion: Discussion, round_num: int):
        """Non-blocking check for user messages while an agent is streaming."""
        while True:
            try:
                raw = await asyncio.wait_for(websocket.receive_text(), timeout=0.01)
            except asyncio.TimeoutError:
                return
            except Exception:
                return

            try:
                cmd = json.loads(raw)
            except json.JSONDecodeError:
                continue

            if cmd.get("action") == "ping":
                await self._send(websocket, {"type": "pong"})
                continue

            if cmd.get("action") != "user_message":
                continue

            content = cmd.get("message", "").strip()
            if not content:
                continue

            discussion.add_message(Message(
                agent_name="user",
                content=content,
                round_num=round_num,
            ))
            await self._send(websocket, {
                "type": "user_message",
                "content": content,
                "round": round_num,
            })

    def _build_messages(self, discussion: Discussion, topic: str,
                        current_round: int, file_context: str = "",
                        word_limit: int = 0) -> list[dict]:
        """Build the message history for the Claude API call."""
        file_section = ""
        if file_context:
            file_section = (
                f"\n\nThe user has provided the following reference materials:\n"
                f"---\n{file_context}\n---\n"
                f"Use these materials as context for your analysis. Cite specific data when relevant."
            )

        word_limit_instruction = ""
        if word_limit and word_limit > 0:
            word_limit_instruction = (
                f"\n\nIMPORTANT: Keep your response under {word_limit} words. Be concise and focused."
            )

        if not discussion.messages:
            return [{
                "role": "user",
                "content": (
                    f"The discussion topic is: {topic}{file_section}\n\n"
                    f"Please share your perspective. If you need current data or sources, "
                    f"use the web_search tool to find evidence and include links in your response."
                    f"{word_limit_instruction}"
                ),
            }]

        last_user_message = next(
            (m.content for m in reversed(discussion.messages) if m.agent_name == "user"),
            "",
        )
        user_instruction = ""
        if last_user_message:
            user_instruction = (
                "\n\nMost recent user instruction (follow this FIRST and strictly):\n"
                f"{last_user_message}\n"
                "If the user requests a specific format, comply exactly. "
                "If the user asks for an image or mentions needing an image/photo/diagram from online sources, "
                "you MUST call the image_search tool and include the image using markdown: ![description](image_url)."
            )

        transcript = discussion.get_transcript()
        return [{
            "role": "user",
            "content": (
                f"The discussion topic is: {topic}{file_section}\n\n"
                f"Here is the discussion so far:\n{transcript}\n\n"
                f"{user_instruction}\n\n"
                f"This is round {current_round}. Respond to the other panelists' points, "
                f"build on ideas you agree with, and challenge those you disagree with. "
                f"If a user has interjected, address their input directly. "
                f"Use the web_search tool if you need current data or sources to back up your claims."
                f"{word_limit_instruction}"
            ),
        }]

    async def _send(self, websocket: WebSocket, data: dict):
        """Send data to the frontend, silently ignoring connection errors."""
        try:
            await websocket.send_text(json.dumps(data))
        except Exception:
            pass
