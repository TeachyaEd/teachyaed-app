import { HashRouter, Route, Routes } from 'react-router-dom';
import { RequireAuth } from '../guards/RequireAuth';
import { AppLayout } from '@/components/layout/AppLayout';
import { LoginPage } from '@/features/auth/components/LoginPage';
import { HomePage } from '@/features/auth/components/HomePage';
import { SchedulePage } from '@/features/schedule/components/SchedulePage';

/**
 * Routing strategy: HashRouter.
 *
 * See docs/REACT_MIGRATION_PLAN.md ("Routing strategy") for the full
 * reasoning. Short version: GitHub Pages (the legacy app's current
 * and, for now, only host) serves static files with no SPA rewrite
 * rule, so a BrowserRouter deep link (e.g. /schedule) would 404 on a
 * hard refresh. HashRouter keeps all client-side routes after a `#`,
 * which is never sent to the server, so it works correctly from any
 * static host and any subpath without extra hosting configuration.
 * Revisit only if/when this app moves to a host with real SPA
 * fallback support (verify before switching, don't assume).
 */
export function AppRouter() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <AppLayout>
                <HomePage />
              </AppLayout>
            </RequireAuth>
          }
        />
        <Route
          path="/schedule"
          element={
            <RequireAuth>
              <AppLayout>
                <SchedulePage />
              </AppLayout>
            </RequireAuth>
          }
        />
      </Routes>
    </HashRouter>
  );
}
