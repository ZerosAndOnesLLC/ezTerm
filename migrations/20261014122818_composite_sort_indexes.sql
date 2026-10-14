-- Cover the `ORDER BY <parent>, sort, id` pattern used by folders::list
-- and sessions::list with composite indexes. The old single-column
-- indexes are a strict prefix of the new ones, so they are dropped.
DROP INDEX IF EXISTS idx_folders_parent;
CREATE INDEX idx_folders_parent_sort ON folders(parent_id, sort, id);

DROP INDEX IF EXISTS idx_sessions_folder;
CREATE INDEX idx_sessions_folder_sort ON sessions(folder_id, sort, id);
