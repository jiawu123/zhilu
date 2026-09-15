import { describe, expect, it } from "vitest";
import { roadmapEntrance } from "./roadmap-entrance";

describe("roadmap entrance timing", () => {
  it("always finishes reopening a project in one second, including its final goal", () => {
    for (const count of [1, 5, 30, 300]) {
      const motion = roadmapEntrance(count, "project");
      expect(motion.delay(count) + motion.cardDuration).toBe(1000);
    }
  });
  it("scales generation from two to seven seconds and preserves left-to-right ordering", () => {
    expect(roadmapEntrance(1, "generated").duration).toBe(2000);
    expect(roadmapEntrance(20, "generated").duration).toBe(3400);
    expect(roadmapEntrance(300, "generated").duration).toBe(7000);
    const motion = roadmapEntrance(20, "generated");
    expect(motion.delay(2)).toBeGreaterThan(motion.delay(1));
    expect(motion.delay(20) + motion.cardDuration).toBe(motion.duration);
  });
});
