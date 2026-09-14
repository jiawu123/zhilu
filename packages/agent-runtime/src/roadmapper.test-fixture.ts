import type { RoadmapperInput } from "./roadmapper";

/** 离线模型边界样例：供 Runtime 与 HTTP 集成测试共用，不作为产品 fallback。 */
export function roadmapperDraftFixture(input: RoadmapperInput) {
  const { weeks, evidence } = input.context;
  const routes = (input.context.evidenceStatus === "insufficient" ? ["build"] : ["build", "practice"]).map((id, index) => {
    const evidenceIds = evidence[index] ? [evidence[index]!.id] : [];
    const boundary1 = Math.ceil(weeks.length / 3), boundary2 = Math.ceil(weeks.length * 2 / 3);
    return {
      id, title: index ? "先演练写作方法" : "先试写章节", summary: "用章节产出与读者反馈持续验证写作路线。",
      applicableWhen: [index ? "尚需建立稳定写作习惯" : "已有选题和读者反馈渠道"], evidenceIds,
      risks: ["读者可能无法按期提供反馈"], assumptions: ["每周能找到一位读者评价"],
      evidenceApplications: evidenceIds.map(evidenceId => ({ evidenceId,
        taskIds: weeks.map(week => `t${week.week}`),
        application: "采用先试写再收集反馈的建议，将章节草稿和回应读者意见作为产出；读者反馈延迟时先记录待确认的问题。" })),
      milestones: [
        { id: "m1", title: "确定选题与试写", startWeek: 1, endWeek: boundary1, evidenceIds },
        { id: "m2", title: "完成中段章节", startWeek: boundary1 + 1, endWeek: boundary2, evidenceIds },
        { id: "m3", title: "完成全文与修订", startWeek: boundary2 + 1, endWeek: weeks.length, evidenceIds },
      ],
      tasks: weeks.map(week => ({
        id: `t${week.week}`, milestoneId: week.week <= boundary1 ? "m1" : week.week <= boundary2 ? "m2" : "m3",
        title: `第 ${week.week} 周完成章节草稿与读者反馈`, week: week.week,
        hours: Math.round((week.capacityHours - week.reviewHours) * 0.8 * 100) / 100,
        deliverable: "一份包含读者批注的章节草稿", acceptanceCriteria: ["章节包含完整冲突与结局", "记录并回应三条读者意见"],
        evidenceIds, dependsOn: week.week > 1 ? [`t${week.week - 1}`] : [],
      })),
    };
  });
  return { recommendedRouteId: "build", recommendationReason: "用户已有选题且重视反馈，先试写可及早检查选题；仍须验证读者是否愿意参与。",
    recommendationEvidenceIds: evidence[0] ? [evidence[0]!.id] : [], routes };
}
