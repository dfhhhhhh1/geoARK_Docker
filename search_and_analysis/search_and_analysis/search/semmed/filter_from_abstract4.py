import os
import re
import json
import time
import pandas as pd
from pathlib import Path
from dotenv import load_dotenv
from Bio import Entrez
from pprint import pprint
import logging
logger = logging.getLogger(__name__)

load_dotenv()
Entrez.api_key = os.getenv("NCBI_API_KEY")
if not Entrez.api_key:
    raise RuntimeError("Set NCBI_API_KEY in your .env file to get faster 10 requests/sec.")

BASE_DIR = Path(__file__).resolve().parent
RESULTS_DIR = BASE_DIR / "results"
QUERY_FILE = RESULTS_DIR / "queries.json"

COLUMNS = [
    "PMID",
    "publication_year",
    "journal",
    "title",
    "periods",
    "location_match",
    "publication_year_match",
    "period_match",
    "year_match",
    "relationships",
    "abstract",
]

def load_queries():
    try:
        with open(QUERY_FILE, "r", encoding="utf-8") as file:
            return json.load(file)
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Error reading {QUERY_FILE}. Ensure the query-generation script has run successfully.") from exc

def load_causal_relationships(cui):
    path = RESULTS_DIR / cui / "causal_relationships.parquet"
    if not path.exists():
        raise FileNotFoundError(f"Causal relationships file not found: {path}")
    return pd.read_parquet(path)

def extract_pmids(causal_relationships):
    pmid_to_relationships = {}
    for row in causal_relationships.itertuples(index=False):
        raw_pmid = row.PMID
        if pd.isna(raw_pmid):
            continue
        pmid = str(raw_pmid).strip()

        if not pmid or pmid.lower() in {"nan", "none"}:
            continue

        relationship = f"{row.SUBJECT_NAME} --[{row.PREDICATE}]--> {row.OBJECT_NAME}"
        pmid_to_relationships.setdefault(pmid, [])

        if relationship not in pmid_to_relationships[pmid]:
            pmid_to_relationships[pmid].append(relationship)

    return pmid_to_relationships

def fetch_pubmed(pmids, batch_size=100):
    papers = []

    pmids = list(dict.fromkeys(
        str(pmid).strip()
        for pmid in pmids
        if str(pmid).strip().isdigit()
    ))

    for start in range(0, len(pmids), batch_size):
        batch = pmids[start:start + batch_size]

        logger.info(f"\nFetching PMIDs {start + 1}-{min(start + batch_size, len(pmids))} of {len(pmids)}")

        try:
            with Entrez.efetch(
                db="pubmed",
                id=",".join(batch),
                rettype="xml",
                retmode="xml",
            ) as handle:
                data = Entrez.read(handle)

        except Exception as exc:
            logger.exception("Error fetching batch: %s", exc)
            continue

        for article in data.get("PubmedArticle", []):
            citation = article["MedlineCitation"]
            info = citation["Article"]

            pmid = str(citation["PMID"])
            title = str(info.get("ArticleTitle", ""))

            abstract_data = info.get("Abstract", {})
            abstract_parts = []

            for part in abstract_data.get("AbstractText", []):
                text = str(part)
                label = getattr(part, "attributes", {}).get("Label")

                if label:
                    text = f"{label}: {text}"

                abstract_parts.append(text)

            abstract = "\n".join(abstract_parts)

            pub_date = (
                info.get("Journal", {})
                .get("JournalIssue", {})
                .get("PubDate", {})
            )

            year = pub_date.get("Year")

            if not year:
                medline_date = str(pub_date.get("MedlineDate", ""))
                match = re.search(
                    r"\b(?:19|20)\d{2}\b",
                    medline_date,
                )
                year = match.group() if match else None

            publication_year = int(year) if year and str(year).isdigit() else None

            journal = str(info.get("Journal", {}).get("Title", ""))

            papers.append({
                "PMID": pmid,
                "title": title,
                "abstract": abstract,
                "journal": journal,
                "publication_year": publication_year,
            })

        time.sleep(0.11)

    return pd.DataFrame(
        papers,
        columns=[
            "PMID",
            "title",
            "abstract",
            "journal",
            "publication_year",
        ],
    )


# Filter papers by location and year
def filter_papers(papers, pmid_to_relationships, locations, years):
    papers = papers.copy()

    papers["relationships"] = papers["PMID"].map(pmid_to_relationships)

    papers["relationships"] = papers["relationships"].apply(lambda value: value if isinstance(value, list) else [])

    papers["search_text"] = (
        papers["title"].fillna("").astype(str)
        + " "
        + papers["abstract"].fillna("").astype(str)
    )

    valid_locations = [str(location).strip() for location in locations if str(location).strip()]

    if valid_locations:
        location_pattern = re.compile(
            "|".join(
                r"\b" + re.escape(location) + r"\b"
                for location in valid_locations
            ),
            re.IGNORECASE,
        )
        papers["location_match"] = papers["search_text"].apply(lambda text: bool(location_pattern.search(text)))
    else:
        papers["location_match"] = True

    valid_years = {int(year) for year in years if year.strip().isdigit()}
    pattern = (
    r"\b((?:19|20)\d{2})\s*"
    r"(?:-|–|—|to|through|until)\s*"
    r"((?:19|20)\d{2})\b"
    )

    papers["periods"] = papers["search_text"].apply(
        lambda text: [
            (int(a), int(b))
            for a, b in re.findall(pattern, text, re.IGNORECASE)
        ]
    )
    papers["period_match"] = papers["periods"].apply(
        lambda periods: any(
            min(a, b) <= year <= max(a, b)
            for a, b in periods
            for year in valid_years
        )
    )

    papers["publication_year"] = pd.to_numeric(papers["publication_year"], errors="coerce").astype("Int64")
    papers["publication_year_match"] = papers["publication_year"].isin(valid_years)
    papers["year_match"] = papers["period_match"]  | papers["publication_year_match"]
    matches = papers[papers["location_match"] & papers["year_match"]].copy()
    papers.drop(columns=["search_text"], inplace=True)
    matches.drop(columns=["search_text"], inplace=True)

    return papers, matches


def save_results(cui, papers, matches):
    output_dir = RESULTS_DIR / cui
    output_dir.mkdir(parents=True, exist_ok=True)

    papers.reindex(columns=COLUMNS).to_parquet(output_dir / "all_papers.parquet", index=False)
    matches.reindex(columns=COLUMNS).to_parquet(output_dir / "filtered_papers.parquet", index=False)

    logger.info("Saved all papers: %s/all_papers.parquet", output_dir)
    logger.info("Saved filtered papers: %s/filtered_papers.parquet", output_dir)


def filter_abstracts_pipeline():
    queries = load_queries()

    for query in queries:
        concept = query.get("concept", {})
        cui = concept.get("cui")
        if not cui:
            continue
        years = query.get("dates", [])
        locations = query.get("location", [])

        try:
            causal_relationships = load_causal_relationships(cui)
        except FileNotFoundError as exc:
            logger.warning(exc)
            continue

        pmid_to_relationships = extract_pmids(causal_relationships)

        if not pmid_to_relationships:
            logger.warning("No valid PMIDs found for CUI %s.", cui)
            continue

        papers = fetch_pubmed(list(pmid_to_relationships.keys()))

        if papers.empty:
            logger.warning("No PubMed articles retrieved for CUI %s.", cui)
            continue

        papers, matches = filter_papers(papers, pmid_to_relationships, locations, years)
        
        save_results(cui, papers, matches)
        return papers, matches


if __name__ == "__main__":
    papers, matches = filter_abstracts_pipeline()
    pprint(papers.to_dict(orient="records"), sort_dicts=False)
    print(f"Total papers retrieved: {len(papers)}")
    print(f"Papers matching filters: {len(matches)}")