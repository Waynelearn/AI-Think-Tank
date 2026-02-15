from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class Message:
    agent_name: str
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


@dataclass
class Discussion:
    topic: str
    messages: list[Message] = field(default_factory=list)
    total_rounds: int = 2

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
            lines.append(f"{msg.agent_name}: {msg.content}\n")
        return "\n".join(lines)
