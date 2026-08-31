// `vitest/config` rather than `vite` so the `test` block below is typed; it
// re-exports Vite's own defineConfig, so `vite build` reads this unchanged.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  define: {
    // Shown in Settings so it's possible to tell at a glance whether a phone
    // is running the latest deploy or a cached older one.
    __BUILD_ID__: JSON.stringify(
      new Date().toISOString().slice(0, 16).replace('T', ' ')
    )
  },
  build: {
    target: 'es2020'
  },
  test: {
    // Most tested modules are pure logic, so no DOM by default: node is much
    // faster, and an accidental `document` reference fails loudly instead of
    // quietly passing. Files that do need browser globals opt in — a
    // `@vitest-environment jsdom` comment where a whole DOM is wanted
    // (gpx.test.ts, features/sharing.test.ts), or a two-line `location` stub
    // where one property is (share.test.ts).
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
});
