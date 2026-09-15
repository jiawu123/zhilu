export type RoadmapEntrance = "project" | "generated";
export function roadmapEntrance(taskCount: number, mode: RoadmapEntrance) {
  const duration = mode === "project" ? 1000 : Math.min(7000, Math.max(2000, taskCount * 140 + 600));
  const cardDuration = 400;
  const interval = (duration - cardDuration) / Math.max(1, taskCount);
  return { duration, cardDuration, delay: (index: number) => Math.round(index * interval) };
}
