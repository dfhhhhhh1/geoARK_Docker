from threading import Semaphore
from ollama import chat

_llm_semaphore = Semaphore(1)

def safe_chat(**kwargs):
    with _llm_semaphore:
        return chat(**kwargs)