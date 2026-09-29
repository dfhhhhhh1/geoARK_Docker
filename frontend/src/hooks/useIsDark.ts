import { useEffect, useState } from 'react';

/**
 * Follows the APP's theme, not the operating system's.
 *
 * Deliberately ignores prefers-color-scheme: the rest of this UI is light-only
 * (white cards, slate text), so honoring an OS dark preference painted a dark
 * ramp and a #383835 "no data" fill onto white panels. Observed directly.
 *
 * When a theme toggle lands it should stamp data-theme on <html>, and the maps
 * follow from here with no further change.
 */
export function useIsDark(): boolean {
  const [dark, setDark] = useState(
    () => document.documentElement.dataset.theme === 'dark');

  useEffect(() => {
    const el = document.documentElement;
    const observer = new MutationObserver(
      () => setDark(el.dataset.theme === 'dark'));
    observer.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return dark;
}
