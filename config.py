import os
from dotenv import load_dotenv

load_dotenv()

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
DEFAULT_PROVIDER = os.getenv("DEFAULT_PROVIDER", "anthropic")
DEFAULT_MODEL = os.getenv("DEFAULT_MODEL", "claude-sonnet-4-5-20250929")
MAX_TOKENS = 1024
BRAVE_API_KEY = os.getenv("BRAVE_API_KEY", "")
BRAVE_SAFESEARCH = os.getenv("BRAVE_SAFESEARCH", "moderate")
