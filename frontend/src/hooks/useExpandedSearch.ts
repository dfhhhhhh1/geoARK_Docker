import { useCallback, useState } from 'react';
import { EXPANDED_OFF, type ExpandedSearch } from './useAnalyzeStream';

const KEY = 'geoark.expanded';

/**
 * The Expanded search setting, one per browser and shared by the Analysis page
 * and the data cart, so turning it on in one place means it is on in both.
 * Storage can be blocked (private windows); the setting then lives for the page.
 */
export function useExpandedSearch(): [ExpandedSearch, (e: ExpandedSearch) => void] {
  const [value, setValue] = useState<ExpandedSearch>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
      if (raw && typeof raw === 'object') {
        return { on: !!raw.on, literature: raw.literature !== false, pubmed: raw.pubmed !== false };
      }
    } catch { /* fall through to the default */ }
    return EXPANDED_OFF;
  });
  const set = useCallback((e: ExpandedSearch) => {
    setValue(e);
    try { localStorage.setItem(KEY, JSON.stringify(e)); } catch { /* not worth failing */ }
  }, []);
  return [value, set];
}

/** The request fields for a JSON POST (the stream sends query params instead). */
export function expandedBody(s: ExpandedSearch): { expand: boolean; research: string } {
  return { expand: s.on && s.literature, research: s.on && s.pubmed ? 'pubmed' : '' };
}
