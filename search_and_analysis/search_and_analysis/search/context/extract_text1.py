import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from config import CONTEXT_FILEPATH, CONTEXT_LIMIT

# from docling.document_converter import DocumentConverter #  deeper document understanding, especially layout, reading order, tables, scanned documents, and structured extraction.
#converter = DocumentConverter()
from markitdown import MarkItDown # lightweight conversion of common files into Markdown
converter = MarkItDown()
import logging
logger = logging.getLogger(__name__)


def verify_filepath(filepath: str=CONTEXT_FILEPATH) -> None:
    if not filepath:
        logger.debug("No filepath provided.")
        return None

    path = Path(filepath)
    if not path.is_file():
        logger.warning("File '%s' not found.", path)
        return None

    return path
    
def file_to_markdown(filepath: str, context_limit: int=CONTEXT_LIMIT) -> str:
    """For files with more complex text structures"""
    path = verify_filepath(filepath)
    if path is None:
        return ""
    result = converter.convert(path)
    return result.document.export_to_markdown()[:context_limit]

def file_to_text(filepath: str, context_limit: int=CONTEXT_LIMIT) -> str:
    path = verify_filepath(filepath)
    if path is None:
        return ""
    result = converter.convert(filepath)
    return result.text_content[:context_limit]

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s", datefmt="%H:%M:%S")
    from config import CONTEXT_FILEPATH, CONTEXT_LIMIT 
    #text = file_to_markdown(CONTEXT_FILEPATH, CONTEXT_LIMIT)
    text = file_to_text(CONTEXT_FILEPATH, CONTEXT_LIMIT)
    print(text)