import { describe, expect, it } from "vitest";
import { shiftIsoDate, weeksFromDragDistance } from "./roadmap-date";

describe("Roadmap direct manipulation", () => {
  it("moves dates by whole weeks without timezone drift", () => {
    expect(shiftIsoDate("2026-09-30", 7)).toBe("2026-10-07");
    expect(shiftIsoDate("2026-01-03", -14)).toBe("2025-12-20");
  });

  it("turns horizontal drag distance into a bounded week offset", () => {
    expect(weeksFromDragDistance(35)).toBe(0);
    expect(weeksFromDragDistance(45)).toBe(1);
    expect(weeksFromDragDistance(-190)).toBe(-2);
    expect(weeksFromDragDistance(900)).toBe(4);
  });
});
