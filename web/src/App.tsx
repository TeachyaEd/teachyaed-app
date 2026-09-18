import { AppProviders } from '@/app/providers/AppProviders';
import { AppRouter } from '@/app/router';

/**
 * Composition only — no business logic here. See
 * src/app/providers/AppProviders.tsx and src/app/router/index.tsx.
 */
export function App() {
  return (
    <AppProviders>
      <AppRouter />
    </AppProviders>
  );
}
