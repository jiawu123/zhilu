import { describe, expect, it } from "vitest";
import { weeksFromBoardDrag } from "./board-drag";

describe("date-board layout and drag use the same displayed scale", () => {
  const weekly = [{ date: "2026-09-14", x: 32 }, { date: "2026-09-21", x: 392 }, { date: "2026-09-28", x: 752 }];
  it("saves exactly one week when moved to the preceding weekly column", () => {
    expect(weeksFromBoardDrag(-360, "2026-09-21", weekly, 360)).toBe(-1);
    expect(weeksFromBoardDrag(-270, "2026-09-21", weekly.map(a => ({ ...a, x: a.x * .75 })), 270)).toBe(-1);
  });
  it("uses actual dates when columns are not separated by one week", () => {
    const dates = [{ date: "2026-09-14", x: 0 }, { date: "2026-09-28", x: 360 }, { date: "2026-10-05", x: 720 }];
    expect(weeksFromBoardDrag(360, "2026-09-14", dates, 360)).toBe(2);
    expect(weeksFromBoardDrag(-360, "2026-10-05", dates, 360)).toBe(-1);
    expect(weeksFromBoardDrag(720, "2026-09-14", dates, 360)).toBe(3);
  });
  it("extends the nearest date interval at either edge", () => {
    expect(weeksFromBoardDrag(-720, "2026-09-14", weekly, 360)).toBe(-2);
    expect(weeksFromBoardDrag(720, "2026-09-28", weekly, 360)).toBe(2);
  });
  it("ignores clicks, missing dates and unusable measurements", () => {
    expect(weeksFromBoardDrag(7, "2026-09-14", weekly, 360)).toBe(0);
    expect(weeksFromBoardDrag(360, "", weekly, 360)).toBe(0);
    expect(weeksFromBoardDrag(360, "2026-09-14", weekly, 0)).toBe(0);
  });
  it("uses a column per week when the plan contains only one date", () => {
    expect(weeksFromBoardDrag(360, "2026-09-14", weekly.slice(0, 1), 360)).toBe(1);
  });
});
