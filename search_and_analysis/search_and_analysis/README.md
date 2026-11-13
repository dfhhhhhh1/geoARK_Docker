# **SEARCH COMPONENT**

Outputs a file with relevant keywords procured by context, online, and semmed & pubmed papers search


## **Context search**

Given user query, user uploaded context file (stored in `/context_files`), extract keywords from context file related to user's query.


## **Online search**

Given a user query, pipeline extracts environmental factor related keywords from online webpage results and returns a list of keywords and their sources.

Ran on Python 3.10.0

### SETUP instructions

1. `python -c "import secrets; print(secrets.token_hex(32))"`
2. Paste into /core-config/settings.yaml "secret_key" your generated secret key
3. `cp .env.example .env`
4. `docker compose up -d`
5. `python -m venv .venv`
6. `.\.venv\Scripts\Activate.ps1`
7. `pip install -r requirements.txt`
8. Change LLM_MODEL in "config0.py" if needed 
9. `ollama pull yourModelName`
10. Open Docker desktop, turn on searxng docker container
11. `python online_rag_pipeline.py`


## **Semmed & pubmed papers search**

Given a user query, pipeline extracts environmental factor related pubmed papers and returns a list of keywords and their sources.

Ran on Python 3.10.0

### SETUP instructions

1. Sign up for NCBI account https://account.ncbi.nlm.nih.gov/
2. Create your API key at https://account.ncbi.nlm.nih.gov/settings/ 
3. In terminal, run `cp .env.example .env`
4. Paste into .env "NCBI_API_KEY" your generated API key
5. `python -m venv .venv`
6. `.\.venv\Scripts\Activate.ps1`
7. `pip install -r requirements.txt`
10. `python semmed_pipeline.py`

&nbsp;

# **ANALYSIS COMPONENT**

Outputs results (prediction values in method_name.csv & accuracy metrics in x_metadata.json)

## **recommendML**

### Tabular ML

* Based on workflow extracted from file `/context_files`, runs extracted classic ML methods like tree models, neural networks, transformers, etc. on data file in `/data`.


### Time series ML

* Based on workflow extracted from file `/context_files`, runs extracted time series ML methods like direct, recursive, autoregressive, statistical, pretrained, etc. on data file in `/data`. 

## **recommend_geospatial**
* Based on workflow extracted from file `/context_files`, runs extracted geospatial analysis methods like Global Moran's I, Local Moran's I, and Getis-Ord Gi*, etc. on data file in `/data`. 
