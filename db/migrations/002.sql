CREATE TABLE IF NOT EXISTS speech_drafts (
  discussion_id TEXT PRIMARY KEY REFERENCES discussions(id),
  turn_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  participant_id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  FOREIGN KEY(discussion_id,participant_id) REFERENCES participants(discussion_id,id)
);
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(2,datetime('now'));
