# ========= FOR ALL SEARCH PIPELINES =========
LLM_MODEL = "qwen3:1.7b" # Change to newModelName if needed
LLM_KEYWORD_SCHEMA = {
    "type": "object",
    "properties": {
        "keywords": {
            "type": "array",
            "items": {"type": "string"},
        }
    },
    "required": ["keywords"],
} # Expected llm output format (stored in "results/")
PIPELINES = ["context", "searxng", "semmed"] # dir names of all pipelines that results in keywords as output


# ========= SeMed & PubMed SEARCH PIPELINE =========
NUM_QUERIES = 2 # Max # of biomedical entities used to generate search queries.
NUM_CONCEPTS = 4 # Max # of candidate biomedical concepts considered per entity.
NUM_PAPERS = 5 # SMax # of highest-relevance papers to return.
LLM_INSTRUCTIONS_SEMMED = """Extract specific, evidence-based keywords related to environmental exposures, geographic factors, built environment, socioeconomic determinants, and relevant health outcomes from the provided PubMed paper titles and abstracts.\nRules:
- Prefer precise, multiword concepts over broad terms.
- Include specific pollutants, exposure metrics, geographic units, spatial patterns, and contextual variables when supported by text.
- Focus on factors relevant to the research question.
- Exclude generic terms (e.g., "environmental", "geospatial", "risk factors", "public health"), research methods, and duplicates.
- Do not invent concepts or associations not supported by the papers.
- Return only meaningful, specific keywords supported by the evidence.
"""

# ========= ONLINE RAG PIPELINE =========
SEARCH_LIMIT = 10 # Max # of search results to return.
SEARCH_URL = "http://localhost:8080/search" # URL of the search service to query.
HTTP_TIMEOUT_LIMIT = 15 # Max time in seconds to wait for HTTP request.
MAX_WEB_CONTEXT = 5000 # Max # of chars to include from each retrieved webpage as LLM context.
LLM_INSTRUCTIONS_ONLINE = """Extract specific, informative keywords from WEB RESULTS relevant to RESEARCH QUESTION. 
Focus on concrete factors, events, substances, and conditions over generic categories. 
Exclude vague, redundant, or irrelevant terms.
"""


# ========= CONTEXT (uploaded file) RAG PIPELINE =========
from pathlib import Path
BASE_DIR = Path(__file__).resolve().parent
CONTEXT_FILEPATH = BASE_DIR / "context_files" / "2026_09_04_Draft.Gateway_White Paper.pdf" # context file's abs filepath
CONTEXT_LIMIT = 10000 # Max # of chars to include from uploaded context file
KEYWORDS_TOKENS = 200 # Max # of tokens to reserve for llm's output
TOTAL_TOKENS = CONTEXT_LIMIT + KEYWORDS_TOKENS + 400 # Total # of tokens to reserve for context window
LLM_INSTRUCTIONS_CONTEXT = """Extract specific, evidence-based keywords related to environmental
exposures, geographic factors, built environment, socioeconomic
determinants, and relevant health outcomes from the provided
PubMed paper titles and abstracts.\nRules:
- Prefer precise, multiword concepts over broad terms.
- Include specific pollutants, exposure metrics, geographic units,
spatial patterns, and contextual variables when supported by text.
- Focus on factors relevant to the research question.
- Exclude generic terms (e.g., "environmental", "geospatial",
"risk factors", "public health"), research methods, and duplicates.
- Do not invent concepts or associations not supported by the papers.
- Return only meaningful, specific keywords supported by the evidence."""
