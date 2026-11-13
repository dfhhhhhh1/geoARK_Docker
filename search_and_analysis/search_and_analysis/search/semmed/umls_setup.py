import spacy
import scispacy
import scispacy.linking
import logging
logger = logging.getLogger(__name__)

logger.info("Loading spaCy model...")
nlp = spacy.load("en_core_sci_sm")

logger.info("Loading scispacy UMLS linker...")
nlp.add_pipe("scispacy_linker",
    config={
        "resolve_abbreviations": True,
        "linker_name": "umls",
    },
)

linker = nlp.get_pipe("scispacy_linker")

logger.info("scispacy UMLS linker ready!")
