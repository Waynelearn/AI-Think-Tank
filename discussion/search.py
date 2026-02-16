import re

import httpx

from config import BRAVE_API_KEY, BRAVE_SAFESEARCH

BRAVE_WEB_URL = "https://api.search.brave.com/res/v1/web/search"
BRAVE_IMAGE_URL = "https://api.search.brave.com/res/v1/images/search"

SEARCH_TOOL_DEFINITION = {
    "name": "web_search",
    "description": (
        "Search the web for current information, evidence, data, or sources to support your arguments. "
        "Returns titles, URLs, and snippets from search results. Use this to find real sources and cite them with working links."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "The search query to look up",
            },
        },
        "required": ["query"],
    },
}


IMAGE_SEARCH_TOOL_DEFINITION = {
    "name": "image_search",
    "description": (
        "Search the web for images relevant to the discussion. Returns image URLs, titles, and source pages. "
        "Use this when a visual aid, chart, diagram, or photo would help illustrate your point. "
        "Include the image in your response using markdown: ![description](image_url). "
        "If the image URL is blocked, use the provided fallback thumbnail instead. "
        "Try up to 5 different results if the first image fails to load."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "The image search query",
            },
        },
        "required": ["query"],
    },
}


def _brave_headers(api_key: str = "") -> dict:
    key = api_key or BRAVE_API_KEY
    return {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": key,
    }


def execute_search(query: str, max_results: int = 5, brave_api_key: str = "") -> list[dict]:
    """Run a Brave web search and return results."""
    try:
        resp = httpx.get(
            BRAVE_WEB_URL,
            headers=_brave_headers(brave_api_key),
            params={
                "q": query,
                "count": max_results,
                "safesearch": BRAVE_SAFESEARCH,
            },
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        results = data.get("web", {}).get("results", [])
        return [
            {
                "title": r.get("title", ""),
                "url": r.get("url", ""),
                "snippet": r.get("description", ""),
            }
            for r in results[:max_results]
        ]
    except Exception as e:
        return [{"error": str(e)}]


def _clean_image_url(url: str) -> str:
    """Extract clean image URL, stripping proxy params appended without '?'."""
    if not url:
        return url
    if "&" in url and "?" not in url:
        url = url.split("&", 1)[0]
    match = re.match(
        r'(https?://[^\s]+?\.(jpg|jpeg|png|gif|webp|svg|bmp))(?:[?#].*)?$',
        url,
        re.IGNORECASE,
    )
    if match:
        return match.group(1)
    return url


def _is_image_url(url: str) -> bool:
    if not url:
        return False
    return bool(
        re.search(r'\.(jpg|jpeg|png|gif|webp|svg|bmp)(?:[?#].*)?$', url, re.IGNORECASE)
    )


def _pick_best_image_url(image_url: str, thumbnail: str) -> str:
    """Pick a likely embeddable image URL, falling back to thumbnail when needed."""
    if not image_url and thumbnail:
        return thumbnail
    if thumbnail and not _is_image_url(image_url) and _is_image_url(thumbnail):
        return thumbnail
    return image_url or thumbnail


def execute_image_search(query: str, max_results: int = 5, brave_api_key: str = "") -> list[dict]:
    """Run a Brave image search and return results."""
    try:
        resp = httpx.get(
            BRAVE_IMAGE_URL,
            headers=_brave_headers(brave_api_key),
            params={
                "q": query,
                "count": max_results,
                "safesearch": BRAVE_SAFESEARCH,
            },
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        results = data.get("results", [])
        out = []
        for r in results[:max_results]:
            image_url = _clean_image_url(r.get("properties", {}).get("url", ""))
            thumbnail = r.get("thumbnail", {}).get("src", "")
            best_url = _pick_best_image_url(image_url, thumbnail)
            out.append(
                {
                    "title": r.get("title", ""),
                    "image_url": best_url,
                    "thumbnail": thumbnail,
                    "fallback_url": thumbnail,
                    "source_url": r.get("url", ""),
                }
            )
        return out
    except Exception as e:
        return [{"error": str(e)}]


def format_search_results(results: list[dict]) -> str:
    """Format search results as readable text for Claude."""
    if not results:
        return "No results found."
    if "error" in results[0]:
        return f"Search error: {results[0]['error']}"
    lines = []
    for i, r in enumerate(results, 1):
        lines.append(f"{i}. {r['title']}\n   URL: {r['url']}\n   {r['snippet']}")
    return "\n\n".join(lines)


def format_image_results(results: list[dict]) -> str:
    """Format image search results for Claude."""
    if not results:
        return "No images found."
    if "error" in results[0]:
        return f"Image search error: {results[0]['error']}"
    lines = []
    for i, r in enumerate(results, 1):
        lines.append(
            f"{i}. {r['title']}\n"
            f"   Image URL: {r['image_url']}\n"
            f"   Fallback Thumbnail: {r.get('fallback_url', r['thumbnail'])}\n"
            f"   Source: {r['source_url']}\n"
            f"   Use the Image URL in your markdown. If it is blocked or broken, use the Fallback Thumbnail instead."
        )
    return "\n\n".join(lines)
