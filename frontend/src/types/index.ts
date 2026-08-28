export interface Dataset {
  id: string;
  title: string;
  description: string;
  source: string;
  fields: string[];
  tags: string[];
  fileSize: string;
  lastUpdated: string;
  coverage: {
    geographic: string;
    temporal: string;
  };
  coordinates: {
    lat: number;
    lng: number;
  };
  boundingBox: {
    north: number;
    south: number;
    east: number;
    west: number;
  };
  downloadUrl: string;
  previewUrl?: string;
  // New fields from backend API
  variables?: Variable[];
  entityType?: string;
  similarity?: number;
}

export interface Variable {
  id: string;
  label: string;
  description: string;
  similarity: number;
}

export interface CartItem {
  dataset: Dataset;
  quantity: number;
  addedAt: Date;
}

export interface SearchFilters {
  dataType?: string[];
  dateRange?: {
    start: string;
    end: string;
  };
  geographicArea?: string;
  fileFormat?: string[];
}

// Backend API response interface (old simple search)
export interface BackendSearchResult {
  dataset_id: string;
  attr_id: string;
  attr_label: string;
  attr_desc: string;
  tags: string;
  entity_type: string;
  start_date: string;
  end_date: string;
  similarity: number;
  embeddingText: string;
}

// ============================================================
// Unified Search Response Types (NEW)
// ============================================================

export interface UnifiedSearchDecomposition {
  primary_concepts: string[];
  normalization_concepts: string[];
  filter_concepts: string[];
  geographic_level: string;
  search_queries: Array<{
    query: string;
    purpose: string;
  }>;
}

export interface UnifiedSearchResultItem {
  dataset_id: string;
  table_name: string;
  attr_id: string;
  attr_orig: string;
  dataset_clean: string;
  attr_desc: string;
  tags: string;
  entity_type: string;
  spatial_rep: string;
  source_folder: string;
  semantic_score: number;
  keyword_score: number;
  hybrid_score: number;
  search_purpose: string;
}

export interface UnifiedSearchResultsByQuery {
  query: string;
  purpose: string;
  results: UnifiedSearchResultItem[];
}

export interface UnifiedSearchResultsByPurpose {
  primary: UnifiedSearchResultItem[];
  normalization: UnifiedSearchResultItem[];
  filter: UnifiedSearchResultItem[];
  related: UnifiedSearchResultItem[];
}

export interface UnifiedSearchStats {
  total_results: number;
  unique_results: number;
  primary_count: number;
  normalization_count: number;
  filter_count: number;
  processing_time_ms: number;
  llm_filtered: boolean;
  fallback_used: boolean;
}

export interface UnifiedSearchResponse {
  query: string;
  decomposition: UnifiedSearchDecomposition;
  results_by_query: UnifiedSearchResultsByQuery[];
  results_by_purpose: UnifiedSearchResultsByPurpose;
  all_results: UnifiedSearchResultItem[];
  llm_reasoning?: string | null;
  stats: UnifiedSearchStats;
}