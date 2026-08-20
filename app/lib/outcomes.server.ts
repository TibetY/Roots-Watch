// Reading and writing the outcomes you report. The vocabulary, the guard and
// the credit line live in outcomes.ts, because the browser renders them.

import type { Db } from "./supabase.server";
import type { Reason, Tally } from "./outcomes";

/**
 * Record why a watch was stopped.
 *
 * The label and url are copied in rather than referenced, so the row survives
 * the item being removed later — see 0002_outcomes.sql for why that matters.
 */
export async function recordOutcome(
  db: Db,
  userId: string,
  item: { id: string; label: string; url: string },
  reason: Reason,
): Promise<void> {
  const { error } = await db.from("outcomes").insert({
    user_id: userId,
    item_id: item.id,
    label: item.label,
    url: item.url,
    reason,
  });
  if (error) throw new Error(`Couldn't save that: ${error.message}`);
}

/** Every outcome you've reported, counted. */
export async function readTally(db: Db, userId: string): Promise<Tally> {
  const { data } = await db
    .from("outcomes")
    .select("reason")
    .eq("user_id", userId)
    .returns<{ reason: Reason }[]>();

  const rows = data ?? [];
  const count = (reason: Reason) => rows.filter((row) => row.reason === reason).length;

  const foundHere = count("found_here");
  const foundElsewhere = count("found_elsewhere");
  return {
    foundHere,
    foundElsewhere,
    noLongerWanted: count("no_longer_want"),
    found: foundHere + foundElsewhere,
    total: rows.length,
  };
}
