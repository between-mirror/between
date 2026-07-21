import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node, not jsdom: the things worth testing on this side are pure decisions — which river layer
    // is honest to show, what the nav resolves to — deliberately kept out of the components so they
    // can be tested without dragging in a DOM.
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
