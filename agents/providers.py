"""
Multi-provider LLM abstraction layer.

Two provider classes handle all supported services:
- AnthropicProvider  — for Claude models (native Anthropic API)
- OpenAICompatibleProvider — for OpenAI, DeepSeek, Gemini, Groq (OpenAI-compatible APIs)

Each provider normalises responses into a common format so the Agent class
can work identically regardless of which backend is selected.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import AsyncGenerator

# ---------------------------------------------------------------------------
# Common data structures
# ---------------------------------------------------------------------------

@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0

    def __iadd__(self, other: Usage) -> Usage:
        self.input_tokens += other.input_tokens
        self.output_tokens += other.output_tokens
        return self

    def to_dict(self) -> dict:
        return {"input_tokens": self.input_tokens, "output_tokens": self.output_tokens}


@dataclass
class ToolCall:
    id: str
    name: str
    input: dict


@dataclass
class LLMResponse:
    """Normalised response from any provider."""
    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    stop_reason: str = ""  # "end_turn", "tool_use", etc.
    usage: Usage = field(default_factory=Usage)


# ---------------------------------------------------------------------------
# Provider registry (static metadata for the frontend)
# ---------------------------------------------------------------------------

PROVIDERS: dict[str, dict] = {
    "anthropic": {
        "name": "Anthropic",
        "models": [
            {"id": "claude-sonnet-4-5-20250929", "label": "Claude Sonnet 4.5"},
            {"id": "claude-haiku-4-5-20251001", "label": "Claude Haiku 4.5"},
        ],
        "key_prefix": "sk-ant-",
    },
    "openai": {
        "name": "OpenAI",
        "models": [
            {"id": "gpt-4o", "label": "GPT-4o"},
            {"id": "gpt-4o-mini", "label": "GPT-4o Mini"},
            {"id": "o3-mini", "label": "o3-mini"},
        ],
        "key_prefix": "sk-",
        "base_url": None,
    },
    "deepseek": {
        "name": "DeepSeek",
        "models": [
            {"id": "deepseek-chat", "label": "DeepSeek V3"},
            {"id": "deepseek-reasoner", "label": "DeepSeek R1"},
        ],
        "key_prefix": "",
        "base_url": "https://api.deepseek.com",
    },
    "gemini": {
        "name": "Google Gemini",
        "models": [
            {"id": "gemini-2.0-flash", "label": "Gemini 2.0 Flash"},
            {"id": "gemini-2.5-pro-preview-06-05", "label": "Gemini 2.5 Pro"},
        ],
        "key_prefix": "",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
    },
    "groq": {
        "name": "Groq",
        "models": [
            {"id": "llama-3.3-70b-versatile", "label": "Llama 3.3 70B"},
            {"id": "mixtral-8x7b-32768", "label": "Mixtral 8x7B"},
        ],
        "key_prefix": "gsk_",
        "base_url": "https://api.groq.com/openai/v1",
    },
}


def get_providers_for_api() -> list[dict]:
    """Return provider metadata for the /api/providers endpoint."""
    out = []
    for key, p in PROVIDERS.items():
        out.append({
            "key": key,
            "name": p["name"],
            "models": p["models"],
            "key_prefix": p.get("key_prefix", ""),
        })
    return out


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

def create_provider(provider_key: str, api_key: str, model: str) -> LLMProvider:
    """Instantiate the correct provider for the given key."""
    if provider_key == "anthropic":
        return AnthropicProvider(api_key=api_key, model=model)

    meta = PROVIDERS.get(provider_key)
    if not meta:
        raise ValueError(f"Unknown provider: {provider_key}")

    return OpenAICompatibleProvider(
        api_key=api_key,
        model=model,
        base_url=meta.get("base_url"),
    )


# ---------------------------------------------------------------------------
# Base class
# ---------------------------------------------------------------------------

class LLMProvider:
    """Abstract base for LLM providers."""

    async def create(
        self,
        system: str,
        messages: list[dict],
        tools: list[dict] | None,
        max_tokens: int,
    ) -> LLMResponse:
        raise NotImplementedError

    async def stream(
        self,
        system: str,
        messages: list[dict],
        tools: list[dict] | None,
        max_tokens: int,
    ) -> AsyncGenerator[str | Usage, None]:
        """Yield text chunks, then a final Usage object."""
        raise NotImplementedError
        yield  # make it a generator  # noqa: unreachable


# ---------------------------------------------------------------------------
# Anthropic
# ---------------------------------------------------------------------------

class AnthropicProvider(LLMProvider):
    def __init__(self, api_key: str, model: str):
        from anthropic import AsyncAnthropic
        self.client = AsyncAnthropic(api_key=api_key)
        self.model = model

    async def create(self, system, messages, tools, max_tokens) -> LLMResponse:
        kwargs: dict = dict(
            model=self.model,
            max_tokens=max_tokens,
            system=system,
            messages=messages,
        )
        if tools:
            kwargs["tools"] = tools

        resp = await self.client.messages.create(**kwargs)
        return self._normalise(resp)

    async def stream(self, system, messages, tools, max_tokens):
        kwargs: dict = dict(
            model=self.model,
            max_tokens=max_tokens,
            system=system,
            messages=messages,
        )
        if tools:
            kwargs["tools"] = tools

        async with self.client.messages.stream(**kwargs) as s:
            async for text in s.text_stream:
                yield text
            resp = await s.get_final_message()
            yield Usage(
                input_tokens=resp.usage.input_tokens,
                output_tokens=resp.usage.output_tokens,
            )

    def _normalise(self, resp) -> LLMResponse:
        text_parts: list[str] = []
        tool_calls: list[ToolCall] = []
        for block in resp.content:
            if block.type == "text":
                text_parts.append(block.text)
            elif block.type == "tool_use":
                tool_calls.append(ToolCall(id=block.id, name=block.name, input=block.input))

        stop = "tool_use" if resp.stop_reason == "tool_use" else "end_turn"
        return LLMResponse(
            text="\n".join(text_parts),
            tool_calls=tool_calls,
            stop_reason=stop,
            usage=Usage(resp.usage.input_tokens, resp.usage.output_tokens),
        )


# ---------------------------------------------------------------------------
# OpenAI-compatible (OpenAI, DeepSeek, Gemini, Groq)
# ---------------------------------------------------------------------------

class OpenAICompatibleProvider(LLMProvider):
    def __init__(self, api_key: str, model: str, base_url: str | None = None):
        from openai import AsyncOpenAI
        kwargs: dict = {"api_key": api_key}
        if base_url:
            kwargs["base_url"] = base_url
        self.client = AsyncOpenAI(**kwargs)
        self.model = model

    # -- public interface --

    async def create(self, system, messages, tools, max_tokens) -> LLMResponse:
        oai_messages = self._build_messages(system, messages)
        kwargs: dict = dict(
            model=self.model,
            max_tokens=max_tokens,
            messages=oai_messages,
        )
        if tools:
            kwargs["tools"] = self._translate_tools(tools)

        resp = await self.client.chat.completions.create(**kwargs)
        return self._normalise(resp)

    async def stream(self, system, messages, tools, max_tokens):
        oai_messages = self._build_messages(system, messages)
        kwargs: dict = dict(
            model=self.model,
            max_tokens=max_tokens,
            messages=oai_messages,
            stream=True,
            stream_options={"include_usage": True},
        )
        if tools:
            kwargs["tools"] = self._translate_tools(tools)

        usage = Usage()
        async for chunk in await self.client.chat.completions.create(**kwargs):
            if chunk.usage:
                usage = Usage(
                    input_tokens=chunk.usage.prompt_tokens or 0,
                    output_tokens=chunk.usage.completion_tokens or 0,
                )
            if chunk.choices and chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content

        yield usage

    # -- message translation --

    def _build_messages(self, system: str, messages: list[dict]) -> list[dict]:
        """Convert Anthropic-style messages to OpenAI-style (system as first message)."""
        oai: list[dict] = []
        if system:
            oai.append({"role": "system", "content": system})

        for msg in messages:
            role = msg["role"]
            content = msg.get("content")

            # Handle Anthropic tool_result messages
            if role == "user" and isinstance(content, list):
                for item in content:
                    if isinstance(item, dict) and item.get("type") == "tool_result":
                        oai.append({
                            "role": "tool",
                            "tool_call_id": item["tool_use_id"],
                            "content": item.get("content", ""),
                        })
                continue

            # Handle assistant messages with tool_use blocks
            if role == "assistant" and isinstance(content, list):
                text_parts = []
                tool_calls = []
                for block in content:
                    if hasattr(block, "type"):
                        # Anthropic SDK objects
                        if block.type == "text":
                            text_parts.append(block.text)
                        elif block.type == "tool_use":
                            tool_calls.append({
                                "id": block.id,
                                "type": "function",
                                "function": {
                                    "name": block.name,
                                    "arguments": json.dumps(block.input),
                                },
                            })
                    elif isinstance(block, dict):
                        if block.get("type") == "text":
                            text_parts.append(block.get("text", ""))
                        elif block.get("type") == "tool_use":
                            tool_calls.append({
                                "id": block["id"],
                                "type": "function",
                                "function": {
                                    "name": block["name"],
                                    "arguments": json.dumps(block.get("input", {})),
                                },
                            })
                m: dict = {"role": "assistant", "content": "\n".join(text_parts) or None}
                if tool_calls:
                    m["tool_calls"] = tool_calls
                oai.append(m)
                continue

            # Simple text message
            oai.append({"role": role, "content": content if isinstance(content, str) else str(content)})

        return oai

    def _translate_tools(self, tools: list[dict]) -> list[dict]:
        """Convert Anthropic tool format → OpenAI function calling format."""
        oai_tools = []
        for t in tools:
            oai_tools.append({
                "type": "function",
                "function": {
                    "name": t["name"],
                    "description": t.get("description", ""),
                    "parameters": t.get("input_schema", {}),
                },
            })
        return oai_tools

    def _normalise(self, resp) -> LLMResponse:
        choice = resp.choices[0] if resp.choices else None
        if not choice:
            return LLMResponse(usage=Usage(
                resp.usage.prompt_tokens or 0,
                resp.usage.completion_tokens or 0,
            ) if resp.usage else Usage())

        msg = choice.message
        text = msg.content or ""
        tool_calls: list[ToolCall] = []

        if msg.tool_calls:
            for tc in msg.tool_calls:
                try:
                    args = json.loads(tc.function.arguments)
                except (json.JSONDecodeError, TypeError):
                    args = {}
                tool_calls.append(ToolCall(id=tc.id, name=tc.function.name, input=args))

        stop = "tool_use" if tool_calls else "end_turn"
        usage = Usage(
            resp.usage.prompt_tokens or 0,
            resp.usage.completion_tokens or 0,
        ) if resp.usage else Usage()

        return LLMResponse(text=text, tool_calls=tool_calls, stop_reason=stop, usage=usage)
