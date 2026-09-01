-- Make the contact-reservation query fully index-satisfiable.
--
-- `reserveNext` orders by (next_attempt_at, id) and takes the first row. The original index
-- stopped at `next_attempt_at`, and because every freshly imported contact has
-- `next_attempt_at = NULL`, *all* of them compare equal on that column — so SQLite fell back
-- to a temp b-tree and sorted the entire dialable set by id, on every single dial attempt.
--
-- Measured cost of one reservation: 112us at 200 agents, 722us at 1500. Linear in campaign
-- size, executed once per dial attempt, and therefore the system's scaling bottleneck
-- (BUG.md B-016, SCALE.md).
--
-- Extending the index to cover the tiebreak lets the query walk straight to the first row.

DROP INDEX IF EXISTS idx_contacts_dialable;

CREATE INDEX idx_contacts_dialable
  ON contacts (campaign_id, status, next_attempt_at, id);
