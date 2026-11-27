-- Postgres initialization script for Health AI session schema
-- Ensures tables are created in correct order to avoid relation-not-found errors
-- Generated: 2026-08-19T19:44:40+05:00

BEGIN;

-- Todos table (create first because other tables reference it)
CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done', 'blocked')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Inbox entries (independent)
CREATE TABLE IF NOT EXISTS inbox_entries (
  id TEXT PRIMARY KEY,
  recipient_session_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  sender_type TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,
  content TEXT NOT NULL,
  unread BOOLEAN NOT NULL DEFAULT TRUE,
  sent_at TIMESTAMP WITH TIME ZONE NOT NULL,
  read_at TIMESTAMP WITH TIME ZONE,
  notified_at TIMESTAMP WITH TIME ZONE
);

-- Todo dependencies (references todos)
CREATE TABLE IF NOT EXISTS todo_deps (
  todo_id TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  PRIMARY KEY (todo_id, depends_on),
  FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on) REFERENCES todos(id) ON DELETE CASCADE
);

COMMIT;

-- Usage:
-- psql "postgres://user:pass@host:port/dbname" -f files/db_init_postgres.sql
-- Or run the script inside your database migration tool / Supabase SQL editor.
