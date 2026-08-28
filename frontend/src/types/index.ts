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

// Backend API response interface
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