// Builds the single-file demo: dist-demo/index.html -> deploy/out/Ganttraah-demo.html
// Everything (code, styles, fonts, sample data, scheduling engine) is inlined; no server needed.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  define: { 'import.meta.env.VITE_DEMO': JSON.stringify('1') },
  base: './',
  build: { outDir: 'dist-demo', emptyOutDir: true, assetsInlineLimit: 100_000_000, chunkSizeWarningLimit: 5000 },
});
