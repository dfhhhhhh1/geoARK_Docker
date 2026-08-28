CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Catalog of searchable variables. Replaces the in-memory arrays in the Node
-- process: 4,555 JS cosine loops become one indexed SQL query, and the API
-- becomes stateless (so it starts instantly).
CREATE TABLE IF NOT EXISTS attribute_embeddings (
    attr_id     TEXT PRIMARY KEY,
    dataset_id  TEXT NOT NULL,
    label       TEXT,
    description TEXT,
    tags        TEXT[],
    entity_type TEXT,
    start_date  TEXT,
    end_date    TEXT,
    embedding   vector(768),
    tsv tsvector GENERATED ALWAYS AS (
        to_tsvector('english',
            coalesce(label, '') || ' ' || coalesce(description, ''))
    ) STORED
);

CREATE INDEX IF NOT EXISTS idx_attr_emb_hnsw
    ON attribute_embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_attr_emb_tsv
    ON attribute_embeddings USING gin (tsv);
CREATE INDEX IF NOT EXISTS idx_attr_emb_dataset
    ON attribute_embeddings (dataset_id);

-- MISSING LINK (see docs/ARCHITECTURE.md §4): nothing today maps a retrieved
-- attr_id to a physical PostGIS table, which is why generated DAGs cannot run.
-- Populate this and the planner becomes executable.
CREATE TABLE IF NOT EXISTS dataset_table_map (
    dataset_id   TEXT PRIMARY KEY,
    table_name   TEXT NOT NULL,
    geom_column  TEXT DEFAULT 'geom',
    fips_column  TEXT,
    entity_type  TEXT
);
