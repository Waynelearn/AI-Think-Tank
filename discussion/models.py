import json
from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class Message:
    agent_name: str  # "user" for user messages
    content: str
    round_num: int
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())

    def to_dict(self) -> dict:
        return {
            "agent_name": self.agent_name,
            "content": self.content,
            "round_num": self.round_num,
            "timestamp": self.timestamp,
        }

    @staticmethod
    def from_dict(d: dict) -> "Message":
        return Message(
            agent_name=d["agent_name"],
            content=d["content"],
            round_num=d["round_num"],
            timestamp=d.get("timestamp", datetime.now().isoformat()),
        )


@dataclass
class Discussion:
    topic: str
    messages: list[Message] = field(default_factory=list)
    total_rounds: int = 2
    file_context: str = ""  # extracted text from uploaded files
    agent_keys: list[str] = field(default_factory=list)  # which agents are participating

    def add_message(self, message: Message):
        self.messages.append(message)

    def get_transcript(self) -> str:
        """Build a readable transcript of the discussion so far."""
        lines = [f"Topic: {self.topic}\n"]
        current_round = 0
        for msg in self.messages:
            if msg.round_num != current_round:
                current_round = msg.round_num
                lines.append(f"\n--- Round {current_round} ---\n")
            label = "User" if msg.agent_name == "user" else msg.agent_name
            lines.append(f"{label}: {msg.content}\n")
        return "\n".join(lines)

    def export(self) -> dict:
        """Export discussion state for download. Keeps full content, no lossy summarization."""
        return {
            "topic": self.topic,
            "total_rounds": self.total_rounds,
            "agent_keys": self.agent_keys,
            "file_context": self.file_context,
            "messages": [m.to_dict() for m in self.messages],
        }

    def export_json(self) -> str:
        return json.dumps(self.export(), indent=2)

    @staticmethod
    def from_export(data: dict) -> "Discussion":
        """Reconstruct a Discussion from exported JSON data."""
        d = Discussion(
            topic=data["topic"],
            total_rounds=data.get("total_rounds", 2),
            file_context=data.get("file_context", ""),
            agent_keys=data.get("agent_keys", []),
        )
        for m in data.get("messages", []):
            d.messages.append(Message.from_dict(m))
        return d
