import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = 'http://127.0.0.1:16020';

/* The shelf is served at the origin root when it runs alone, and under a path
   prefix when a shared edge fronts it beside other apps, so every asset URL has
   to be relative to the document rather than to "/". `base: "./"` is what makes
   the built bundle work either way; the front end resolves its own API URLs the
   same way, against the directory it was served from.

   In development Vite serves the bundle and the Python process keeps the books,
   so the three server-owned route families are proxied across to it. The dev
   server sits one port above `serve`'s, and refuses to start rather than
   wander onto another if that one is taken. */
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 16021,
    strictPort: true,
    proxy: Object.fromEntries(
      ['/api', '/cover', '/book'].map(path => [path, { target: API, changeOrigin: false }]),
    ),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The reader is a large engine and splitting it out means the shelf's own
    // bundle stays small; it is loaded only when a book is opened.
    chunkSizeWarningLimit: 900,
  },
});
