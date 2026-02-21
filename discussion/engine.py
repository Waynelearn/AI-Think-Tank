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
                          session_id: str = "",
                          viewpoints: list[str] | None = None):
        """Run an interactive session, processing commands from the frontend."""

        # Fixed viewpoints for sentiment analysis (user-provided or auto-generated from round 1)
        fixed_viewpoints = list(viewpoints) if viewpoints and len(viewpoints) == 2 and all(v.strip() for v in viewpoints) else []

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

                # Apply per-command overrides for live settings
                live_keys = dict(api_keys or {})
                if "word_limit" in cmd:
                    live_keys["word_limit"] = cmd["word_limit"]
                if "tone" in cmd:
                    live_keys["tone"] = cmd["tone"]

                await self._run_single_agent(websocket, agent, discussion, topic,
                                             round_num, file_context, live_keys, session_id,
                                             continue_from=continue_from,
                                             agent_key=agent_key,
                                             fixed_viewpoints=fixed_viewpoints)

                # Run curator check on the agent's response (skip for sentiment analyst)
                if agent_key != "sentiment_analyst":
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
                                 api_keys: dict | None = None, session_id: str = "",
                                 continue_from: str = "",
                                 agent_key: str = "",
                                 fixed_viewpoints: list[str] | None = None):
        """Stream a single agent's response."""
        word_limit = int((api_keys or {}).get("word_limit", 0))
        tone = (api_keys or {}).get("tone", "")
        messages = self._build_messages(discussion, topic, round_num, file_context,
                                        word_limit=word_limit, tone=tone,
                                        continue_from=continue_from,
                                        continue_agent=agent.name if continue_from else "",
                                        agent_key=agent_key,
                                        fixed_viewpoints=fixed_viewpoints)

        if not agent_key:
            agent_key = next((k for k, a in self.registry.agents.items() if a is agent), "")

        await self._send(websocket, {
            "type": "agent_start",
            "agent": agent.name,
            "color": agent.color,
            "avatar": agent.avatar,
            "round": round_num,
            "agent_key": agent_key,
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

        # If this is the Sentiment Analyst, extract chart data from the response
        if agent_key == "sentiment_analyst":
            await self._extract_sentiment_data(
                websocket, full_response, round_num, fixed_viewpoints
            )

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

    # ── Sentiment Data Extraction ──

    async def _extract_sentiment_data(self, websocket: WebSocket,
                                       full_response: str, round_num: int,
                                       fixed_viewpoints: list[str] | None = None):
        """Extract JSON data from Sentiment Analyst's chat response and send sentiment_update."""
        delimiter = "---SENTIMENT_DATA---"
        if delimiter not in full_response:
            logger.warning("Sentiment Analyst response missing ---SENTIMENT_DATA--- delimiter")
            return

        parts = full_response.split(delimiter, 1)
        if len(parts) < 2:
            return

        json_str = self._clean_json_response(parts[1])
        try:
            data = json.loads(json_str)
            if "viewpoints" not in data or "scores" not in data:
                logger.warning("Sentiment data missing viewpoints or scores")
                return

            # Auto-fix viewpoints from round 1 if no user-defined ones
            if fixed_viewpoints is not None and not fixed_viewpoints:
                vps = data.get("viewpoints", [])
                if len(vps) >= 2:
                    fixed_viewpoints.extend([vps[0].get("label", ""), vps[1].get("label", "")])

            await self._send(websocket, {
                "type": "sentiment_update",
                "round": round_num,
                "data": data,
            })
        except json.JSONDecodeError:
            logger.warning(f"Sentiment Analyst JSON parse failed: {json_str[:200]}")
        except Exception as e:
            logger.warning(f"Sentiment data extraction failed: {e}")

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
            "MANDATORY TONE — LAYMAN: You MUST speak in plain, everyday language that a teenager could understand. "
            "ABSOLUTELY NO jargon, technical terms, acronyms, or field-specific vocabulary. "
            "If a concept has a technical name, DO NOT use it — describe it in simple words instead. "
            "Use short sentences (under 20 words each). Use concrete, real-world examples and analogies "
            "from daily life (cooking, sports, driving, shopping). "
            "VIOLATION CHECK: Before finishing, re-read your response. If ANY word would confuse "
            "someone without a college degree, replace it with a simpler word."
        ),
        "academic": (
            "MANDATORY TONE — ACADEMIC: You MUST write in a formal, scholarly style throughout your entire response. "
            "Use precise technical terminology and discipline-specific language. "
            "Structure arguments rigorously: thesis statement, supporting evidence, counterarguments, synthesis. "
            "Cite theoretical frameworks and established literature where applicable. "
            "Maintain a detached, objective, analytical voice — no colloquialisms or informal phrasing."
        ),
        "professional": (
            "MANDATORY TONE — PROFESSIONAL: You MUST write in a crisp, executive-briefing style. "
            "Be direct and action-oriented — lead with the bottom line, then support it. "
            "Use bullet points or numbered lists for key takeaways when appropriate. "
            "Focus on implications, trade-offs, ROI, and actionable next steps. "
            "No filler, no hedging, no academic abstractions — every sentence must earn its place."
        ),
        "debate": (
            "MANDATORY TONE — DEBATE: You MUST be sharp, confrontational, and rhetorically aggressive. "
            "Directly name and challenge other panelists' specific claims. Quote their words back at them. "
            "Poke holes in their logic with pointed questions and devastating counter-examples. "
            "DO NOT soften disagreements with phrases like 'I see your point but...' — "
            "go straight for the weakness in their argument. Be intellectually ruthless while staying substantive."
        ),
        "storyteller": (
            "MANDATORY TONE — STORYTELLER: You MUST frame ALL your points through stories, anecdotes, and vivid scenarios. "
            "DO NOT present arguments as abstract claims — instead, paint a picture with characters, settings, and stakes. "
            "Use narrative structure: setup a situation, build tension around the problem, reveal the insight as resolution. "
            "Make every abstract idea tangible through human-scale examples. "
            "Your response should read like a compelling narrative, not an essay."
        ),
        "socratic": (
            "MANDATORY TONE — SOCRATIC: You MUST lead with probing questions rather than assertions. "
            "Start by challenging a key assumption from the discussion with a 'why' or 'what if' question. "
            "Ask at least 2-3 genuine questions that expose hidden assumptions or unexplored angles. "
            "After each question, offer your own tentative answer to keep the discussion moving. "
            "Your goal is to make other panelists THINK, not to lecture them."
        ),
    }

    def _build_messages(self, discussion: Discussion, topic: str,
                        current_round: int, file_context: str = "",
                        word_limit: int = 0, tone: str = "",
                        continue_from: str = "",
                        continue_agent: str = "",
                        agent_key: str = "",
                        fixed_viewpoints: list[str] | None = None) -> list[dict]:
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
                f"\n\nMANDATORY WORD LIMIT: Your response MUST be under {word_limit} words. "
                f"This is a hard limit — not a suggestion. Count your words carefully. "
                f"If you exceed {word_limit} words, your response will be considered a failure. "
                f"Be concise: cut filler, merge points, and prioritize your strongest arguments."
            )

        tone_instruction = ""
        if tone and tone in self.TONE_INSTRUCTIONS:
            tone_instruction = f"\n\nCRITICAL INSTRUCTION — {self.TONE_INSTRUCTIONS[tone]}"

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

        viewpoint_instruction = ""
        if agent_key == "sentiment_analyst" and fixed_viewpoints and len(fixed_viewpoints) == 2:
            viewpoint_instruction = (
                f"\n\nFIXED VIEWPOINTS (do NOT change these):\n"
                f"- Viewpoint A (+1): {fixed_viewpoints[0]}\n"
                f"- Viewpoint B (-1): {fixed_viewpoints[1]}\n"
                f"Use EXACTLY these two viewpoints in your analysis and JSON output. "
                f"Do NOT invent new ones or rephrase them."
            )

        if not discussion.messages:
            return [{
                "role": "user",
                "content": (
                    f"The discussion topic is: {topic}{file_section}\n\n"
                    f"Please share your perspective. If you need current data or sources, "
                    f"use the web_search tool to find evidence and include links in your response."
                    f"{viewpoint_instruction}"
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
                    f"{viewpoint_instruction}"
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
                f"{viewpoint_instruction}"
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
