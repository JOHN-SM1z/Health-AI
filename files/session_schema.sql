-- Session SQLite schema dump for Health AI (session database)
-- Generated: 2026-08-19T19:42:38+05:00

-- Table: inbox_entries
CREATE TABLE inbox_entries (
  id TEXT PRIMARY KEY,
  recipient_session_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  sender_type TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,
  content TEXT NOT NULL,
  unread INTEGER NOT NULL DEFAULT 1,
  sent_at INTEGER NOT NULL,
  read_at INTEGER,
  notified_at INTEGER
);

-- Table: todo_deps
CREATE TABLE todo_deps (
  todo_id TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  PRIMARY KEY (todo_id, depends_on),
  FOREIGN KEY (todo_id) REFERENCES todos(id),
  FOREIGN KEY (depends_on) REFERENCES todos(id)
);

-- Table: todos
CREATE TABLE todos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'done', 'blocked')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Notes:
-- - This dump contains the session SQLite schema as discovered in the runtime session database.
-- - The session DB tables were empty at the time of inspection.
-- - To import this schema into an empty SQLite DB: `sqlite3 target.db < session_schema.sql`
