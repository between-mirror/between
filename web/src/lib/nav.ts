// Between Mirror — the nav model. Pure data and pure functions, deliberately outside the component
// so the shape of the app can be tested (and argued about) without rendering anything.
//
// Why five. The eleven peer tabs were a menu written by the person who built each one: every view
// that existed got equal billing, so nothing was the front door and three of the names described the
// implementation rather than what you would see. A stranger cannot navigate that. These five are the
// questions someone actually arrives with:
//
//   Home      — where am I, and what does this thread look like
//   Explore   — show me the years (the five old analysis views, as a subnav)
//   Ask       — I have a question
//   Messages  — what did we actually say
//   Readings  — what has been written about us
//
// Internal view ids are UNCHANGED. This is a navigation and naming change; every view component,
// every receipt drill-through, and every deep anchor still resolves to the same thing it always did.

export type SurfaceId = 'home' | 'explore' | 'ask' | 'messages' | 'readings';

export type ViewId =
  | 'overview'
  | 'trajectory' | 'eras' | 'episodes' | 'findings' | 'shape' | 'health'
  | 'ask'
  | 'transcript'
  | 'readings' | 'session';

export interface NavView {
  id: ViewId;
  label: string;
}

export interface NavSurface {
  id: SurfaceId;
  label: string;
  /** Rendered as a subnav when there is more than one. */
  views: NavView[];
}

export const SURFACES: readonly NavSurface[] = [
  { id: 'home', label: 'Home', views: [{ id: 'overview', label: 'Overview' }] },
  {
    id: 'explore',
    label: 'Explore',
    views: [
      // Renamed for a reader, not for the codebase. "Trajectory" is a word about a model;
      // "Timeline" is a word about a life. Same for Findings → Patterns and
      // The shape of it → Rhythm.
      { id: 'trajectory', label: 'Timeline' },
      { id: 'eras', label: 'Eras' },
      { id: 'episodes', label: 'Episodes' },
      { id: 'findings', label: 'Patterns' },
      { id: 'shape', label: 'Rhythm' },
      // Last in the list and first in importance. Every view above draws a line through whatever is
      // in the archive; this one says how much of the archive is missing. A calm stretch caused by a
      // conversation that moved to another app is the most convincing wrong answer this software can
      // give, and the only defence is showing the holes as plainly as the trends.
      { id: 'health', label: 'Archive health' },
    ],
  },
  { id: 'ask', label: 'Ask', views: [{ id: 'ask', label: 'Ask' }] },
  { id: 'messages', label: 'Messages', views: [{ id: 'transcript', label: 'Messages' }] },
  {
    id: 'readings',
    label: 'Readings',
    // Two views of one idea: the shelf of everything frozen so far, and the first reading with its
    // own ask-for-one flow. Kept as a subnav rather than fused into a single component — merging two
    // working readers to save one row of chrome would be a rewrite dressed as navigation.
    views: [
      { id: 'readings', label: 'The readings' },
      { id: 'session', label: 'A first reading' },
    ],
  },
];

/** Every view id → the surface that owns it. Built from SURFACES so the two cannot drift. */
export const VIEW_TO_SURFACE: Record<ViewId, SurfaceId> = Object.fromEntries(
  SURFACES.flatMap((s) => s.views.map((v) => [v.id, s.id])),
) as Record<ViewId, SurfaceId>;

export function surfaceFor(view: ViewId): SurfaceId {
  return VIEW_TO_SURFACE[view];
}

export function viewsFor(surface: SurfaceId): NavView[] {
  return SURFACES.find((s) => s.id === surface)!.views;
}

export function defaultViewFor(surface: SurfaceId): ViewId {
  return viewsFor(surface)[0].id;
}

export function labelForView(view: ViewId): string {
  return viewsFor(surfaceFor(view)).find((v) => v.id === view)!.label;
}

/** Arrow-key movement across the surface bar. Wraps, per the ARIA tabs pattern. */
export function stepSurface(current: SurfaceId, dir: 1 | -1): SurfaceId {
  const i = SURFACES.findIndex((s) => s.id === current);
  return SURFACES[(i + dir + SURFACES.length) % SURFACES.length].id;
}

/** Arrow-key movement inside a subnav. A single-view surface simply stays put. */
export function stepView(surface: SurfaceId, current: ViewId, dir: 1 | -1): ViewId {
  const views = viewsFor(surface);
  if (views.length < 2) return current;
  const i = views.findIndex((v) => v.id === current);
  return views[(i + dir + views.length) % views.length].id;
}
