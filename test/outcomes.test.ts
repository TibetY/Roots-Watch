// The credit line is the one number in this app that could flatter itself, so
// it gets tests about what it refuses to say as much as what it says.

import { describe, expect, it } from "vitest";

import { creditLine, isReason, REASONS, type Tally } from "../app/lib/outcomes";

function tally(foundHere: number, foundElsewhere: number, noLongerWanted = 0): Tally {
  return {
    foundHere,
    foundElsewhere,
    noLongerWanted,
    found: foundHere + foundElsewhere,
    total: foundHere + foundElsewhere + noLongerWanted,
  };
}

describe("isReason", () => {
  it("accepts exactly the three the UI offers", () => {
    for (const reason of REASONS) expect(isReason(reason.value)).toBe(true);
  });

  it("rejects anything else, including a hand-posted form value", () => {
    for (const bogus of ["", "found", "FOUND_HERE", null, undefined, 3, {}]) {
      expect(isReason(bogus)).toBe(false);
    }
  });
});

describe("creditLine", () => {
  it("says nothing at all until there is something to say", () => {
    expect(creditLine(tally(0, 0))).toBeNull();
    // Losing interest in an item is not a finding either way.
    expect(creditLine(tally(0, 0, 4))).toBeNull();
  });

  it("always shows the ones you found first alongside the ones we found", () => {
    const line = creditLine(tally(3, 2));
    expect(line).toContain("3");
    expect(line).toContain("2");
  });

  it("admits when it has never helped", () => {
    const line = creditLine(tally(0, 5));
    expect(line).toMatch(/beat us/i);
    expect(line).toContain("5");
  });

  it("counts one item as an item", () => {
    expect(creditLine(tally(1, 0))).toContain("1 item ");
    expect(creditLine(tally(2, 0))).toContain("2 items");
  });

  it("never reports items you simply went off as successes", () => {
    // Ten abandoned watches must not read as ten wins.
    const line = creditLine(tally(1, 0, 10));
    expect(line).toContain("1 item");
    expect(line).not.toContain("10");
  });
});
