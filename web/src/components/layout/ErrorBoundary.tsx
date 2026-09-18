import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { toAppError } from '@/lib/errors';
import { observability } from '@/lib/observability';

interface Props {
  children: ReactNode;
}

interface State {
  userMessage: string | null;
}

/**
 * Top-level React Error Boundary. Only ever renders a short, safe
 * message to the user (never a stack trace, raw error, JWT, or SQL —
 * see src/lib/errors.ts). The real error still reaches
 * observability.captureError() for developer diagnostics.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { userMessage: null };

  static getDerivedStateFromError(error: unknown): State {
    return { userMessage: toAppError(error).userMessage };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    observability.captureError({
      message: 'Unhandled React render error',
      error,
      context: { componentStack: info.componentStack ? 'present' : 'absent' },
    });
  }

  render() {
    if (this.state.userMessage) {
      return (
        <div role="alert" style={{ padding: '2rem', textAlign: 'center' }}>
          <p>{this.state.userMessage}</p>
        </div>
      );
    }
    return this.props.children;
  }
}
