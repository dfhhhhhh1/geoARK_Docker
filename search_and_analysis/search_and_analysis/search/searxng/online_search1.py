import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from config import SEARCH_LIMIT, SEARCH_URL, HTTP_TIMEOUT_LIMIT, MAX_WEB_CONTEXT

import requests
from bs4 import BeautifulSoup
import logging
logger = logging.getLogger(__name__)

def evaluate_status(response: requests.Response) -> bool:
    if response.status_code in (401, 403, 406, 407, 429, 451):
        logger.info("Search request rejected: HTTP %s", response.status_code)
    elif response.status_code >= 500:
        logger.error("Server-side failure: %s", response.status_code)
    elif response.status_code != 200:
        logger.warning("Unexpected status: %s", response.status_code)
    else:
        return True
    return False

def search(query: str, limit: int=SEARCH_LIMIT, search_url: str=SEARCH_URL, http_timeout_limit: int=HTTP_TIMEOUT_LIMIT):
    if not query:
        return []
    response = requests.get(search_url,
        params={"q": query, "format": "json"},
        timeout=http_timeout_limit)
    if not evaluate_status(response):
        return []
    
    data = response.json()
    results = data.get("results", [])
    return [
        {
            "title": r.get("title"),
            "url": r.get("url"),
            "snippet": r.get("content"),
        } for r in results[:limit]
    ]

def get_page(url: str, http_timeout_limit: int=HTTP_TIMEOUT_LIMIT) -> str:
    response = requests.get(url, timeout=http_timeout_limit, headers={"User-Agent": "Mozilla/5.0"})
    response.raise_for_status()
    soup = BeautifulSoup(response.text, "html.parser")
    for element in soup(["script", "style", "nav", "footer"]):
        element.decompose()
    return soup.get_text(" ", strip=True)

def online_search(query: str, limit: int, search_url: str, http_timeout_limit: int, max_web_context: int=MAX_WEB_CONTEXT):
    sources = []
    web_results = []
    results = search(query + " environmental factors", limit, search_url, http_timeout_limit)
    
    for result in results:
        try:
            text = get_page(result["url"], http_timeout_limit)
            logger.info("Retrieved a page - %s", text)
            sources.append(result["url"])
            web_results.append(f"TITLE: {result['title']}\nURL: {result['url']}\nTEXT: {text[:max_web_context]}")           
        except requests.RequestException as e:
            logger.debug("Failed to retrieve %s: %s", result["url"], e)
            continue
    
    if not sources:
        logger.warning("No pages could be successfully retrieved")
        return None, []
    
    context = "\n\n".join(web_results)
    return context, sources