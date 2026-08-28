#!/usr/bin/env python3
"""
Enhanced Geospatial Search System with LangGraph
=================================================

This module provides:
1. Query decomposition - splits complex queries into multiple variable searches
2. PostGIS database integration - searches metadata and data tables
3. LangGraph-based agent orchestration for multi-step searches

Author: Claude (based on Sam Spell's geospatial_etl.py)
Date: 2025
"""

import os
import json
import logging
from typing import Dict, List, Optional, Any, TypedDict, Annotated
from dataclasses import dataclass
from enum import Enum

import psycopg2
from psycopg2 import sql
from psycopg2.extras import RealDictCursor
from sqlalchemy import create_engine, text
import pandas as pd

# LangChain/LangGraph imports
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage
from langchain_core.prompts import ChatPromptTemplate, PromptTemplate
from langchain_core.output_parsers import JsonOutputParser
from langchain_core.tools import tool
from langchain_ollama import ChatOllama, OllamaEmbeddings
from langgraph.graph import StateGraph, END
from langgraph.prebuilt import ToolNode

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


# =============================================================================
# Configuration
# =============================================================================

@dataclass
class DatabaseConfig:
    """Database connection configuration."""
    host: str = "localhost"
    port: str = "5432"
    database: str = "mygisdb"
    user: str = "samspell"
    password: str = ""
    
    @property
    def connection_string(self) -> str:
        if self.password:
            return f"postgresql://{self.user}:{self.password}@{self.host}:{self.port}/{self.database}"
        return f"postgresql://{self.user}@{self.host}:{self.port}/{self.database}"


@dataclass
class LLMConfig:
    """LLM configuration."""
    model: str = "gemma3:4b"
    base_url: str = "http://localhost:11434"
    temperature: float = 0.2
    embedding_model: str = "nomic-embed-text"


# =============================================================================
# State Types for LangGraph
# =============================================================================

class SearchState(TypedDict):
    """State object for the search graph."""
    original_query: str
    decomposed_queries: List[Dict[str, Any]]
    variable_results: List[Dict[str, Any]]
    database_results: List[Dict[str, Any]]
    final_results: Dict[str, Any]
    errors: List[str]
    messages: List[Any]


# =============================================================================
# PostGIS Database Tools
# =============================================================================

class PostGISSearcher:
    """
    Handles all PostGIS database interactions for geospatial search.
    
    Searches the metadata table created by geospatial_etl.py and 
    executes queries against the actual data tables.
    """
    
    def __init__(self, db_config: DatabaseConfig):
        self.db_config = db_config
        self.conn = None
        self.engine = None
        
    def connect(self):
        """Establish database connection."""
        try:
            self.conn = psycopg2.connect(
                host=self.db_config.host,
                port=self.db_config.port,
                database=self.db_config.database,
                user=self.db_config.user,
                password=self.db_config.password
            )
            self.engine = create_engine(self.db_config.connection_string)
            logger.info("PostGIS connection established")
        except Exception as e:
            logger.error(f"Failed to connect to PostGIS: {e}")
            raise
            
    def disconnect(self):
        """Close database connection."""
        if self.conn:
            self.conn.close()
        if self.engine:
            self.engine.dispose()
        logger.info("PostGIS connection closed")
        
    def search_metadata(
        self, 
        search_terms: List[str],
        geometry_type: Optional[str] = None,
        limit: int = 20
    ) -> List[Dict[str, Any]]:
        """
        Search the dataset_metadata table for matching datasets.
        
        Args:
            search_terms: List of terms to search for in dataset names and columns
            geometry_type: Optional filter for geometry type (POLYGON, POINT, etc.)
            limit: Maximum number of results
            
        Returns:
            List of matching dataset metadata records
        """
        try:
            with self.conn.cursor(cursor_factory=RealDictCursor) as cursor:
                # Build search conditions for each term
                conditions = []
                params = []
                
                for term in search_terms:
                    term_pattern = f"%{term.lower()}%"
                    conditions.append("""
                        (LOWER(dataset_name) LIKE %s 
                         OR LOWER(table_name) LIKE %s 
                         OR EXISTS (
                             SELECT 1 FROM unnest(column_list) AS col 
                             WHERE LOWER(col) LIKE %s
                         ))
                    """)
                    params.extend([term_pattern, term_pattern, term_pattern])
                
                # Build the full query
                where_clause = " OR ".join(conditions)
                
                if geometry_type:
                    where_clause = f"({where_clause}) AND geometry_type = %s"
                    params.append(geometry_type)
                
                query = f"""
                    SELECT 
                        id,
                        dataset_name,
                        table_name,
                        source_path,
                        geometry_type,
                        row_count,
                        column_list,
                        crs,
                        bbox,
                        date_ingested
                    FROM dataset_metadata
                    WHERE {where_clause}
                    ORDER BY row_count DESC NULLS LAST
                    LIMIT %s
                """
                params.append(limit)
                
                cursor.execute(query, params)
                results = cursor.fetchall()
                
                return [dict(row) for row in results]
                
        except Exception as e:
            logger.error(f"Metadata search failed: {e}")
            self.conn.rollback()
            return []
    
    def search_columns(
        self,
        column_patterns: List[str],
        limit: int = 50
    ) -> List[Dict[str, Any]]:
        """
        Search for specific columns across all tables in metadata.
        
        Args:
            column_patterns: List of column name patterns to search
            limit: Maximum number of results
            
        Returns:
            List of dicts with table_name, matching_columns
        """
        try:
            with self.conn.cursor(cursor_factory=RealDictCursor) as cursor:
                results = []
                
                for pattern in column_patterns:
                    query = """
                        SELECT 
                            table_name,
                            dataset_name,
                            geometry_type,
                            array_agg(col) as matching_columns
                        FROM dataset_metadata,
                             unnest(column_list) AS col
                        WHERE LOWER(col) LIKE %s
                        GROUP BY table_name, dataset_name, geometry_type
                        LIMIT %s
                    """
                    cursor.execute(query, (f"%{pattern.lower()}%", limit))
                    
                    for row in cursor.fetchall():
                        results.append({
                            'table_name': row['table_name'],
                            'dataset_name': row['dataset_name'],
                            'geometry_type': row['geometry_type'],
                            'matching_columns': row['matching_columns'],
                            'search_pattern': pattern
                        })
                
                return results
                
        except Exception as e:
            logger.error(f"Column search failed: {e}")
            self.conn.rollback()
            return []
    
    def get_table_sample(
        self,
        table_name: str,
        columns: Optional[List[str]] = None,
        limit: int = 5
    ) -> pd.DataFrame:
        """
        Get a sample of data from a specific table.
        
        Args:
            table_name: Name of the table to sample
            columns: Specific columns to select (None for all)
            limit: Number of rows to return
            
        Returns:
            DataFrame with sample data
        """
        try:
            if columns:
                col_str = ", ".join([f'"{c}"' for c in columns])
            else:
                col_str = "*"
                
            query = f'SELECT {col_str} FROM "{table_name}" LIMIT {limit}'
            return pd.read_sql(query, self.engine)
            
        except Exception as e:
            logger.error(f"Failed to sample table {table_name}: {e}")
            return pd.DataFrame()
    
    def execute_spatial_query(
        self,
        table_name: str,
        geom_column: str = "geom",
        bbox: Optional[tuple] = None,
        attributes: Optional[List[str]] = None,
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        """
        Execute a spatial query on a PostGIS table.
        
        Args:
            table_name: Name of the table
            geom_column: Name of the geometry column
            bbox: Optional bounding box (minx, miny, maxx, maxy)
            attributes: List of attribute columns to select
            limit: Maximum number of results
            
        Returns:
            List of feature dictionaries
        """
        try:
            with self.conn.cursor(cursor_factory=RealDictCursor) as cursor:
                # Build attribute selection
                if attributes:
                    attr_str = ", ".join([f'"{a}"' for a in attributes])
                else:
                    attr_str = "*"
                
                # Base query
                query_parts = [f'SELECT {attr_str}, ST_AsGeoJSON("{geom_column}") as geometry']
                query_parts.append(f'FROM "{table_name}"')
                
                params = []
                
                # Add bbox filter if provided
                if bbox:
                    minx, miny, maxx, maxy = bbox
                    query_parts.append(f"""
                        WHERE "{geom_column}" && ST_MakeEnvelope(%s, %s, %s, %s, 4326)
                    """)
                    params.extend([minx, miny, maxx, maxy])
                
                query_parts.append(f"LIMIT %s")
                params.append(limit)
                
                query = " ".join(query_parts)
                cursor.execute(query, params)
                
                results = []
                for row in cursor.fetchall():
                    row_dict = dict(row)
                    # Parse geometry JSON
                    if row_dict.get('geometry'):
                        row_dict['geometry'] = json.loads(row_dict['geometry'])
                    results.append(row_dict)
                
                return results
                
        except Exception as e:
            logger.error(f"Spatial query failed: {e}")
            self.conn.rollback()
            return []
    
    def join_tables_by_fips(
        self,
        table1: str,
        table2: str,
        fips_column1: str = "fips",
        fips_column2: str = "fips",
        select_columns: Optional[Dict[str, List[str]]] = None,
        limit: int = 100
    ) -> pd.DataFrame:
        """
        Join two tables by FIPS code.
        
        Args:
            table1: First table name
            table2: Second table name
            fips_column1: FIPS column name in first table
            fips_column2: FIPS column name in second table
            select_columns: Dict mapping table name to list of columns to select
            limit: Maximum rows to return
            
        Returns:
            DataFrame with joined data
        """
        try:
            # Build column selection
            cols = []
            if select_columns:
                for tbl, columns in select_columns.items():
                    for col in columns:
                        cols.append(f'"{tbl}"."{col}" as "{tbl}_{col}"')
            else:
                cols = [f'"{table1}".*', f'"{table2}".*']
            
            col_str = ", ".join(cols)
            
            query = f"""
                SELECT {col_str}
                FROM "{table1}"
                INNER JOIN "{table2}" 
                    ON "{table1}"."{fips_column1}" = "{table2}"."{fips_column2}"
                LIMIT {limit}
            """
            
            return pd.read_sql(query, self.engine)
            
        except Exception as e:
            logger.error(f"Table join failed: {e}")
            return pd.DataFrame()
    
    def get_statistics(
        self,
        table_name: str,
        column: str,
        group_by: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Get statistics for a numeric column.
        
        Args:
            table_name: Name of the table
            column: Column to analyze
            group_by: Optional column to group by
            
        Returns:
            Dict with statistical measures
        """
        try:
            with self.conn.cursor(cursor_factory=RealDictCursor) as cursor:
                if group_by:
                    query = f"""
                        SELECT 
                            "{group_by}",
                            COUNT("{column}") as count,
                            AVG("{column}"::numeric) as mean,
                            MIN("{column}"::numeric) as min,
                            MAX("{column}"::numeric) as max,
                            STDDEV("{column}"::numeric) as stddev,
                            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "{column}"::numeric) as median
                        FROM "{table_name}"
                        WHERE "{column}" IS NOT NULL
                        GROUP BY "{group_by}"
                        ORDER BY "{group_by}"
                    """
                else:
                    query = f"""
                        SELECT 
                            COUNT("{column}") as count,
                            AVG("{column}"::numeric) as mean,
                            MIN("{column}"::numeric) as min,
                            MAX("{column}"::numeric) as max,
                            STDDEV("{column}"::numeric) as stddev,
                            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "{column}"::numeric) as median
                        FROM "{table_name}"
                        WHERE "{column}" IS NOT NULL
                    """
                
                cursor.execute(query)
                result = cursor.fetchone() if not group_by else cursor.fetchall()
                
                if group_by:
                    return {'grouped_statistics': [dict(r) for r in result]}
                return dict(result)
                
        except Exception as e:
            logger.error(f"Statistics query failed: {e}")
            self.conn.rollback()
            return {}


# =============================================================================
# Query Decomposition Agent
# =============================================================================

class QueryDecomposer:
    """
    Uses LLM to decompose complex queries into multiple search terms.
    
    Example:
        "Show me poverty rates normalized by population for rural counties"
        ->
        [
            {"concept": "poverty rates", "type": "primary"},
            {"concept": "population", "type": "normalization"},
            {"concept": "rural", "type": "filter"},
            {"concept": "counties", "type": "geography"}
        ]
    """
    
    DECOMPOSITION_PROMPT = """You are a geospatial data analyst expert. Your task is to decompose a natural language query into multiple searchable concepts.

Given a user query about geospatial or demographic data, identify:
1. PRIMARY variables - The main data the user wants (e.g., poverty rates, income, housing)
2. NORMALIZATION variables - Data needed to normalize/compute ratios (e.g., population, area)
3. FILTER variables - Criteria for filtering results (e.g., rural, urban, above threshold)
4. GEOGRAPHIC scope - The geographic level (county, state, tract, block group)
5. TEMPORAL scope - Time period if mentioned
6. RELATED concepts - Variables that might be semantically related to expand the search

Return a JSON object with this structure:
{{
    "primary_concepts": ["concept1", "concept2"],
    "normalization_concepts": ["concept1"],
    "filter_concepts": ["concept1"],
    "geographic_level": "county|state|tract|blockgroup|null",
    "temporal_filter": {{"start": "year", "end": "year"}} or null,
    "related_concepts": ["concept1", "concept2"],
    "search_queries": [
        {{"query": "search term 1", "purpose": "primary|normalization|filter|related"}},
        {{"query": "search term 2", "purpose": "primary|normalization|filter|related"}}
    ]
}}

User Query: {query}

Return ONLY valid JSON, no other text."""

    def __init__(self, llm_config: LLMConfig):
        self.llm = ChatOllama(
            model=llm_config.model,
            base_url=llm_config.base_url,
            temperature=llm_config.temperature
        )
        self.parser = JsonOutputParser()
        
    async def decompose(self, query: str) -> Dict[str, Any]:
        """
        Decompose a natural language query into searchable concepts.
        
        Args:
            query: The user's natural language query
            
        Returns:
            Dict with decomposed query components
        """
        try:
            prompt = self.DECOMPOSITION_PROMPT.format(query=query)
            response = await self.llm.ainvoke(prompt)
            
            # Extract content from response
            content = response.content if hasattr(response, 'content') else str(response)
            
            # Parse JSON from response
            json_match = content
            if "```json" in content:
                json_match = content.split("```json")[1].split("```")[0]
            elif "```" in content:
                json_match = content.split("```")[1].split("```")[0]
            
            result = json.loads(json_match.strip())
            logger.info(f"Decomposed query into {len(result.get('search_queries', []))} search terms")
            return result
            
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse decomposition JSON: {e}")
            # Return a basic decomposition
            return {
                "primary_concepts": [query],
                "search_queries": [{"query": query, "purpose": "primary"}]
            }
        except Exception as e:
            logger.error(f"Query decomposition failed: {e}")
            return {
                "primary_concepts": [query],
                "search_queries": [{"query": query, "purpose": "primary"}]
            }
    
    def decompose_sync(self, query: str) -> Dict[str, Any]:
        """Synchronous version of decompose."""
        import asyncio
        return asyncio.run(self.decompose(query))


# =============================================================================
# LangGraph Tool Definitions
# =============================================================================

def create_search_tools(postgis_searcher: PostGISSearcher, decomposer: QueryDecomposer):
    """Create LangChain tools for the search agent."""
    
    @tool
    def search_metadata(search_terms: str, geometry_type: str = None) -> str:
        """
        Search the PostGIS metadata catalog for datasets matching the search terms.
        
        Args:
            search_terms: Comma-separated list of terms to search for
            geometry_type: Optional geometry filter (POLYGON, POINT, MULTIPOLYGON)
            
        Returns:
            JSON string of matching datasets
        """
        terms = [t.strip() for t in search_terms.split(",")]
        results = postgis_searcher.search_metadata(
            terms, 
            geometry_type=geometry_type if geometry_type else None
        )
        return json.dumps(results, indent=2, default=str)
    
    @tool
    def search_columns(column_patterns: str) -> str:
        """
        Search for specific column names across all tables.
        
        Args:
            column_patterns: Comma-separated list of column name patterns
            
        Returns:
            JSON string of tables with matching columns
        """
        patterns = [p.strip() for p in column_patterns.split(",")]
        results = postgis_searcher.search_columns(patterns)
        return json.dumps(results, indent=2, default=str)
    
    @tool
    def get_table_sample(table_name: str, columns: str = None) -> str:
        """
        Get a sample of data from a specific table.
        
        Args:
            table_name: Name of the table to sample
            columns: Optional comma-separated list of columns
            
        Returns:
            JSON string of sample data
        """
        cols = [c.strip() for c in columns.split(",")] if columns else None
        df = postgis_searcher.get_table_sample(table_name, cols)
        return df.to_json(orient='records', indent=2)
    
    @tool
    def get_column_statistics(table_name: str, column: str, group_by: str = None) -> str:
        """
        Get statistical summary for a numeric column.
        
        Args:
            table_name: Name of the table
            column: Column to analyze
            group_by: Optional column to group statistics by
            
        Returns:
            JSON string with statistics
        """
        results = postgis_searcher.get_statistics(
            table_name, 
            column, 
            group_by=group_by if group_by else None
        )
        return json.dumps(results, indent=2, default=str)
    
    @tool
    def decompose_query(query: str) -> str:
        """
        Decompose a complex natural language query into multiple search concepts.
        
        Args:
            query: The natural language query to decompose
            
        Returns:
            JSON string with decomposed search terms
        """
        result = decomposer.decompose_sync(query)
        return json.dumps(result, indent=2)
    
    @tool
    def join_datasets(
        table1: str, 
        table2: str, 
        join_column: str = "fips"
    ) -> str:
        """
        Join two tables by a common identifier (typically FIPS code).
        
        Args:
            table1: First table name
            table2: Second table name  
            join_column: Column to join on (default: fips)
            
        Returns:
            JSON string with sample of joined data
        """
        df = postgis_searcher.join_tables_by_fips(
            table1, table2,
            fips_column1=join_column,
            fips_column2=join_column,
            limit=10
        )
        return df.to_json(orient='records', indent=2)
    
    return [
        search_metadata,
        search_columns,
        get_table_sample,
        get_column_statistics,
        decompose_query,
        join_datasets
    ]


# =============================================================================
# LangGraph Search Agent
# =============================================================================

class GeospatialSearchAgent:
    """
    LangGraph-based agent for intelligent geospatial data search.
    
    Orchestrates:
    1. Query decomposition
    2. Parallel variable searches
    3. Database searches
    4. Result aggregation
    """
    
    AGENT_SYSTEM_PROMPT = """You are an expert geospatial data analyst assistant. Your role is to help users find and analyze geospatial datasets.

You have access to the following tools:
- decompose_query: Break complex queries into searchable concepts
- search_metadata: Search the dataset catalog
- search_columns: Find specific columns across tables
- get_table_sample: Preview data from a table
- get_column_statistics: Get statistics for numeric columns
- join_datasets: Join tables by FIPS or other identifiers

When a user asks a question:
1. First decompose the query to understand what variables are needed
2. Search for each required variable type (primary, normalization, etc.)
3. Identify the best matching datasets
4. If the user needs normalized data (e.g., "per capita"), find both the numerator and denominator
5. Provide clear recommendations on which datasets to use

Always explain your reasoning and provide actionable next steps."""

    def __init__(
        self, 
        db_config: DatabaseConfig,
        llm_config: LLMConfig
    ):
        self.db_config = db_config
        self.llm_config = llm_config
        
        # Initialize components
        self.postgis = PostGISSearcher(db_config)
        self.decomposer = QueryDecomposer(llm_config)
        
        # Initialize LLM
        self.llm = ChatOllama(
            model=llm_config.model,
            base_url=llm_config.base_url,
            temperature=llm_config.temperature
        )
        
        # Create tools
        self.tools = create_search_tools(self.postgis, self.decomposer)
        
        # Build graph
        self.graph = self._build_graph()
        
    def _build_graph(self) -> StateGraph:
        """Build the LangGraph workflow."""
        
        # Define the graph
        workflow = StateGraph(SearchState)
        
        # Add nodes
        workflow.add_node("decompose", self._decompose_node)
        workflow.add_node("search_variables", self._search_variables_node)
        workflow.add_node("search_database", self._search_database_node)
        workflow.add_node("aggregate_results", self._aggregate_results_node)
        
        # Define edges
        workflow.set_entry_point("decompose")
        workflow.add_edge("decompose", "search_variables")
        workflow.add_edge("search_variables", "search_database")
        workflow.add_edge("search_database", "aggregate_results")
        workflow.add_edge("aggregate_results", END)
        
        return workflow.compile()
    
    async def _decompose_node(self, state: SearchState) -> SearchState:
        """Decompose the query into searchable concepts."""
        try:
            decomposed = await self.decomposer.decompose(state["original_query"])
            state["decomposed_queries"] = decomposed.get("search_queries", [])
            logger.info(f"Decomposed into {len(state['decomposed_queries'])} queries")
        except Exception as e:
            state["errors"].append(f"Decomposition error: {str(e)}")
            state["decomposed_queries"] = [
                {"query": state["original_query"], "purpose": "primary"}
            ]
        return state
    
    async def _search_variables_node(self, state: SearchState) -> SearchState:
        """Search for variables matching each decomposed query."""
        results = []
        
        for query_item in state["decomposed_queries"]:
            query = query_item.get("query", "")
            purpose = query_item.get("purpose", "unknown")
            
            try:
                # Search metadata
                matches = self.postgis.search_metadata([query], limit=10)
                
                for match in matches:
                    match["search_query"] = query
                    match["search_purpose"] = purpose
                    results.append(match)
                    
            except Exception as e:
                state["errors"].append(f"Variable search error for '{query}': {str(e)}")
        
        state["variable_results"] = results
        logger.info(f"Found {len(results)} variable matches")
        return state
    
    async def _search_database_node(self, state: SearchState) -> SearchState:
        """Search the database for relevant data."""
        results = []
        
        # Get unique table names from variable results
        tables = set()
        for var in state["variable_results"]:
            if var.get("table_name"):
                tables.add(var["table_name"])
        
        for table_name in list(tables)[:5]:  # Limit to top 5 tables
            try:
                # Get sample data
                sample = self.postgis.get_table_sample(table_name, limit=3)
                
                results.append({
                    "table_name": table_name,
                    "sample_data": sample.to_dict(orient='records') if not sample.empty else [],
                    "columns": list(sample.columns) if not sample.empty else []
                })
                
            except Exception as e:
                state["errors"].append(f"Database search error for '{table_name}': {str(e)}")
        
        state["database_results"] = results
        logger.info(f"Retrieved data from {len(results)} tables")
        return state
    
    async def _aggregate_results_node(self, state: SearchState) -> SearchState:
        """Aggregate and format final results."""
        
        # Group results by purpose
        by_purpose = {}
        for var in state["variable_results"]:
            purpose = var.get("search_purpose", "unknown")
            if purpose not in by_purpose:
                by_purpose[purpose] = []
            by_purpose[purpose].append(var)
        
        # Create summary
        state["final_results"] = {
            "query": state["original_query"],
            "decomposition": state["decomposed_queries"],
            "results_by_purpose": by_purpose,
            "available_tables": [r["table_name"] for r in state["database_results"]],
            "total_matches": len(state["variable_results"]),
            "errors": state["errors"]
        }
        
        return state
    
    def connect(self):
        """Connect to the database."""
        self.postgis.connect()
        
    def disconnect(self):
        """Disconnect from the database."""
        self.postgis.disconnect()
    
    async def search(self, query: str) -> Dict[str, Any]:
        """
        Execute a search query.
        
        Args:
            query: Natural language search query
            
        Returns:
            Dict with search results
        """
        initial_state: SearchState = {
            "original_query": query,
            "decomposed_queries": [],
            "variable_results": [],
            "database_results": [],
            "final_results": {},
            "errors": [],
            "messages": []
        }
        
        # Run the graph
        final_state = await self.graph.ainvoke(initial_state)
        
        return final_state["final_results"]
    
    def search_sync(self, query: str) -> Dict[str, Any]:
        """Synchronous version of search."""
        import asyncio
        return asyncio.run(self.search(query))


# =============================================================================
# Express.js Compatible API Functions (for Node.js integration)
# =============================================================================

def create_api_functions(agent: GeospatialSearchAgent) -> Dict[str, callable]:
    """
    Create functions that can be called from a Node.js/Express server.
    
    These functions accept JSON strings and return JSON strings,
    making them easy to integrate with the existing geospatial_server.js
    """
    
    def decompose_query_api(query_json: str) -> str:
        """
        API function for query decomposition.
        
        Input: {"query": "your query here"}
        Output: {"primary_concepts": [...], "search_queries": [...], ...}
        """
        try:
            data = json.loads(query_json)
            query = data.get("query", "")
            result = agent.decomposer.decompose_sync(query)
            return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": str(e)})
    
    def search_metadata_api(query_json: str) -> str:
        """
        API function for metadata search.
        
        Input: {"terms": ["term1", "term2"], "geometry_type": "POLYGON" (optional)}
        Output: [{"dataset_name": ..., "table_name": ..., ...}, ...]
        """
        try:
            data = json.loads(query_json)
            terms = data.get("terms", [])
            geom_type = data.get("geometry_type")
            result = agent.postgis.search_metadata(terms, geometry_type=geom_type)
            return json.dumps(result, default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})
    
    def full_search_api(query_json: str) -> str:
        """
        API function for full search pipeline.
        
        Input: {"query": "your natural language query"}
        Output: Full search results with decomposition and matches
        """
        try:
            data = json.loads(query_json)
            query = data.get("query", "")
            result = agent.search_sync(query)
            return json.dumps(result, default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})
    
    return {
        "decompose_query": decompose_query_api,
        "search_metadata": search_metadata_api,
        "full_search": full_search_api
    }


# =============================================================================
# Main Entry Point
# =============================================================================

def main():
    """Example usage of the enhanced search system."""
    
    # Configuration
    db_config = DatabaseConfig(
        host="localhost",
        port="5432",
        database="mygisdb",
        user="samspell",
        password=""
    )
    
    llm_config = LLMConfig(
        model="llama3.1",
        base_url="http://localhost:11434",
        temperature=0.2
    )
    
    # Create agent
    agent = GeospatialSearchAgent(db_config, llm_config)
    
    try:
        # Connect to database
        agent.connect()
        
        # Example query
        query = "Show me poverty rates normalized by population for rural counties in the Midwest"
        
        print(f"\n{'='*80}")
        print(f"Query: {query}")
        print(f"{'='*80}\n")
        
        # Execute search
        results = agent.search_sync(query)
        
        # Print results
        print("Decomposition:")
        print(json.dumps(results.get("decomposition", []), indent=2))
        
        print(f"\nTotal Matches: {results.get('total_matches', 0)}")
        
        print("\nResults by Purpose:")
        for purpose, vars in results.get("results_by_purpose", {}).items():
            print(f"  {purpose}: {len(vars)} matches")
            for var in vars[:3]:  # Show top 3
                print(f"    - {var.get('dataset_name')}: {var.get('table_name')}")
        
        if results.get("errors"):
            print("\nErrors:")
            for error in results["errors"]:
                print(f"  - {error}")
                
    finally:
        agent.disconnect()


if __name__ == "__main__":
    main()
