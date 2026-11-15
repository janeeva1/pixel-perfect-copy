-- Debt rates ---------------------------------------------------------------
--
-- What one absence from a Weekly Mass costs, per group. The debt page works the
-- debts out from the attendance results every time it is opened (nothing is
-- stored per person), so a correction to a week -- a confirmed match, a merged
-- duplicate, someone added to the always-present list -- changes the debts by
-- itself. Only the two prices are stored, so an administrator can change them.

CREATE TABLE IF NOT EXISTS debt_rates (
  participant_type TEXT NOT NULL PRIMARY KEY,
  -- Naira, whole.
  amount INTEGER NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO debt_rates (participant_type, amount) VALUES ('staff', 10000);
INSERT OR IGNORE INTO debt_rates (participant_type, amount) VALUES ('student', 5000);
