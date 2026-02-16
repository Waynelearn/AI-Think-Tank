from __future__ import annotations

import config
from agents.providers import (
    LLMProvider, Usage, create_provider, PROVIDERS,
)
from discussion.search import (
    SEARCH_TOOL_DEFINITION, IMAGE_SEARCH_TOOL_DEFINITION,
    execute_search, format_search_results,
    execute_image_search, format_image_results,
)


class Agent:
    def __init__(self, name: str, personality: str, specialty: str, system_prompt: str, color: str, avatar: str):
        self.name = name
        self.personality = personality
        self.specialty = specialty
        self.system_prompt = system_prompt
        self.color = color
        self.avatar = avatar

    # ── provider / config helpers ──

    def _get_provider(self, api_keys: dict | None = None) -> LLMProvider:
        """Create the correct provider based on session settings."""
        keys = api_keys or {}
        provider_key = keys.get("provider", config.DEFAULT_PROVIDER)
        model = keys.get("model", config.DEFAULT_MODEL)
        api_key = keys.get("api_key", "") or config.ANTHROPIC_API_KEY
        return create_provider(provider_key, api_key, model)

    def _get_brave_key(self, api_keys: dict | None = None) -> str:
        return (api_keys or {}).get("brave_api_key", "") or config.BRAVE_API_KEY

    def _get_tools(self, api_keys: dict | None = None) -> list[dict]:
        brave_key = self._get_brave_key(api_keys)
        if brave_key:
            return [SEARCH_TOOL_DEFINITION, IMAGE_SEARCH_TOOL_DEFINITION]
        return []

    # ── main response methods ──

    async def stream_response(self, messages: list[dict], api_keys: dict | None = None):
        """Stream a response, handling tool use transparently.

        Yields text chunks (str), then a final Usage object.
        """
        provider = self._get_provider(api_keys)
        tools = self._get_tools(api_keys)
        brave_key = self._get_brave_key(api_keys)
        current_messages = list(messages)
        max_tool_rounds = 3
        total_usage = Usage()

        # Tool-use loop (non-streaming)
        for _ in range(max_tool_rounds):
            resp = await provider.create(
                system=self.system_prompt,
                messages=current_messages,
                tools=tools or None,
                max_tokens=config.MAX_TOKENS,
            )
            total_usage += resp.usage

            if resp.stop_reason == "tool_use" and resp.tool_calls:
                tool_results = self._process_tool_calls(resp.tool_calls, brave_key)
                # Build assistant content for the conversation
                assistant_content = self._build_assistant_content(resp)
                current_messages.append({"role": "assistant", "content": assistant_content})
                current_messages.append({"role": "user", "content": tool_results})
                continue
            break

        # Stream the final response
        async for item in provider.stream(
            system=self.system_prompt,
            messages=current_messages,
            tools=tools or None,
            max_tokens=config.MAX_TOKENS,
        ):
            if isinstance(item, Usage):
                total_usage += item
            else:
                yield item

        # Yield final usage
        yield total_usage

    # ── tool handling ──

    def _process_tool_calls(self, tool_calls, brave_api_key: str = "") -> list[dict]:
        results = []
        for tc in tool_calls:
            if tc.name == "web_search":
                query = tc.input.get("query", "")
                search_results = execute_search(query, brave_api_key=brave_api_key)
                formatted = format_search_results(search_results)
                results.append({
                    "type": "tool_result",
                    "tool_use_id": tc.id,
                    "content": formatted,
                })
            elif tc.name == "image_search":
                query = tc.input.get("query", "")
                image_results = execute_image_search(query, brave_api_key=brave_api_key)
                formatted = format_image_results(image_results)
                results.append({
                    "type": "tool_result",
                    "tool_use_id": tc.id,
                    "content": formatted,
                })
        return results

    def _build_assistant_content(self, resp) -> list:
        """Build assistant content list for tool-use round messages.

        For Anthropic provider, we pass the raw content blocks.
        For OpenAI-compatible, we build a compatible structure.
        """
        content = []
        if resp.text:
            content.append({"type": "text", "text": resp.text})
        for tc in resp.tool_calls:
            content.append({
                "type": "tool_use",
                "id": tc.id,
                "name": tc.name,
                "input": tc.input,
            })
        return content
