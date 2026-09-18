import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Vitest does not auto-register Testing Library's cleanup unless
// `test.globals: true` is set (it is not, in this project's
// vite.config.ts). Without this, each test's rendered tree stays
// mounted in jsdom's shared document, so later tests in the same
// file see duplicate elements from earlier renders. Explicit cleanup
// after every test keeps each test's DOM isolated.
afterEach(() => {
  cleanup();
});
