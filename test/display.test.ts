import { describe, expect, it } from "vitest";

import { BLIND_CREED, blindReason } from "../app/lib/display";

// A row that can't be read is the one place the UI has to explain itself well:
// it's reporting an absence, and an absence is easy to mistake for "sold out".
// These guard the shape of that message — it must read as a sentence, and it
// must never open with a raw error string.
describe("blindReason", () => {
  const errors = [
    "couldn't load the page: HTTP 404",
    "couldn't load the page: HTTP 503",
    "couldn't find a product id in that address",
    "couldn't load the page: The operation was aborted due to timeout",
    null,
  ];

  it("always reads as a capitalised sentence", () => {
    for (const error of errors) {
      const reason = blindReason(error);
      expect(reason[0]).toBe(reason[0].toUpperCase());
      expect(reason.endsWith(".")).toBe(true);
    }
  });

  it("never leaks a status code or lowercase error fragment into the lead", () => {
    for (const error of errors) {
      const note = `${blindReason(error)} ${BLIND_CREED}`;
      expect(note).not.toMatch(/HTTP \d/);
      expect(note).not.toContain("couldn't load the page:");
    }
  });

  it("distinguishes a shop refusing us from a shop that changed shape", () => {
    expect(blindReason("couldn't load the page: HTTP 403")).toMatch(/turned us away/i);
    expect(blindReason(null)).toMatch(/size list/i);
  });
});
