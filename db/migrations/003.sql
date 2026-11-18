CREATE TABLE IF NOT EXISTS closing_jobs (
  discussion_id TEXT PRIMARY KEY REFERENCES discussions(id),
  generation INTEGER NOT NULL,
  data_json TEXT NOT NULL
);
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(3,datetime('now'));
