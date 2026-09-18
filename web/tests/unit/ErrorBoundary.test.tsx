import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from '@/components/layout/ErrorBoundary';

function Boom(): never {
  throw new Error('sql: password=hunter2 near "SELECT * FROM secrets"');
}

describe('ErrorBoundary', () => {
  it('renders a safe fallback message, never the raw thrown error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong. Please try again.');
    expect(screen.queryByText(/hunter2|SELECT \* FROM/)).not.toBeInTheDocument();

    vi.restoreAllMocks();
  });
});
