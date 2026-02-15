from .base import Agent
from .personas import PERSONAS


class AgentRegistry:
    def __init__(self):
        self.agents: dict[str, Agent] = {}
        self._load_defaults()

    def _load_defaults(self):
        for key, persona in PERSONAS.items():
            self.agents[key] = Agent(
                name=persona["name"],
                personality=persona["personality"],
                specialty=persona["specialty"],
                system_prompt=persona["system_prompt"],
                color=persona["color"],
                avatar=persona["avatar"],
            )

    def get_agent(self, key: str) -> Agent:
        return self.agents[key]

    def get_all(self) -> list[Agent]:
        return list(self.agents.values())

    def get_discussion_order(self, keys: list[str] | None = None) -> list[Agent]:
        """Return agents in discussion order, optionally filtered by keys. Mediator goes last."""
        if keys:
            pool = {k: self.agents[k] for k in keys if k in self.agents}
        else:
            pool = self.agents
        agents = []
        mediator = None
        for agent in pool.values():
            if agent.name == "The Mediator":
                mediator = agent
            else:
                agents.append(agent)
        if mediator:
            agents.append(mediator)
        return agents

    def list_agents(self) -> list[dict]:
        return [
            {"key": k, "name": a.name, "specialty": a.specialty, "color": a.color, "avatar": a.avatar}
            for k, a in self.agents.items()
        ]
