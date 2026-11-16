// Unmatched scans, counted one way everywhere -----------------------------------
//
// "Unmatched" is the number of different entries the machine printed that are
// nobody on the list: one per number + name, however many times it was scanned
// and in however many files ("039 ADA OKO" in one file and "39 Ada Oko" in the
// next are one entry). The count on the cards, the rows in the Unmatched tab,
// the per-file table and the downloads are all this same list.

import { normalizeName } from "@/lib/attendance";

export type UnmatchedEntry = {
  scan_id: string;
  scan_number: string | null;
  scanned_name: string | null;
  scan_count: number;
  first_scan_at: string;
  last_scan_at: string;
};

/** The key two printed entries share when they are the same entry. */
export function unmatchedKey(scanNumber: string | null, scannedName: string | null): string {
  const number = (scanNumber ?? "")
    .trim()
    .replace(/^0+(?=\d)/, "")
    .toUpperCase();
  return `${number}\u0000${normalizeName(scannedName ?? "")}`;
}

/** Adds scans to a list of entries, one entry per key. */
export class UnmatchedList {
  private readonly groups = new Map<string, UnmatchedEntry>();

  add(scan: {
    id: string;
    scan_number: string | null;
    scanned_name: string | null;
    at: string;
  }): string {
    const key = unmatchedKey(scan.scan_number, scan.scanned_name);
    const group = this.groups.get(key);
    if (!group) {
      this.groups.set(key, {
        scan_id: scan.id,
        scan_number: scan.scan_number,
        scanned_name: scan.scanned_name,
        scan_count: 1,
        first_scan_at: scan.at,
        last_scan_at: scan.at,
      });
    } else {
      group.scan_count += 1;
      if (scan.id < group.scan_id) group.scan_id = scan.id;
      if (scan.at && (!group.first_scan_at || scan.at < group.first_scan_at)) {
        group.first_scan_at = scan.at;
      }
      if (scan.at > group.last_scan_at) group.last_scan_at = scan.at;
    }
    return key;
  }

  get size(): number {
    return this.groups.size;
  }

  /** Most-scanned first, then by name. */
  entries(): UnmatchedEntry[] {
    return [...this.groups.values()].sort(
      (a, b) =>
        b.scan_count - a.scan_count ||
        (a.scanned_name ?? "").localeCompare(b.scanned_name ?? "", "en"),
    );
  }
}
