/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// GitHub Pages hosts this app from a static file server with no SPA
// rewrite rule (see docs/REACT_MIGRATION_PLAN.md, "Routing strategy").
// `base: './'` keeps built asset URLs relative so the app works from
// whatever non-production subpath it is previewed from, without
// requiring a specific deploy path to be hardcoded here.
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/unit/setup.ts'],
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    css: false,
  },
});
