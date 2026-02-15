from anthropic import AsyncAnthropic
import config


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
        """Get a complete response from the agent."""
        response = await self.client.messages.create(
            model=config.MODEL,
            max_tokens=config.MAX_TOKENS,
            system=self.system_prompt,
            messages=messages,
        )
        return response.content[0].text

    async def stream_response(self, messages: list[dict]):
        """Stream a response from the agent, yielding text chunks."""
        async with self.client.messages.stream(
            model=config.MODEL,
            max_tokens=config.MAX_TOKENS,
            system=self.system_prompt,
            messages=messages,
        ) as stream:
            async for text in stream.text_stream:
                yield text
