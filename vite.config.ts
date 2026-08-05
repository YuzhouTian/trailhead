import { defineConfig } from 'vite';

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
  }
});
