/**
 * Database types — PLACEHOLDER, not generated from the real schema.
 *
 * Preferred model (per docs/REACT_MIGRATION_PLAN.md): generate this
 * file with `supabase gen types typescript` against the real
 * project schema. That requires the Supabase CLI and authenticated
 * project access, neither of which is available in the automated
 * environment that produced this scaffold — the SQL-editor
 * read-only introspection query drafted for this purpose was
 * blocked by this environment's own action-permission classifier
 * (treated as a sensitive action against production), and no
 * attempt was made to route around that block.
 *
 * Documenting this explicitly rather than hand-inventing column
 * types, per the instruction that produced this file: a fabricated
 * partial schema is worse than an honest placeholder, because it
 * can silently drift from the real database and nothing would catch
 * it at compile time.
 *
 * Table NAMES below are not invented — they are the 27 tables
 * confirmed present in docs/MIGRATION_INVENTORY.md §1 (extracted
 * from the live legacy frontend's `.from(...)` calls). Only their
 * row shapes are placeholders.
 *
 * TODO before any feature does non-trivial typed querying beyond
 * Schedule's own narrow, hand-checked local type: run
 *   supabase gen types typescript --project-id juwvlyrepwdcndkqiqna
 * from an environment with Supabase CLI + project access, and
 * replace this file with the generated output.
 */

type UnknownRow = Record<string, unknown>;

interface PlaceholderTable {
  Row: UnknownRow;
  Insert: UnknownRow;
  Update: UnknownRow;
}

type PlaceholderTables<Name extends string> = Record<Name, PlaceholderTable>;

export type KnownTableName =
  | 'call_signals'
  | 'class_feed'
  | 'class_lessons'
  | 'class_live'
  | 'class_students'
  | 'classes'
  | 'conversation_members'
  | 'conversations'
  | 'homeworks'
  | 'lesson_answers'
  | 'lesson_assignments'
  | 'lesson_chat'
  | 'lesson_library_likes'
  | 'lesson_notes'
  | 'lessons'
  | 'lessons_log'
  | 'materials'
  | 'messages'
  | 'payments'
  | 'pd_answers'
  | 'pd_attempts'
  | 'pd_materials'
  | 'pd_questions'
  | 'profiles'
  | 'schedule_events'
  | 'students'
  | 'tasks'
  | 'teacher_salaries';

export interface Database {
  public: {
    Tables: PlaceholderTables<KnownTableName>;
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
}
