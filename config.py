import os
from dotenv import load_dotenv

load_dotenv()

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
MODEL = "claude-sonnet-4-5-20250929"
MAX_TOKENS = 1024
BRAVE_API_KEY = os.getenv("BRAVE_API_KEY", "")
BRAVE_SAFESEARCH = os.getenv("BRAVE_SAFESEARCH", "moderate")
