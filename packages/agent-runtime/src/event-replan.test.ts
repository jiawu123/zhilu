import { describe, expect, it } from "vitest";
import type { ImpactDiff, PlanEvent, PlanNode, PlanState } from "@zhilu/contracts";
import { compileEventReplan, EventReplanValidationError, prepareEventReplanInput, type EventReplanDraft } from "./event-replan";

function fixture() {
  const task = (id: string, startDate: string, endDate: string, status: PlanNode["status"] = "todo"): PlanNode => ({
    id, type: "task", title: `完成成果 ${id}`, startDate, endDate, status, estimatedHours: 6,
    evidenceIds: ["e1"], manualFields: [], description: "PRIVATE_TASK_DESCRIPTION", deliverable: "保留既有成果", acceptanceCriteria: ["不可被模型重写"],
  });
  const plan: PlanState = {
    schemaVersion: "bundle@1", projectId: "writing", title: "写作计划", goal: "完成小说", version: 2, currentCommitId: "000002", weeklyHours: 8,
    updatedAt: "2026-09-12T00:00:00Z",
    goalContract: { confirmed: true, goal: "完成小说", targetDate: "2026-10-02", successCriteria: ["完成三篇修订稿"], nonGoals: ["不出版"], mustHaveOutcomes: ["完整文本"], tradeoffs: ["保留质量"], reviewCadence: "weekly" },
    userContext: { confirmed: true, currentSituation: "PRIVATE_CURRENT_SITUATION", weeklyHours: 8, constraints: ["保留周末家庭时间"], backgroundNotes: "PRIVATE_BACKGROUND" },
    nodes: [
      { ...task("done", "2026-09-05", "2026-09-11", "done"), estimatedHours: 7 },
      ...["2026-09-12", "2026-09-19", "2026-09-26"].flatMap((startDate, i) => {
        const endDate = ["2026-09-18", "2026-09-25", "2026-10-02"][i]!;
        const id = `m${i + 1}`;
        return [
          { id, type: "milestone" as const, title: `阶段${i + 1}`, status: "todo" as const, startDate, endDate, evidenceIds: ["e1"], manualFields: [] },
          { ...task(`t${i + 1}`, startDate, endDate), milestoneId: id },
        ];
      }),
      { ...task("fixed", "2026-11-14", "2026-11-20"), estimatedHours: 1 },
      { ...task("archived", "2026-09-12", "2026-09-18", "archived"), estimatedHours: 80 },
      ...["2026-09-18", "2026-09-25"].map((endDate, i) => ({ id: `c${i}`, type: "checkpoint" as const, title: "周复盘", status: "todo" as const,
        startDate: endDate, endDate, estimatedHours: 0.5, evidenceIds: ["e1"], manualFields: [] })),
    ],
    relations: [
      { id: "d0", type: "depends_on", sourceId: "t1", targetId: "done" },
      { id: "d1", type: "depends_on", sourceId: "t2", targetId: "t1" },
      { id: "d2", type: "depends_on", sourceId: "t3", targetId: "t2" },
      { id: "d3", type: "depends_on", sourceId: "fixed", targetId: "t3" },
    ],
    evidence: [{ id: "e1", title: "已有经验", summary: "按可用时间安排已有任务", sourceType: "zhihu", contentType: "experience", verificationStatus: "unverified",
      sourceUrl: "https://example.invalid/PRIVATE_SOURCE_URL", supportingQuote: "PRIVATE_SOURCE_QUOTE", applicableWhen: ["工时改变但目标未变"], caveats: ["日期建议属于推断"], riskTags: [], adoptionReason: "PRIVATE_ADOPTION" }],
  };
  const event: PlanEvent = { id: "event-1", type: "constraint_changed", title: "每周时间减少", description: "PRIVATE_EVENT_PROSE", confirmed: true,
    occurredAt: "2026-09-12T00:00:00Z", targetNodeIds: [], changes: { weeklyHours: 3 } };
  const impact: ImpactDiff = { eventId: event.id, affectedNodeIds: ["t1", "t2", "t3", "m1", "m2", "m3"], tasksToRescheduleIds: ["t1", "t2", "t3"],
    unaffectedNodeIds: ["done", "fixed", "c0", "c1"], blockedNodeIds: [], decisionsToReevaluateIds: [], invalidatedAssumptionIds: [] };
  const output: EventReplanDraft = { status: "scheduled", summary: "保留成果质量和原工时，将任务依次延长至三周。", usedEvidenceIds: ["e1"], changes: [
    { nodeId: "t1", startDate: "2026-09-12", endDate: "2026-10-02", reason: "每周可用时间减少" },
    { nodeId: "t2", startDate: "2026-10-03", endDate: "2026-10-23", reason: "等待前序任务完成" },
    { nodeId: "t3", startDate: "2026-10-24", endDate: "2026-11-13", reason: "保留验收与质量" },
  ] };
  const compile = () => compileEventReplan(plan, event, impact, prepareEventReplanInput(plan, event, impact), output, { patchId: "patch-1", runId: "run-1" });
  return { plan, event, impact, output, compile };
}

describe("model event date replan", () => {
  it("compiles only changed dates and parent envelopes, preserves facts and reports unapproved deadline extension", () => {
    const { plan, compile } = fixture();
    const before = structuredClone(plan);
    const { patch, processing } = compile();
    expect(plan).toEqual(before);
    expect(patch).toMatchObject({ baseVersion: 2, origin: "agent", eventId: "event-1" });
    expect(patch.operations[0]).toEqual({ op: "set_weekly_hours", weeklyHours: 3 });
    expect(patch.operations).toHaveLength(7);
    const changed = patch.operations.filter(operation => operation.op === "update_node");
    expect(changed.map(operation => operation.nodeId).sort()).toEqual(["m1", "m2", "m3", "t1", "t2", "t3"]);
    expect(changed.every(operation => Object.keys(operation.changes).every(key => ["startDate", "endDate", "adjustmentReason"].includes(key)))).toBe(true);
    expect(processing).toMatchObject({ mode: "model", researchNeeded: false, usedEvidenceIds: ["e1"], runId: "run-1" });
    expect(processing.warnings.join(" ")).toContain("2026-11-20");
    expect(processing.warnings.join(" ")).toContain("均摊估算");
    expect(processing.warnings.join(" ")).toContain("原目标日期 2026-10-02 未修改");
    expect(processing.warnings.join(" ")).toContain("周复盘节点未自动");
  });

  it("sends bounded evidence, confirmed constraints and scheduling boundaries without private prose", () => {
    const { plan, event, impact } = fixture();
    const input = prepareEventReplanInput(plan, event, impact);
    expect(JSON.stringify(input)).not.toContain("PRIVATE_");
    expect(input.context.constraints).toEqual(plan.userContext!.constraints);
    expect(input.context.eligibleTasks).toHaveLength(3);
    expect(input.context.fixedSchedule.map(node => node.id)).toEqual(["done", "fixed", "c0", "c1"]);
    expect(input.context.weeks).toHaveLength(52);
    expect(input.context.weeks[1]!.fixedHours).toBe(0.5);
    expect(input.context.weeks[0]!.capacityHours).toBe(8);
    plan.userContext!.constraints = ["很长的限制".repeat(5000)];
    expect(() => prepareEventReplanInput(plan, event, impact)).toThrow("输入上限");
  });

  it("limits selected existing evidence to eight without inventing or upgrading sources", () => {
    const { plan, event, impact, output, compile } = fixture();
    plan.evidence = Array.from({ length: 12 }, (_, i) => ({ ...plan.evidence[0]!, id: `e${i + 1}`, summary: "证据摘要".repeat(200) }));
    plan.nodes.find(node => node.id === "t1")!.evidenceIds = plan.evidence.map(card => card.id);
    const input = prepareEventReplanInput(plan, event, impact);
    expect(input.context.evidence).toHaveLength(8);
    expect(input.context.evidence.every(card => card.summary.length === 300 && card.verificationStatus === "unverified")).toBe(true);
    output.usedEvidenceIds = ["e12"];
    expect(compile).toThrow("未知或重复证据");
  });

  it.each([
    ["unconfirmed event", (f: ReturnType<typeof fixture>) => { f.event.confirmed = false; }],
    ["wrong event type", (f: ReturnType<typeof fixture>) => { f.event.type = "knowledge_gap"; }],
    ["invalid hours", (f: ReturnType<typeof fixture>) => { f.event.changes!.weeklyHours = NaN; }],
    ["excess hours", (f: ReturnType<typeof fixture>) => { f.event.changes!.weeklyHours = 81; }],
    ["research-ready version", (f: ReturnType<typeof fixture>) => { f.plan.version = 1; }],
    ["wrong event impact", (f: ReturnType<typeof fixture>) => { f.impact.eventId = "other"; }],
    ["missing schedule hours", (f: ReturnType<typeof fixture>) => { delete f.plan.nodes.find(node => node.id === "fixed")!.estimatedHours; }],
    ["missing evidence", (f: ReturnType<typeof fixture>) => { f.plan.nodes.find(node => node.id === "t1")!.evidenceIds = ["invented"]; }],
  ])("rejects %s before sending a model request", (_name, mutate) => {
    const f = fixture(); mutate(f);
    expect(() => prepareEventReplanInput(f.plan, f.event, f.impact)).toThrow(EventReplanValidationError);
  });

  it.each(["fixed", "done", "archived", "m1", "unknown"])("does not let the model move %s", id => {
    const { output, compile } = fixture();
    output.changes[0]!.nodeId = id;
    expect(compile).toThrow("范围外节点");
  });

  it("rejects completed or archived tasks even if impact incorrectly includes them", () => {
    for (const id of ["done", "archived"]) {
      const { plan, event, impact } = fixture();
      impact.tasksToRescheduleIds.push(id); impact.affectedNodeIds.push(id);
      expect(() => prepareEventReplanInput(plan, event, impact)).toThrow("已完成或已归档");
    }
  });

  it("rejects unknown fields, duplicate changes and fabricated evidence", () => {
    const f = fixture();
    const input = prepareEventReplanInput(f.plan, f.event, f.impact);
    const compile = (output: unknown) => compileEventReplan(f.plan, f.event, f.impact, input, output, { patchId: "p", runId: "r" });
    for (const field of ["approved", "operations", "evidence"]) expect(() => compile({ ...f.output, [field]: true })).toThrow("未知字段");
    expect(() => compile({ ...f.output, changes: [{ ...f.output.changes[0], estimatedHours: 1 }] })).toThrow("未知字段");
    expect(() => compile({ ...f.output, changes: [f.output.changes[0], f.output.changes[0]] })).toThrow("重复");
    expect(() => compile({ ...f.output, usedEvidenceIds: ["invented"] })).toThrow("未知或重复证据");
  });

  it("protects manual dates, but omits unchanged locked values and preserves locked reasons", () => {
    const f = fixture();
    const task = f.plan.nodes.find(node => node.id === "t1")!;
    task.manualFields = ["startDate", "adjustmentReason"];
    task.adjustmentReason = "用户自己的解释";
    const operation = f.compile().patch.operations.find(operation => operation.op === "update_node" && operation.nodeId === "t1");
    expect(operation).toEqual({ op: "update_node", nodeId: "t1", changes: { endDate: "2026-10-02" } });
    task.manualFields.push("endDate");
    expect(f.compile).toThrow("已被用户锁定");
  });

  it("does not overwrite locked milestone boundaries", () => {
    const { plan, compile } = fixture();
    plan.nodes.find(node => node.id === "m1")!.manualFields = ["endDate"];
    expect(compile).toThrow("里程碑 m1");
  });

  it.each(["2026-02-30", "2026-13-01", "not-a-date", "2027-09-12"])("rejects invalid or unbounded date %s", endDate => {
    const { output, compile } = fixture(); output.changes[2]!.endDate = endDate;
    expect(compile).toThrow(EventReplanValidationError);
  });

  it("does not backdate new starts before the event", () => {
    const { output, compile } = fixture(); output.changes[0]!.startDate = "2026-09-11";
    expect(compile).toThrow("事件之前");
  });

  it("does not move an unfinished task into the past to evade the budget", () => {
    const f = fixture();
    f.event.occurredAt = "2026-09-20T00:00:00Z";
    f.plan.nodes.find(node => node.id === "c0")!.status = "done";
    f.output.changes[0]!.endDate = "2026-09-19";
    expect(f.compile).toThrow("结束日期放到已确认事件之前");
  });

  it("requires rescheduling an unchanged overdue unfinished task rather than hiding its workload", () => {
    const f = fixture();
    f.event.occurredAt = "2026-10-03T00:00:00Z";
    f.plan.nodes.filter(node => node.type === "checkpoint").forEach(node => { node.status = "done"; });
    f.event.changes!.weeklyHours = 10;
    f.output.changes = [{ nodeId: "t1", startDate: "2026-09-12", endDate: "2026-09-18", reason: "保持原始排期" }];
    expect(f.compile).toThrow("未完成节点 t1 的结束日期早于事件");
  });

  it.each(["todo", "in_progress"] as const)("cannot spread unfinished %s work into the past to evade the new budget", status => {
    const f = fixture();
    const node = f.plan.nodes.find(node => node.id === "t1")!;
    Object.assign(node, { status, startDate: "2026-09-01", endDate: "2026-09-30", estimatedHours: 12 });
    delete node.milestoneId;
    f.plan.nodes = [node];
    f.plan.relations = [];
    f.event.occurredAt = "2026-09-15T00:00:00Z";
    f.impact.affectedNodeIds = ["t1"]; f.impact.tasksToRescheduleIds = ["t1"];
    f.output.changes = [{ nodeId: "t1", startDate: "2026-09-01", endDate: "2026-09-15", reason: "错误地将未完成工作分摊到过去" }];
    expect(f.compile).toThrow("合计 12.00 小时，超过 3 小时预算");
    f.output.changes[0]!.endDate = "2026-10-12";
    const result = f.compile();
    expect(result.processing.warnings.join(" ")).toContain("不视作已经投入");
    if (status === "in_progress") expect(result.processing.warnings.join(" ")).toContain("缺少剩余工时记录");
  });

  it("uses identical conservative future workload in fixedHours and final validation", () => {
    const f = fixture();
    const fixed = f.plan.nodes.find(node => node.id === "fixed")!;
    Object.assign(fixed, { startDate: "2026-09-01", endDate: "2026-09-15", estimatedHours: 4 });
    f.plan.relations = f.plan.relations.filter(relation => relation.id !== "d3");
    f.event.occurredAt = "2026-09-15T00:00:00Z";
    const input = prepareEventReplanInput(f.plan, f.event, f.impact);
    expect(input.context.weeks.find(week => week.startDate === "2026-09-15")!.fixedHours).toBe(4.5);
    expect(f.compile).toThrow("超过 3 小时预算");
  });

  it("rejects overdue fixed task/checkpoint workload before a model call because it cannot move them", () => {
    for (const id of ["fixed", "c0"]) {
      const f = fixture();
      Object.assign(f.plan.nodes.find(node => node.id === id)!, { startDate: "2026-09-01", endDate: "2026-09-11" });
      expect(() => prepareEventReplanInput(f.plan, f.event, f.impact)).toThrow(`未完成节点 ${id} 的结束日期早于事件`);
    }
  });

  it("keeps done workload on its historical schedule and counts its current-week occupancy", () => {
    const f = fixture();
    const done = f.plan.nodes.find(node => node.id === "done")!;
    Object.assign(done, { startDate: "2026-09-01", endDate: "2026-09-15", estimatedHours: 12 });
    f.plan.relations = f.plan.relations.filter(relation => relation.id !== "d0");
    f.event.occurredAt = "2026-09-15T00:00:00Z";
    const input = prepareEventReplanInput(f.plan, f.event, f.impact);
    expect(input.context.weeks[0]!.fixedHours).toBeCloseTo(5.6);
    expect(input.context.weeks.find(week => week.startDate === "2026-09-15")!.fixedHours).toBeCloseTo(1.3);
  });

  it("checks predecessor and unchanged successor dependencies", () => {
    const f = fixture();
    f.output.changes[1]!.startDate = "2026-10-02";
    expect(f.compile).toThrow("依赖排期冲突");
    f.output.changes[1]!.startDate = "2026-10-03";
    f.output.changes[2]!.endDate = "2026-11-14";
    expect(f.compile).toThrow("fixed 必须在 t3");
  });

  it("includes and validates milestone dependency boundaries after the parent date moves", () => {
    const f = fixture();
    f.plan.relations.push({ id: "parent-dependency", type: "depends_on", sourceId: "fixed", targetId: "m3" });
    const input = prepareEventReplanInput(f.plan, f.event, f.impact);
    expect(input.context.dependencies).toContainEqual({ dependentId: "fixed", prerequisiteId: "m3" });
    expect(input.context.milestones[2]!.childNodeIds).toEqual(["t3"]);
    // Remove the direct task edge so the parent edge is the only enforcing boundary.
    f.plan.relations = f.plan.relations.filter(relation => relation.id !== "d3");
    f.output.changes[2]!.endDate = "2026-11-14";
    expect(f.compile).toThrow("fixed 必须在 m3");
  });

  it("counts unchanged checkpoint and task occupancy in the new budget", () => {
    const f = fixture();
    f.plan.nodes.find(node => node.id === "c0")!.estimatedHours = 1.5;
    expect(f.compile).toThrow("超过 3 小时预算");
    f.plan.nodes.find(node => node.id === "c0")!.estimatedHours = 0.5;
    f.plan.nodes.find(node => node.id === "fixed")!.estimatedHours = 4;
    expect(f.compile).toThrow("超过 3 小时预算");
  });

  it("rejects stale or altered prepared input", () => {
    const f = fixture();
    const input = prepareEventReplanInput(f.plan, f.event, f.impact);
    input.context.weeklyHours = 80;
    expect(() => compileEventReplan(f.plan, f.event, f.impact, input, f.output, { patchId: "p", runId: "r" })).toThrow("输入与当前计划不一致");
  });

  it("supports honest unschedulable responses without fabricating a fallback patch", () => {
    const { output, compile } = fixture();
    output.status = "unschedulable"; output.summary = "锁定日期无法满足新工时"; output.changes = [];
    expect(compile).toThrow("当前约束下无法排期：锁定日期无法满足新工时");
  });

  it("distinguishes a budget-only change from an unchanged valid schedule", () => {
    const { plan, event, output, compile } = fixture();
    event.changes!.weeklyHours = 10;
    output.changes = [{ nodeId: "t1", startDate: "2026-09-12", endDate: "2026-09-18", reason: "不需要调整" }];
    expect(compile().patch.operations).toEqual([{ op: "set_weekly_hours", weeklyHours: 10 }]);
    event.changes!.weeklyHours = plan.weeklyHours;
    expect(compile().patch.operations).toEqual([]);
  });
});

function windowFixture() {
  const f = fixture();
  f.plan.research = { mode: "live", runId: "research-model", selectedRouteId: "route-a", routeCandidates: [],
    roadmapper: { mode: "model", runId: "roadmapper-model", recommendationReason: "在周内依次执行", recommendationEvidenceIds: [], warnings: [] } };
  const first = f.plan.nodes.find(node => node.id === "t1")!, second = f.plan.nodes.find(node => node.id === "t2")!;
  Object.assign(second, { startDate: first.startDate, endDate: first.endDate });
  first.estimatedHours = 2; second.estimatedHours = 2;
  f.plan.relations.forEach(relation => { relation.hard = true; });
  f.event.changes!.weeklyHours = 10;
  f.output.changes = [];
  return { ...f, first, second };
}

describe("existing Roadmapper weekly execution windows", () => {
  it("preserves a source-backed same-window dependency when only the budget changes", () => {
    const f = windowFixture(), before = structuredClone(f.plan);
    const input = prepareEventReplanInput(f.plan, f.event, f.impact);
    expect(input.context.dependencies).toContainEqual({ dependentId: "t2", prerequisiteId: "t1", windowKind: "shared_week" });
    expect(f.compile().patch.operations).toEqual([{ op: "set_weekly_hours", weeklyHours: 10 }]);
    expect(f.compile().processing.warnings.join()).toContain("同一执行窗口");
    expect(f.plan).toEqual(before);
  });

  it("accepts moving the authorized pair together and leaves dependency/status enforcement intact", () => {
    const f = windowFixture();
    f.output.changes = ["t1", "t2"].map(nodeId => ({ nodeId, startDate: "2026-09-19", endDate: "2026-09-25", reason: "同一周内先完成前置任务，再完成后续任务" }));
    const result = f.compile();
    expect(result.patch.operations.filter(op => op.op === "update_node").map(op => op.nodeId)).toEqual(["t1", "t2", "m1"]);
    f.second.status = "in_progress";
    expect(f.compile).toThrow("硬依赖");
  });

  it("preserves locked same-window dates, but still rejects changing a locked date", () => {
    const f = windowFixture();
    f.first.manualFields = ["startDate", "endDate"]; f.second.manualFields = ["startDate", "endDate"];
    expect(() => f.compile()).not.toThrow();
    f.output.changes = ["t1", "t2"].map(nodeId => ({ nodeId, startDate: "2026-09-19", endDate: "2026-09-25", reason: "尝试移动锁定日期" }));
    expect(f.compile).toThrow("已被用户锁定");
  });

  it("does not let shared windows hide insufficient capacity or cycles", () => {
    const f = windowFixture();
    f.event.changes!.weeklyHours = 3;
    expect(f.compile).toThrow("超过 3 小时预算");
    f.event.changes!.weeklyHours = 10;
    f.plan.relations.push({ id: "reverse", type: "depends_on", sourceId: "t1", targetId: "t2", hard: true });
    expect(f.compile).toThrow("循环依赖");
  });

  it.each(["non-model", "new-merge", "partial-overlap", "reversed", "long-window", "milestone"])("still rejects %s dependency overlap", kind => {
    const f = windowFixture();
    if (kind === "non-model") delete f.plan.research;
    if (kind === "new-merge") {
      Object.assign(f.second, { startDate: "2026-09-19", endDate: "2026-09-25" });
      f.output.changes = [{ nodeId: "t2", startDate: f.first.startDate!, endDate: f.first.endDate!, reason: "未经授权合并不同窗口" }];
    }
    if (kind === "partial-overlap") f.output.changes = [{ nodeId: "t2", startDate: "2026-09-13", endDate: "2026-09-20", reason: "部分重叠" }];
    if (kind === "reversed") f.output.changes = [{ nodeId: "t1", startDate: "2026-09-19", endDate: "2026-09-25", reason: "把前置任务放到后面" }];
    if (kind === "long-window") f.output.changes = ["t1", "t2"].map(nodeId => ({ nodeId, startDate: "2026-09-12", endDate: "2026-09-25", reason: "不能借过长重叠窗口隐藏依赖" }));
    if (kind === "milestone") f.plan.relations.push({ id: "parent", type: "depends_on", sourceId: "t2", targetId: "m1", hard: true });
    expect(f.compile).toThrow("依赖排期冲突");
  });
});
