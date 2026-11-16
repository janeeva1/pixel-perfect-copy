-- Matching rules, version 18.
--
-- Records which version of the scan-matching rules each kind of scan (staff,
-- student) was last matched with on this computer. When the app ships better
-- rules, every stored scan of that kind is matched again once (remembered
-- administrator answers are kept), so nobody stays absent or unmatched because
-- of an older rule. Local to each computer: not synced.
CREATE TABLE match_rules (
  kind TEXT NOT NULL PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0
);
