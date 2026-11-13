from dateparser.search import search_dates

import re
import pickle
import pandas as pd
from pathlib import Path

from semmed.umls_setup import nlp

   
BASE_DIR = Path(__file__).parent
LOCATIONS_DIR = BASE_DIR / "2026_US_locations"
CATEGORIES_AND_FILENAMES = [("state", LOCATIONS_DIR / "2026_Gaz_state_national.txt"),
    ("county", LOCATIONS_DIR / "2026_Gaz_counties_national.txt"),
    ("place", LOCATIONS_DIR / "2026_Gaz_place_national.txt"),
]
CACHE = LOCATIONS_DIR / Path("US_gazetteer.pkl")

class DateTimeExtractor:
    def extract_dates(self, text: str):
        years = []
        seen = set()
        results = search_dates(text, languages=["en"], settings={"PREFER_DATES_FROM": "past"}) or []
        for _, dt in results:
            year = dt.year

            if 1900 <= year <= 2100 and year not in seen:
                seen.add(year)
                years.append(str(year))

        return years
    
def norm(s):
    s = str(s).lower()
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


class USLocationExtractor:
    def __init__(self):
        if CACHE.exists():
            with CACHE.open("rb") as file:
                self.gazetteer = pickle.load(file)
        else: 
            self.gazetteer = {}
            for category, filename in CATEGORIES_AND_FILENAMES:
                df = pd.read_csv(filename, sep="|", dtype=str)
                for _, row in df.iterrows():
                    name = row["NAME"]
                    key = norm(name)
                    self.gazetteer.setdefault(key, []).append({
                        "name": name,
                        "type": category,
                        "geoid": row.get("GEOID"),
                    })
            # Write pickle file into cache
            with CACHE.open("wb") as file:
                pickle.dump(self.gazetteer, file)

    def extract(self, text, max_words=5):
        words = re.findall(r"\b[\w'-]+\b", text)
        seen = set() # only store unique geoIDs
        found = [] # only store unique values
        for n in range(min(max_words, len(words)), 0, -1):
            for i in range(len(words) - n + 1):
                phrase = " ".join(words[i:i+n])
                for match in self.gazetteer.get(norm(phrase), []):
                    key = (norm(phrase), match["type"], match["geoid"])
                    if key not in seen:
                        seen.add(key)
                        found.append({"mention": phrase, **match})
        return found
    
    def extract_names(self, text, max_words=5):
        locations = self.extract(text, max_words)
        return [location["name"] for location in locations]

class SubjectExtractor:
    def extract_biomed_entities(self, text:str):
        return nlp(text).ents
    def extract_biomed_keywords(self, entities):
        return [entity.text for entity in entities]


class ExtractorPipeline:
    def __init__(self):
        self.dates_extractor = DateTimeExtractor()
        self.locations_extractor = USLocationExtractor()
        self.subject_extractor = SubjectExtractor()
        
    def extract_search_info(self, text:str):
        entities = self.subject_extractor.extract_biomed_entities(text)
        return {
            "natural_language_query": text,
            "dates": self.dates_extractor.extract_dates(text),
            "locations": self.locations_extractor.extract_names(text),
            "entities": entities,
            "keywords": self.subject_extractor.extract_biomed_keywords(entities)
        }

if __name__ == "__main__": # test only this file's components out!
    natural_language_query = "Heart cancer in California in 2010"
    search_info_extractor = ExtractorPipeline()
    search_info = search_info_extractor.extract_search_info(natural_language_query)
    for info_name, info in search_info.items():
        print(f"{info_name}: {info}")