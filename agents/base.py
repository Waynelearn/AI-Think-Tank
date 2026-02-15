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
        self.client = AsyncAnthropic(api_key=config.ANTHROPIC_API_KEY)

    async def respond(self, messages: list[dict]) -> str:
        """Get a complete response from the agent with tool use support."""
        response = await self.client.messages.create(
            model=config.MODEL,
            max_tokens=config.MAX_TOKENS,
            system=self.system_prompt,
            messages=messages,
            tools=[SEARCH_TOOL_DEFINITION, IMAGE_SEARCH_TOOL_DEFINITION],
        )
        # Handle tool use loop
        current_messages = list(messages)
        while response.stop_reason == "tool_use":
            tool_results = self._process_tool_calls(response)
            current_messages.append({"role": "assistant", "content": response.content})
            current_messages.append({"role": "user", "content": tool_results})
            response = await self.client.messages.create(
                model=config.MODEL,
                max_tokens=config.MAX_TOKENS,
                system=self.system_prompt,
                messages=current_messages,
                tools=[SEARCH_TOOL_DEFINITION, IMAGE_SEARCH_TOOL_DEFINITION],
            )
        return self._extract_text(response)

    async def stream_response(self, messages: list[dict]):
        """Stream a response, handling tool use transparently. Yields text chunks and source dicts."""
        current_messages = list(messages)
        max_tool_rounds = 3

        for _ in range(max_tool_rounds):
            # Collect the full response first to check for tool use
            response = await self.client.messages.create(
                model=config.MODEL,
                max_tokens=config.MAX_TOKENS,
                system=self.system_prompt,
                messages=current_messages,
                tools=[SEARCH_TOOL_DEFINITION, IMAGE_SEARCH_TOOL_DEFINITION],
            )

            if response.stop_reason == "tool_use":
                tool_results = self._process_tool_calls(response)
                current_messages.append({"role": "assistant", "content": response.content})
                current_messages.append({"role": "user", "content": tool_results})
                continue

            # Final text response — now stream it
            break

        # Stream the final response
        async with self.client.messages.stream(
            model=config.MODEL,
            max_tokens=config.MAX_TOKENS,
            system=self.system_prompt,
            messages=current_messages,
            tools=[SEARCH_TOOL_DEFINITION, IMAGE_SEARCH_TOOL_DEFINITION],
        ) as stream:
            async for text in stream.text_stream:
                yield text

    def _process_tool_calls(self, response) -> list[dict]:
        """Extract tool calls from response and execute them."""
        results = []
        for block in response.content:
            if block.type == "tool_use":
                if block.name == "web_search":
                    query = block.input.get("query", "")
                    search_results = execute_search(query)
                    formatted = format_search_results(search_results)
                    results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": formatted,
                    })
                elif block.name == "image_search":
                    query = block.input.get("query", "")
                    image_results = execute_image_search(query)
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
