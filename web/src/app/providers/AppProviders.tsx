import type { ReactNode } from 'react';
import { AuthProvider } from '@/features/auth/AuthProvider';
import { ErrorBoundary } from '@/components/layout/ErrorBoundary';

/**
 * Composition root for global providers. Kept deliberately small —
 * per the migration plan's instruction not to move every legacy
 * global state field into a React global context. Add a provider
 * here only when a concrete cross-feature need is proven, not
 * preemptively.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary>
      <AuthProvider>{children}</AuthProvider>
    </ErrorBoundary>
  );
}
