import { describe, expect, it } from "vitest";
import { positionDateInRange, shiftIsoDate, weeksFromDragDistance } from "./roadmap-date";

describe("Roadmap direct manipulation", () => {
  it("moves dates by whole weeks without timezone drift", () => {
    expect(shiftIsoDate("2026-09-30", 7)).toBe("2026-10-07");
    expect(shiftIsoDate("2026-01-03", -14)).toBe("2025-12-20");
  });

  it("turns horizontal drag distance into a bounded week offset", () => {
    expect(weeksFromDragDistance(27)).toBe(0);
    expect(weeksFromDragDistance(42)).toBe(1);
    expect(weeksFromDragDistance(-150)).toBe(-2);
    expect(weeksFromDragDistance(900)).toBe(4);
  });

  it("projects task dates onto a stable plan timeline", () => {
    expect(positionDateInRange("2026-09-08", "2026-09-01", "2026-09-29", 100, 500)).toBe(200);
    expect(positionDateInRange("2026-09-15", "2026-09-01", "2026-09-29", 100, 500)).toBe(300);
    expect(positionDateInRange(undefined, "2026-09-01", "2026-09-29", 100, 500)).toBeNull();
  });
});
