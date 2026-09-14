import { describe, expect, it } from "vitest";
import { selectCurrentPending } from "./pending-selection";

const plan = { projectId: "current-project", version: 5 };
const pending = (id: string, occurredAt: string, baseVersion = 5, projectId = plan.projectId) => ({
  patch: { id, baseVersion }, event: { occurredAt }, afterPreview: { projectId },
});

describe("current pending proposal selection", () => {
  it("does not reopen stale or foreign proposals when the current plan has advanced", () => {
    expect(selectCurrentPending([
      pending("old-v2", "2026-09-14T12:00:00Z", 2),
      pending("old-v3", "2026-09-14T13:00:00Z", 3),
      pending("foreign", "2026-09-14T14:00:00Z", 5, "another-project"),
    ], plan)).toBeNull();
  });

  it("selects the newest current proposal after filtering project and exact base version", () => {
    const older = pending("current-older", "2026-09-14T10:00:00Z");
    const newest = pending("current-newest", "2026-09-14T11:00:00Z");
    expect(selectCurrentPending([
      pending("stale", "2026-09-14T15:00:00Z", 4),
      pending("future", "2026-09-14T16:00:00Z", 6),
      pending("foreign", "2026-09-14T17:00:00Z", 5, "another-project"),
      older, newest,
    ], plan)).toBe(newest);
  });

  it("compares parsed timestamps with offsets instead of timestamp text", () => {
    const lexicallyLater = pending("a", "2026-09-14T10:00:00+08:00");
    const chronologicallyLater = pending("b", "2026-09-14T03:00:00Z");
    expect(selectCurrentPending([lexicallyLater, chronologicallyLater], plan)).toBe(chronologicallyLater);
  });

  it("puts invalid timestamps behind valid timestamps", () => {
    const valid = pending("z", "2026-09-14T00:00:00Z");
    expect(selectCurrentPending([pending("a", "not-a-date"), pending("b", ""), valid], plan)).toBe(valid);
  });

  it.each([
    ["2026-09-14T10:00:00+08:00", "2026-09-14T02:00:00Z"],
    ["invalid-time", "also-invalid"],
  ])("breaks equal or invalid timestamps deterministically by patch ID", (firstTime, secondTime) => {
    const first = pending("patch-a", firstTime), second = pending("patch-b", secondTime);
    expect(selectCurrentPending([second, first], plan)).toBe(first);
    expect(selectCurrentPending([first, second], plan)).toBe(first);
  });

  it("preserves the input array and proposal objects", () => {
    const older = pending("old", "2026-09-13T00:00:00Z"), newer = pending("new", "2026-09-14T00:00:00Z");
    const proposals = Object.freeze([older, newer]);
    const before = structuredClone(proposals);
    expect(selectCurrentPending(proposals, plan)).toBe(newer);
    expect(proposals).toEqual(before);
    expect(proposals[0]).toBe(older);
    expect(proposals[1]).toBe(newer);
    expect(selectCurrentPending([], plan)).toBeNull();
  });
});
