from anthropic import AsyncAnthropic
import config
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

    def _get_client(self, api_keys: dict | None = None) -> AsyncAnthropic:
        """Create an Anthropic client using per-session key if provided, else fallback to config."""
        key = (api_keys or {}).get("anthropic_api_key", "") or config.ANTHROPIC_API_KEY
        return AsyncAnthropic(api_key=key)

    def _get_brave_key(self, api_keys: dict | None = None) -> str:
        """Get Brave API key from per-session keys or fallback to config."""
        return (api_keys or {}).get("brave_api_key", "") or config.BRAVE_API_KEY

    def _get_tools(self, api_keys: dict | None = None) -> list[dict]:
        """Return available tools. Exclude search tools if no Brave key is available."""
        brave_key = self._get_brave_key(api_keys)
        if brave_key:
            return [SEARCH_TOOL_DEFINITION, IMAGE_SEARCH_TOOL_DEFINITION]
        return []

    async def respond(self, messages: list[dict], api_keys: dict | None = None) -> str:
        """Get a complete response from the agent with tool use support."""
        client = self._get_client(api_keys)
        tools = self._get_tools(api_keys)
        brave_key = self._get_brave_key(api_keys)
        kwargs = dict(
            model=config.MODEL,
            max_tokens=config.MAX_TOKENS,
            system=self.system_prompt,
            messages=messages,
        )
        if tools:
            kwargs["tools"] = tools
        response = await client.messages.create(**kwargs)
        # Handle tool use loop
        current_messages = list(messages)
        while response.stop_reason == "tool_use":
            tool_results = self._process_tool_calls(response, brave_key)
            current_messages.append({"role": "assistant", "content": response.content})
            current_messages.append({"role": "user", "content": tool_results})
            response = await client.messages.create(**dict(kwargs, messages=current_messages))
        return self._extract_text(response)

    async def stream_response(self, messages: list[dict], api_keys: dict | None = None):
        """Stream a response, handling tool use transparently. Yields text chunks."""
        client = self._get_client(api_keys)
        tools = self._get_tools(api_keys)
        brave_key = self._get_brave_key(api_keys)
        current_messages = list(messages)
        max_tool_rounds = 3

        kwargs = dict(
            model=config.MODEL,
            max_tokens=config.MAX_TOKENS,
            system=self.system_prompt,
        )
        if tools:
            kwargs["tools"] = tools

        for _ in range(max_tool_rounds):
            response = await client.messages.create(**kwargs, messages=current_messages)

            if response.stop_reason == "tool_use":
                tool_results = self._process_tool_calls(response, brave_key)
                current_messages.append({"role": "assistant", "content": response.content})
                current_messages.append({"role": "user", "content": tool_results})
                continue

            break

        # Stream the final response
        async with client.messages.stream(**kwargs, messages=current_messages) as stream:
            async for text in stream.text_stream:
                yield text

    def _process_tool_calls(self, response, brave_api_key: str = "") -> list[dict]:
        """Extract tool calls from response and execute them."""
        results = []
        for block in response.content:
            if block.type == "tool_use":
                if block.name == "web_search":
                    query = block.input.get("query", "")
                    search_results = execute_search(query, brave_api_key=brave_api_key)
                    formatted = format_search_results(search_results)
                    results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": formatted,
                    })
                elif block.name == "image_search":
                    query = block.input.get("query", "")
                    image_results = execute_image_search(query, brave_api_key=brave_api_key)
                    formatted = format_image_results(image_results)
                    results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": formatted,
                    })
        return results

    def _extract_text(self, response) -> str:
        """Extract text content from a response."""
        parts = []
        for block in response.content:
            if block.type == "text":
                parts.append(block.text)
        return "\n".join(parts)
