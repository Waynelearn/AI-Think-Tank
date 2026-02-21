import json
import asyncio
import logging
from fastapi import WebSocket
from agents.registry import AgentRegistry
from agents.providers import Usage
from .models import Discussion, Message
from database import log_receipt, update_session_state, end_session, estimate_cost

logger = logging.getLogger(__name__)


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
                continue_from = cmd.get("continue_from", "")
                agent = self.registry.get_agent(agent_key) if agent_key in self.registry.agents else None
                if not agent:
                    await self._send(websocket, {"type": "error", "message": f"Unknown agent: {agent_key}"})
                    await self._send(websocket, {"type": "ready", "round": round_num})
                    continue

                await self._run_single_agent(websocket, agent, discussion, topic,
                                             round_num, file_context, api_keys, session_id,
                                             continue_from=continue_from)

                # Run curator check on the agent's response
                await self._run_curator_check(
                    websocket, agent, discussion, topic,
                    round_num, file_context, api_keys, session_id
                )

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
                # Run sentiment analysis on the just-completed round
                await self._run_sentiment_analysis(
                    websocket, discussion, topic, round_num,
                    file_context, api_keys, session_id
                )
                round_num += 1
                await self._send(websocket, {
                    "type": "round_start",
                    "round": round_num,
                })
                if session_id:
                    update_session_state(session_id, discussion.export(), round_num)
                await self._send(websocket, {"type": "ready", "round": round_num})

            elif action == "end":
                # Run final sentiment analysis
                await self._run_sentiment_analysis(
                    websocket, discussion, topic, round_num,
                    file_context, api_keys, session_id
                )
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
                                 api_keys: dict | None = None, session_id: str = "",
                                 continue_from: str = ""):
        """Stream a single agent's response."""
        word_limit = int((api_keys or {}).get("word_limit", 0))
        tone = (api_keys or {}).get("tone", "")
        messages = self._build_messages(discussion, topic, round_num, file_context,
                                        word_limit=word_limit, tone=tone,
                                        continue_from=continue_from,
                                        continue_agent=agent.name if continue_from else "")

        await self._send(websocket, {
            "type": "agent_start",
            "agent": agent.name,
            "color": agent.color,
            "avatar": agent.avatar,
            "round": round_num,
            "agent_key": next((k for k, a in self.registry.agents.items() if a is agent), ""),
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

    # ── Curator: completeness check ──

    async def _run_curator_check(self, websocket: WebSocket, agent, discussion: Discussion,
                                  topic: str, round_num: int, file_context: str,
                                  api_keys: dict | None = None, session_id: str = ""):
        """Run The Curator silently to check if the last agent response was complete."""
        curator = self.registry.get_observer("the_curator")
        if not curator:
            return

        # Get the last message (should be the agent's response we just finished)
        if not discussion.messages:
            return
        last_msg = discussion.messages[-1]
        if last_msg.agent_name == "user":
            return

        messages = [{
            "role": "user",
            "content": (
                f"The following is {last_msg.agent_name}'s response in a discussion about: {topic}\n\n"
                f"---\n{last_msg.content}\n---\n\n"
                "Determine if this response is complete or was cut off. Output ONLY JSON."
            ),
        }]

        try:
            full_response = ""
            async for item in curator.stream_response(messages, api_keys=api_keys):
                if isinstance(item, Usage):
                    pass
                else:
                    full_response += item

            cleaned = self._clean_json_response(full_response)
            result = json.loads(cleaned)

            if not result.get("complete", True):
                last_topic = result.get("last_topic", "their previous point")
                agent_key = next((k for k, a in self.registry.agents.items() if a is agent), "")
                await self._send(websocket, {
                    "type": "curator_requeue",
                    "agent_key": agent_key,
                    "agent_name": agent.name,
                    "avatar": agent.avatar,
                    "color": agent.color,
                    "last_topic": last_topic,
                })
                logger.info(f"Curator flagged {agent.name} as incomplete: {last_topic}")

        except json.JSONDecodeError:
            logger.warning(f"Curator returned invalid JSON: {full_response[:200]}")
        except Exception as e:
            logger.warning(f"Curator check failed: {e}")

    # ── Sentiment Analysis ──

    async def _run_sentiment_analysis(self, websocket: WebSocket, discussion: Discussion,
                                       topic: str, round_num: int, file_context: str,
                                       api_keys: dict | None = None, session_id: str = ""):
        """Run the Sentiment Analyst silently and send sentiment_update event."""
        observer = self.registry.get_observer("sentiment_analyst")
        if not observer:
            return

        messages = self._build_sentiment_messages(discussion, topic, round_num)
        if not messages:
            return

        try:
            full_response = ""
            usage = Usage()
            async for item in observer.stream_response(messages, api_keys=api_keys):
                if isinstance(item, Usage):
                    usage = item
                else:
                    full_response += item

            cleaned = self._clean_json_response(full_response)
            sentiment_data = json.loads(cleaned)

            if "viewpoints" not in sentiment_data or "scores" not in sentiment_data:
                logger.warning("Sentiment analysis missing required fields")
                return

            await self._send(websocket, {
                "type": "sentiment_update",
                "round": round_num,
                "data": sentiment_data,
            })

            if session_id:
                model = (api_keys or {}).get("model", "")
                cost = estimate_cost(model, usage.input_tokens, usage.output_tokens)
                log_receipt(
                    session_id=session_id,
                    agent_name="[Sentiment Analyst]",
                    round_num=round_num,
                    input_tokens=usage.input_tokens,
                    output_tokens=usage.output_tokens,
                    estimated_cost=cost,
                    provider=(api_keys or {}).get("provider", ""),
                    model=model,
                )

        except json.JSONDecodeError:
            logger.warning(f"Sentiment analysis returned invalid JSON: {full_response[:200]}")
        except Exception as e:
            logger.warning(f"Sentiment analysis failed: {e}")

    def _build_sentiment_messages(self, discussion: Discussion, topic: str,
                                   target_round: int) -> list[dict]:
        """Build message for the Sentiment Analyst to analyze a specific round."""
        round_messages = [
            m for m in discussion.messages
            if m.round_num == target_round and m.agent_name != "user"
        ]
        if not round_messages:
            return []

        transcript_lines = [f"Topic: {topic}\n", f"--- Round {target_round} ---\n"]
        for msg in round_messages:
            transcript_lines.append(f"{msg.agent_name}: {msg.content}\n")

        return [{
            "role": "user",
            "content": (
                "Analyze the following round of discussion and produce your JSON output.\n\n"
                + "\n".join(transcript_lines)
            ),
        }]

    # ── Helpers ──

    def _clean_json_response(self, raw: str) -> str:
        """Strip markdown code fences and whitespace from an LLM JSON response."""
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[-1] if "\n" in cleaned else cleaned[3:]
        if cleaned.endswith("```"):
            cleaned = cleaned.rsplit("```", 1)[0]
        return cleaned.strip()

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

    TONE_INSTRUCTIONS = {
        "layman": (
            "TONE: Speak in plain, everyday language. No jargon, no technical terms, no acronyms. "
            "Explain things like you're talking to a smart friend who has no background in this field. "
            "Use short sentences, concrete examples, and analogies from daily life. "
            "If you must mention a technical concept, immediately explain it in simple words."
        ),
        "academic": (
            "TONE: Write in a formal, scholarly style. Use precise technical terminology and discipline-specific "
            "language. Structure your arguments rigorously with clear thesis statements, supporting evidence, "
            "and citations where applicable. Maintain an objective, analytical voice."
        ),
        "professional": (
            "TONE: Write in a crisp, business-professional style. Be direct and action-oriented. "
            "Use industry terms when helpful but keep language accessible to executives. "
            "Focus on implications, trade-offs, and actionable takeaways. No fluff."
        ),
        "debate": (
            "TONE: Be sharp, confrontational, and rhetorically aggressive. Challenge other panelists directly. "
            "Poke holes in their arguments. Use pointed questions and strong counter-examples. "
            "Don't soften your disagreements — be intellectually combative while staying substantive."
        ),
        "storyteller": (
            "TONE: Frame your points through stories, anecdotes, and vivid scenarios. "
            "Paint pictures with words. Use narrative structure — setup, tension, resolution. "
            "Make abstract ideas tangible through human-scale examples and compelling imagery."
        ),
        "socratic": (
            "TONE: Lead with probing questions rather than assertions. Challenge assumptions by asking 'why' "
            "and 'what if'. Guide the discussion through inquiry rather than declaration. "
            "After asking questions, offer your own tentative answers to move the conversation forward."
        ),
    }

    def _build_messages(self, discussion: Discussion, topic: str,
                        current_round: int, file_context: str = "",
                        word_limit: int = 0, tone: str = "",
                        continue_from: str = "",
                        continue_agent: str = "") -> list[dict]:
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

        tone_instruction = ""
        if tone and tone in self.TONE_INSTRUCTIONS:
            tone_instruction = f"\n\n{self.TONE_INSTRUCTIONS[tone]}"

        continuation_instruction = ""
        if continue_from and continue_agent:
            continuation_instruction = (
                f"\n\nCRITICAL — CONTINUATION MODE: Your previous response as {continue_agent} was "
                f"CUT OFF mid-thought. You were discussing: \"{continue_from}\". "
                f"Your truncated response is the last entry from {continue_agent} in the transcript above. "
                f"Do NOT repeat what you already said. Do NOT start over. "
                f"Pick up EXACTLY where you left off and finish your thought. "
                f"Begin your continuation seamlessly as if mid-paragraph."
            )

        if not discussion.messages:
            return [{
                "role": "user",
                "content": (
                    f"The discussion topic is: {topic}{file_section}\n\n"
                    f"Please share your perspective. If you need current data or sources, "
                    f"use the web_search tool to find evidence and include links in your response."
                    f"{tone_instruction}"
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

        if continuation_instruction:
            return [{
                "role": "user",
                "content": (
                    f"The discussion topic is: {topic}{file_section}\n\n"
                    f"Here is the discussion so far:\n{transcript}\n\n"
                    f"{continuation_instruction}"
                    f"{tone_instruction}"
                    f"{word_limit_instruction}"
                ),
            }]

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
                f"{tone_instruction}"
                f"{word_limit_instruction}"
            ),
        }]

    async def _send(self, websocket: WebSocket, data: dict):
        """Send data to the frontend, silently ignoring connection errors."""
        try:
            await websocket.send_text(json.dumps(data))
        except Exception:
            pass
