import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Resolve the `@/*` path alias to the webgis-app project root so imports like
// `@/lib/geo` work in tests exactly as they do in the Next.js app.
const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': projectRoot,
    },
  },
  test: {
    globals: true,
    // Default to the Node environment (used by lib/ and api/ tests).
    // Component tests (under components/ or files named *.dom.test.*) run in
    // jsdom so React rendering and DOM APIs are available.
    environment: 'node',
    environmentMatchGlobs: [
      ['**/components/**', 'jsdom'],
      ['**/*.dom.test.{ts,tsx}', 'jsdom'],
    ],
  },
});
