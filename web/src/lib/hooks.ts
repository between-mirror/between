// Between — small shared hooks: theme, reduced-motion, debounce, count-up.
import { useCallback, useEffect, useRef, useState } from 'react';

const THEME_KEY = 'between:theme';
type ThemePref = 'light' | 'dark' | 'system';
type Resolved = 'light' | 'dark';

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    /* localStorage may be unavailable */
  }
  return 'system';
}

function applyPref(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
}

/** Stamp the persisted theme synchronously at module load to avoid a flash. */
export function initThemeSync(): void {
  applyPref(readPref());
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function useTheme(): {
  pref: ThemePref;
  resolved: Resolved;
  toggle: () => void;
} {
  const [pref, setPref] = useState<ThemePref>(readPref);
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    applyPref(pref);
    try {
      if (pref === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, pref);
    } catch {
      /* ignore */
    }
  }, [pref]);

  const resolved: Resolved = pref === 'system' ? (systemDark ? 'dark' : 'light') : pref;

  const toggle = useCallback(() => {
    setPref((cur) => {
      const isDark = cur === 'dark' || (cur === 'system' && systemPrefersDark());
      return isDark ? 'light' : 'dark';
    });
  }, []);

  return { pref, resolved, toggle };
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() =>
    typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

/** Count from 0 to target over durationMs when `active`. Respects reduced motion. */
export function useCountUp(target: number, active: boolean, durationMs = 1400): number {
  const reduced = usePrefersReducedMotion();
  const [value, setValue] = useState(active && !reduced ? 0 : target);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;
    if (reduced || durationMs <= 0) {
      setValue(target);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      // ease-out cubic for a settling, unhurried feel
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(target * eased));
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, active, reduced, durationMs]);

  return value;
}
