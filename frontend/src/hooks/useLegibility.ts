import { useCallback, useState } from 'react';

/**
 * Readable mode: every glass surface becomes an opaque, bordered panel.
 *
 * Stamped on <html> as data-legible so the CSS in index.css can reach every
 * surface, including map overlays, without each component knowing about it.
 *
 * With no saved choice it follows the OS: someone who has asked their system
 * for reduced transparency or more contrast should not have to find a toggle
 * to undo the one thing they already said they cannot use.
 */
const KEY = 'geoark.legible';

function osPrefersSolid(): boolean {
  try {
    return window.matchMedia(
      '(prefers-reduced-transparency: reduce), (prefers-contrast: more)').matches;
  } catch {
    return false;
  }
}

function readSaved(): boolean | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === null ? null : v === '1';
  } catch {
    return null;
  }
}

function apply(on: boolean) {
  document.documentElement.dataset.legible = on ? 'true' : 'false';
}

/** Called once before the first render, so a saved choice never flashes. */
export function initLegibility(): void {
  apply(readSaved() ?? osPrefersSolid());
}

export function useLegibility(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(
    () => document.documentElement.dataset.legible === 'true');

  const set = useCallback((next: boolean) => {
    setOn(next);
    apply(next);
    try { localStorage.setItem(KEY, next ? '1' : '0'); } catch { /* private window */ }
  }, []);

  return [on, set];
}
