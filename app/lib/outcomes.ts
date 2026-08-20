// What happened in the end, according to you.
//
// The watcher can prove a restock occurred. It cannot know whether that was any
// use — whether you got the thing, whether you had already found it elsewhere,
// or whether you had gone off it by then. Only you know that, so it is asked
// once, at the one moment it is cheap to answer: when you stop watching.
//
// Shared rather than server-only, because the buttons that offer these choices
// are rendered in the browser. The database half lives in outcomes.server.ts.

export const REASONS = [
  {
    value: "found_here",
    label: "I found stock thanks to STDBY",
    hint: "The alert did its job.",
  },
  {
    value: "found_elsewhere",
    label: "I found stock on my own",
    hint: "Spotted it before we told you.",
  },
  {
    value: "no_longer_want",
    label: "I no longer want this item",
    hint: "Changed your mind, or bought something else.",
  },
] as const;

export type Reason = (typeof REASONS)[number]["value"];

const VALUES = new Set<string>(REASONS.map((entry) => entry.value));

/** Guards the form post. The check constraint in the schema is the backstop. */
export function isReason(value: unknown): value is Reason {
  return typeof value === "string" && VALUES.has(value);
}

export type Tally = {
  foundHere: number;
  foundElsewhere: number;
  noLongerWanted: number;
  /** Times you told us either way. The denominator the credit number needs. */
  found: number;
  total: number;
};

/**
 * The credit line, stated so it can't flatter itself.
 *
 * "3 finds" on its own is a number with no denominator — it reads as a score
 * and can only ever go up. Pairing it with the times you got there first is
 * what makes it worth reading: the same tally that says the watcher is earning
 * its keep is the one that would say it isn't.
 */
export function creditLine(tally: Tally): string | null {
  if (!tally.found) return null;
  const { foundHere, foundElsewhere } = tally;
  const items = foundHere === 1 ? "item" : "items";
  if (!foundElsewhere) return `${foundHere} ${items} you got because we told you.`;
  if (!foundHere) return `You beat us to all ${foundElsewhere} of them so far.`;
  return `${foundHere} ${items} you got because we told you; ${foundElsewhere} you spotted first.`;
}
