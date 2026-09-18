import { useAuth } from '../hooks/useAuth';

export function HomePage() {
  const { userId, profile } = useAuth();
  return (
    <div>
      <h1>Signed in</h1>
      <p>User id: {userId}</p>
      <p>School id: {profile?.school_id ?? '(none)'}</p>
      <p>Role: {profile?.role ?? '(none)'}</p>
      <p style={{ opacity: 0.7 }}>
        This is a foundation placeholder. Feature screens (Schedule, etc.) are added
        per docs/REACT_MIGRATION_PLAN.md, one slice at a time.
      </p>
    </div>
  );
}
