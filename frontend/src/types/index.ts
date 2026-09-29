/**
 * A catalog entry as the search UI shows it.
 *
 * fileSize, coordinates and boundingBox are optional because nothing produces
 * them. They used to be filled by generateMockCoordinates() and
 * estimateFileSize() in App.tsx, which derived plausible-looking values from a
 * hash of the dataset id, and the UI presented those as facts. Invented
 * positions rendered on a map beside real ones is worse than showing nothing,
 * so the generators are gone and these stay optional for whenever a real source
 * exists.
 *
 * downloadUrl and previewUrl are likewise optional: they pointed at
 * /api/download and /api/preview, neither of which the backend implements.
 */
export interface Dataset {
  id: string;
  title: string;
  description: string;
  source: string;
  fields: string[];
  tags: string[];
  fileSize?: string;
  lastUpdated: string;
  coverage: {
    geographic: string;
    temporal: string;
  };
  coordinates?: {
    lat: number;
    lng: number;
  };
  boundingBox?: {
    north: number;
    south: number;
    east: number;
    west: number;
  };
  downloadUrl?: string;
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
  /** Literature expansion (backend/expansion.js); absent on older servers. */
  expanded?: UnifiedSearchResultItem[];
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

// ============================================================
// Analysis (POST /api/analyze, GET /api/analyze/stream)
// ============================================================

/** One step of an executable plan. Fields beyond id/op/inputs are op-specific. */
export type PlanOp =
  | 'load' | 'count_features' | 'count_near' | 'nearest_distance'
  | 'select_features'
  | 'filter_attr' | 'filter_area' | 'filter_place' | 'per_area'
  | 'normalize' | 'aggregate' | 'rank' | 'join' | 'combine'
  | 'hotspot' | 'outlier' | 'correlate' | 'explain' | 'output';

/**
 * One returned result. A plan with several `output` steps produces several.
 *
 * `diverging` is declared by the operator that produced the layer, not inferred
 * from the values: hotspot and outlier emit numbers signed around zero, and a
 * run that happens to be all-positive is still a diverging measure.
 */
export interface AnalysisLayer {
  id: string;
  step: string;
  op: PlanOp;
  /**
   * True for an input the compiler surfaced beside an arithmetic result. A
   * difference or a ratio is not interpretable alone -- the same value arises
   * from opposite situations -- so its two parts come back as layers too.
   */
  part?: boolean;
  mode: 'values' | 'features';
  series?: number;
  diverging?: boolean;
  value_label?: string | null;
  row_count: number;
  rows?: AnalysisRow[];
  features?: MappedFeature[];
}

/**
 * A single mapped location. Properties vary by layer -- only about half carry
 * `name`, 41% carry `city` -- so every field is optional by construction.
 */
export interface MappedFeature {
  type: 'Feature';
  geometry: GeoJSON.Geometry;
  properties: Record<string, string | null>;
}

export interface PlanStep {
  id: string;
  op: PlanOp;
  attr_id: string;
  inputs: string[];
  scale?: number;
  operator?: string;
  value?: number;
  function?: string;
  direction?: 'asc' | 'desc';
  limit?: number;
  group_by?: string;
  /** count_near: the dataset proximity is measured TO. */
  near_attr_id?: string;
  /** count_near: radius in miles. */
  miles?: number;
  /** filter_area, and optionally select_features: state and/or region names. */
  states?: string[];
  /** select_features: one city name, matched against the layer's own column. */
  city?: string;
  /** filter_place: which kind of named boundary, and its name. */
  place_kind?: 'place' | 'zcta' | 'cbsa' | 'urban';
  place_name?: string;
  /** select_features / count_features: narrow a layer by its own attributes. */
  attribute_filters?: Array<{ column: string; value: string }>;
  /** combine: how the two inputs are put together. */
  operation?: 'ratio' | 'sum' | 'difference' | 'percent_change';
}

/**
 * Where a result came from and what produced it. Assembled server-side, because
 * the browser cannot know which model planned the query or which physical
 * column an attr_id resolved to.
 */
export interface AttributeOrigin {
  attr_id: string;
  description: string | null;
  dataset: string | null;
  original_name: string | null;
  source_kind: string | null;
  table_name: string | null;
  /** Null for feature datasets: they are read for geometry, not a column. */
  value_column: string | null;
  geometry_column: string | null;
  census_code: string | null;
  entity_type: string | null;
  start_date: string | null;
  end_date: string | null;
  srid: number | null;
}

export interface AnalysisProvenance {
  generated_at: string;
  query: string;
  intent: string;
  models: { decomposition: string; planner: string; embedding: string };
  retrieval: {
    corpus_cache_key: string | null;
    catalog_rows: number;
    retrieved: number;
    executable: number;
    plan_repairs: number;
  };
  database: string | null;
  attribute_origins: AttributeOrigin[];
  units_note: string;
}

export interface AnalysisPlan {
  intent: string;
  output_type: 'map' | 'table' | 'chart' | 'statistics';
  entity_type: 'COUNTY' | 'STATE';
  steps: PlanStep[];
}

export interface AnalysisRow {
  fips: string;
  name: string | null;
  state_fp: string | null;
  value: number | null;
  /**
   * The second measure, present only when the plan ends in a `join`.
   *
   * "Population and poverty rate" is one analysis with two numbers per county,
   * not two analyses: the compiler's join step already computed both, and the
   * final SELECT used to discard this one.
   */
  value_b?: number | null;
}

export interface AnalysisResponse {
  query: string;
  decomposition: UnifiedSearchDecomposition;
  plan: AnalysisPlan;
  repairs: number;
  candidates: UnifiedSearchResultItem[];
  sql?: string;
  params?: (string | number)[];
  row_count?: number;
  rows?: AnalysisRow[];
  /** Only present when include_geometry is requested; the UI joins locally instead. */
  geometry?: Array<{ fips: string; geometry: GeoJSON.Geometry }>;
  execution_ms?: number;
  execution_error?: string;
  provenance?: AnalysisProvenance;
  /**
   * Which shape of answer came back. 'values' is the per-county series the
   * choropleth draws; 'features' is individual locations with their own
   * geometry. They are mutually exclusive -- a plan is one or the other.
   */
  output_mode?: 'values' | 'features' | 'factors';
  /** 2 when every row carries `value_b`; absent or 1 for a single measure. */
  series?: number;
  /** The first layer is a signed measure and needs a diverging ramp. */
  diverging?: boolean;
  /** What the number means, e.g. "Gi* z-score". */
  value_label?: string | null;
  /** Present only when the plan had more than one `output` step. */
  layers?: AnalysisLayer[];
  layer_count?: number;
  features?: MappedFeature[];
  ambiguity?: CityAmbiguity;
  /** Present when the result is one statistic (correlate), not a county layer. */
  stats?: CorrelationStats | null;
  /** How each attribute the plan uses relates to the question. */
  relevance?: RelevanceVerdict[] | null;
  /** Present when the result is a ranked factor table (explain). */
  explain?: ExplainResult;
  ms: number;
}

/** correlate's single row. `value` is Spearman's rho. */
export interface CorrelationStats {
  value: number | null;
  pearson_r: number | null;
  n: number | null;
  n_effective: number | null;
  ci_low: number | null;
  ci_high: number | null;
  p_value: number | null;
  slope: number | null;
  intercept: number | null;
  moran_a: number | null;
  moran_b: number | null;
}

export interface ExplainFactor {
  attr_id: string;
  role: 'factor' | 'control';
  description: string | null;
  source: 'literature' | 'question' | 'default' | 'control';
  literature?: {
    concept: string; seed: string; papers: number; predicates: string[];
    papers_as_cause: number | null; papers_as_effect: number | null;
    direction: 'cause' | 'effect' | null;
  };
  status: 'ok' | 'same_measure_as_outcome' | 'same_measure_as_control'
        | 'too_few_counties' | 'controls_collinear';
  /** Present when the literature mostly reports it as a consequence; unranked. */
  context?: 'consequence';
  rank?: number;
  n: number;
  n_effective?: number;
  rho?: number;
  partial_rho?: number;
  ci_low?: number;
  ci_high?: number;
  p_value?: number;
  q_value?: number;
  importance?: number;
  attenuation?: number | null;
}

export interface ExplainResult {
  factors: ExplainFactor[];
  controls: Array<{ attr_id: string; description: string | null }>;
  outcome_counties: number;
}

export interface RelevanceVerdict {
  attr_id: string;
  label: string;
  description: string | null;
  verdict: 'direct' | 'proxy' | 'denominator' | 'unrelated' | 'unchecked';
  reason: string | null;
}

/**
 * Stages emitted by GET /api/analyze/stream, in the order they occur.
 * `plan_invalid` may repeat -- the planner retries with the validation errors.
 */
/** A follow-up the stack can definitely answer, built from resolved candidates. */
export interface Suggestion {
  query: string;
  why: string;
  kind: 'value' | 'feature';
}

/** A result that spans more places than the question probably meant. */
export interface CityAmbiguity {
  city: string;
  state_count: number;
  /** `state` is the postal code the layer stores; `state_name` is what the planner takes. */
  states: Array<{ state: string; state_name: string | null; count: number }>;
}

/** What came back when an analysis could not be produced. */
export interface AnalysisFailure {
  error: string;
  detail?: string;
  suggestions?: Suggestion[];
  /** Catalog entries with no underlying table -- a loading gap, not a bad question. */
  unavailable_datasets?: string[];
}

export type AnalysisStage =
  | 'idle' | 'queued' | 'started' | 'decomposed' | 'retrieved'
  | 'planning' | 'plan_invalid' | 'plan_valid' | 'executing'
  | 'plan_adjusted' | 'done' | 'failed';

export interface AnalysisEvent {
  stage: AnalysisStage;
  query?: string;
  decomposition?: UnifiedSearchDecomposition;
  retrieved?: number;
  executable?: number;
  facility?: number;
  by_purpose?: Record<string, number>;
  attempt?: number;
  of?: number;
  intent?: string;
  ops?: string[];
  errors?: string[];
  /** queued: place in line, and how many are waiting. */
  position?: number;
  total?: number;
  /** plan_adjusted: what was corrected deterministically. */
  detail?: string;
}