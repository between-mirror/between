// Between Mirror — the stranger nav (Era 1, v0.3.0).
//
// Eleven peer tabs — Overview, Trajectory, Episodes, Eras, Findings, Readings, Ask, The shape of it,
// Calibrate, Session, Transcript — is a menu written by the person who built each one. A stranger
// opening this for the first time cannot tell which of those is the front door, and three of the
// names ("Trajectory", "Findings", "The shape of it") describe the implementation rather than what
// you would see.
//
// Five surfaces, each answering a question someone actually arrives with: where am I (Home), show me
// the years (Explore), I have a question (Ask), what did we actually say (Messages), what has been
// written about us (Readings).
import { describe, it, expect } from 'vitest';
import {
  SURFACES, VIEW_TO_SURFACE, surfaceFor, defaultViewFor, stepSurface, stepView, type ViewId,
} from './nav';

describe('five surfaces, in arrival order', () => {
  it('is exactly Home / Explore / Ask / Messages / Readings', () => {
    expect(SURFACES.map((s) => s.id)).toEqual(['home', 'explore', 'ask', 'messages', 'readings']);
    expect(SURFACES.map((s) => s.label)).toEqual(['Home', 'Explore', 'Ask', 'Messages', 'Readings']);
  });

  it('Explore carries the old peer views as a subnav, renamed for a reader, plus archive health', () => {
    const explore = SURFACES.find((s) => s.id === 'explore')!;
    expect(explore.views.map((v) => [v.id, v.label])).toEqual([
      ['trajectory', 'Timeline'],   // was "Trajectory"
      ['eras', 'Eras'],
      ['episodes', 'Episodes'],
      ['findings', 'Patterns'],     // was "Findings"
      ['shape', 'Rhythm'],          // was "The shape of it"
      ['health', 'Archive health'], // what is MISSING, which every view above draws over
    ]);
  });

  it('Readings holds both frozen-reading surfaces', () => {
    const readings = SURFACES.find((s) => s.id === 'readings')!;
    expect(readings.views.map((v) => v.id)).toEqual(['readings', 'session']);
  });

  it('Home, Ask and Messages are single-view surfaces with no subnav to render', () => {
    for (const id of ['home', 'ask', 'messages'] as const) {
      expect(SURFACES.find((s) => s.id === id)!.views).toHaveLength(1);
    }
  });

  it('Calibrate is no longer a peer tab', () => {
    // It moved to Settings, and appears inline where a reading actually depends on it. It was never a
    // destination — it is a thing you do once, in service of something else.
    const everyView = SURFACES.flatMap((s) => s.views.map((v) => v.id));
    expect(everyView).not.toContain('calibrate');
  });

  it('every old view still has a home — nothing was dropped in the collapse', () => {
    const survivors: ViewId[] = [
      'overview', 'trajectory', 'episodes', 'eras', 'findings', 'readings', 'ask', 'shape',
      'session', 'transcript',
    ];
    for (const v of survivors) expect(surfaceFor(v), `${v} has no surface`).toBeTruthy();
  });
});

describe('resolving a view to its surface', () => {
  it('maps every view exactly once', () => {
    const all = SURFACES.flatMap((s) => s.views.map((v) => v.id));
    expect(new Set(all).size).toBe(all.length);
    expect(Object.keys(VIEW_TO_SURFACE).sort()).toEqual([...all].sort());
  });

  it('a receipt drill-through resolves to Messages', () => {
    // The whole discipline is "receipts, not verdicts", so this is the one navigation that must never
    // break: an observation anywhere must be able to open the words underneath it.
    expect(surfaceFor('transcript')).toBe('messages');
  });

  it('opens on Home by default', () => {
    expect(defaultViewFor('home')).toBe('overview');
  });

  it('each surface defaults to its first view', () => {
    for (const s of SURFACES) expect(defaultViewFor(s.id)).toBe(s.views[0].id);
  });
});

describe('keyboard navigation wraps in both directions', () => {
  it('steps across the surface bar', () => {
    expect(stepSurface('home', 1)).toBe('explore');
    expect(stepSurface('readings', 1)).toBe('home');      // wraps forward
    expect(stepSurface('home', -1)).toBe('readings');     // wraps back
  });

  it('steps within a subnav without leaving the surface', () => {
    expect(stepView('explore', 'trajectory', 1)).toBe('eras');
    expect(stepView('explore', 'health', 1)).toBe('trajectory');  // wraps
    expect(stepView('explore', 'trajectory', -1)).toBe('health');
  });

  it('a single-view surface has nowhere to step, and says so rather than throwing', () => {
    expect(stepView('ask', 'ask', 1)).toBe('ask');
  });
});
