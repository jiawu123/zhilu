import type { PlanState } from "@zhilu/contracts";

/** Synthetic, offline confirmed context. Never used by production routes. */
export function confirmedPlan(): PlanState {
  return {
    schemaVersion: "bundle@1", projectId: "live-test", title: "Synthetic", goal: "stale goal",
    version: 1, currentCommitId: "000001", weeklyHours: 1, updatedAt: "2026-09-01T00:00:00Z",
    nodes: [], relations: [], evidence: [],
    userContext: { currentSituation: "Python初学者", weeklyHours: 10, constraints: ["业余时间"],
      backgroundNotes: "已练习基础语法", confirmed: true },
    goalContract: { goal: "完成 Agent 项目", targetDate: "2026-12-01", successCriteria: ["有基本测试"],
      nonGoals: ["商业上线"], mustHaveOutcomes: ["可运行项目"], tradeoffs: ["优先简单实现"],
      reviewCadence: "weekly", confirmed: true },
  };
}
