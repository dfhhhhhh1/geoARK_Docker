import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from config import LLM_MODEL, LLM_INSTRUCTIONS_SEMMED, LLM_KEYWORD_SCHEMA, NUM_PAPERS 
from parallel_llm import safe_chat

import json
from pathlib import Path
import pandas as pd
from datetime import datetime
import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.metrics.pairwise import cosine_similarity
import logging
logger = logging.getLogger(__name__)


BASE_DIR = Path(__file__).resolve().parent
RESULTS_DIR = BASE_DIR / "results"
QUERY_FILE = RESULTS_DIR / "queries.json"
model_path = BASE_DIR / "sentence_transformer_models" / "all-MiniLM-L6-v2"
model_path = Path(model_path)
if not model_path.exists():
    raise FileNotFoundError(f"Embedding model not found: {model_path}")

model = SentenceTransformer(str(model_path), local_files_only=True)

def load_queries():
    try:
        with open(QUERY_FILE, "r", encoding="utf-8") as file:
            return json.load(file)
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Error reading {QUERY_FILE}. Ensure the query-generation script has run successfully.") from exc

def load_papers_parquets(cui):
    all_papers_path = RESULTS_DIR / cui / "all_papers.parquet"
    filtered_papers_path = RESULTS_DIR / cui / "filtered_papers.parquet"
    if not all_papers_path.exists() or not filtered_papers_path.exists():
        return pd.DataFrame(), pd.DataFrame()
    return pd.read_parquet(all_papers_path), pd.read_parquet(filtered_papers_path)

def get_paper_embeddings(texts, cui):
    cache_path = RESULTS_DIR / cui / "paper_embeddings.npz"

    if cache_path.exists():
        with np.load(cache_path, allow_pickle=False) as cached:
            cached_texts = cached["texts"].tolist()
            if cached_texts == texts:
                logger.info("Loading cached embeddings for %s", cui)
                return cached["embeddings"]

        logger.info("Paper texts changed; regenerating embeddings for %s", cui)

    embeddings = model.encode(texts, batch_size=64, show_progress_bar=True, convert_to_numpy=True)

    cache_path.parent.mkdir(parents=True, exist_ok=True)

    np.savez(
        cache_path,
        texts=np.array(texts, dtype=str),
        embeddings=embeddings,
    )

    return embeddings

def screen_papers(papers, research_question: str, cui: str, num_papers: int=NUM_PAPERS):
    if papers.empty:
        return papers

    texts = (papers["title"].fillna("") + "\n" + papers["abstract"].fillna("")).tolist()

    query = f"""
    Research question: {research_question}

    Research investigating environmental exposures or external
    conditions and geospatial or contextual factors associated
    with this health outcome. Exclude papers focused exclusively
    on clinical treatment or molecular mechanisms.
    """

    query_embedding = model.encode([query])
    paper_embeddings = get_paper_embeddings(texts, cui)

    scores = cosine_similarity(query_embedding, paper_embeddings).ravel()

    ranked = papers.copy()
    ranked["relevance_score"] = scores

    return ranked.nlargest(min(num_papers, len(ranked)), "relevance_score")

def create_prompt(papers, natural_language_query):
    paper_contexts = []
    for _, paper in papers.iterrows():
        title = paper.get("title", "")
        abstract = paper.get("abstract", "")
        if pd.notna(title) and pd.notna(abstract):
            paper_contexts.append(f"TITLE: {title}\nABSTRACT: {abstract}")
    paper_texts = "\n\n".join(paper_contexts)
    prompt = f"RESEARCH QUESTION: {natural_language_query}\n\n{paper_texts}"
    return prompt

def extract_keywords(prompt: str, model_name: str=LLM_MODEL, instructions: str=LLM_INSTRUCTIONS_SEMMED, output_schema: dict=LLM_KEYWORD_SCHEMA) -> dict | None:
    if not prompt:
        return None
    completion = safe_chat(model=model_name, messages=[
        {"role": "system", "content": instructions},
        {"role": "user", "content": prompt}
    ], format=output_schema)
    response = json.loads(completion.message.content)
    return response

def save_results(response):
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    llm_responses_file = RESULTS_DIR / f"llm_responses_{timestamp}.json"
    with open(llm_responses_file, "w", encoding="utf-8") as file:
        json.dump(response, file, indent=4, ensure_ascii=False)
    logger.debug("Saved prompt response to %s", llm_responses_file)

def llm_keywords_pipeline(natural_language_query: str, model_name: str, instructions: str, output_schema: dict, num_papers: int): 
    responses = []
    used_papers = []
    queries = load_queries()
    for query in queries:
        concept = query.get("concept", {})
        cui = concept.get("cui")
        if not cui:
            continue
        papers, matches = load_papers_parquets(cui)
        if papers.empty: 
            continue
        screened_papers = screen_papers(papers, natural_language_query, cui, num_papers).head(num_papers)
        prompt = create_prompt(screened_papers, natural_language_query)
        response = extract_keywords(prompt, model_name, instructions, output_schema)
        responses.append(response)
        used_papers.append(screened_papers)
    save_results(responses)
    return responses, used_papers

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(name)s | %(message)s", datefmt="%H:%M:%S")
    natural_language_query = "Heart disease in California in 2010"
    response, used_papers = llm_keywords_pipeline(natural_language_query, LLM_MODEL, LLM_INSTRUCTIONS_SEMMED, LLM_KEYWORD_SCHEMA, NUM_PAPERS)
    print("\n\n")
    print(used_papers)
    print(response)