from duckduckgo_search import DDGS


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
        "Include the image in your response using markdown: ![description](image_url)"
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


def execute_search(query: str, max_results: int = 5) -> list[dict]:
    """Run a DuckDuckGo search and return results."""
    try:
        with DDGS() as ddgs:
            results = list(ddgs.text(query, max_results=max_results))
        return [
            {
                "title": r.get("title", ""),
                "url": r.get("href", ""),
                "snippet": r.get("body", ""),
            }
            for r in results
        ]
    except Exception as e:
        return [{"error": str(e)}]


def _clean_image_url(url: str) -> str:
    """Extract clean image URL, stripping proxy params appended without '?'."""
    import re
    # Fix URLs like "image.jpg&w=700&q=90" → "image.jpg"
    match = re.match(r'(https?://.+?\.(jpg|jpeg|png|gif|webp|svg|bmp))', url, re.IGNORECASE)
    if match:
        return match.group(1)
    return url


def execute_image_search(query: str, max_results: int = 3) -> list[dict]:
    """Run a DuckDuckGo image search and return results."""
    try:
        with DDGS() as ddgs:
            results = list(ddgs.images(query, max_results=max_results))
        out = []
        for r in results:
            image_url = _clean_image_url(r.get("image", ""))
            thumbnail = r.get("thumbnail", "")
            out.append({
                "title": r.get("title", ""),
                "image_url": image_url,
                "thumbnail": thumbnail,
                "source_url": r.get("url", ""),
            })
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
            f"   Thumbnail: {r['thumbnail']}\n"
            f"   Source: {r['source_url']}\n"
            f"   Use the Image URL in your markdown. If it looks broken (has extra params after the extension), use the Thumbnail instead."
        )
    return "\n\n".join(lines)
