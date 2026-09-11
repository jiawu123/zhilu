import {
  PLAN_SCHEMA_VERSION,
  type ImpactDiff,
  type PatchProposal,
  type PlanCommit,
  type PlanEvent,
  type PlanNode,
  type PlanNodeUpdate,
  type PlanState,
  type RoadmapView,
  type ValidationIssue,
  type ValidationResult,
} from "@zhilu/contracts";

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

export class PlanEngineError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(issues.map((issue) => issue.message).join("; "));
    this.name = "PlanEngineError";
  }
}

export interface BaselineInput {
  projectId: string;
  title: string;
  goal: string;
  weeklyHours: number;
  nodes: PlanNode[];
  relations: PlanState["relations"];
  evidence: PlanState["evidence"];
  createdAt: string;
}

export function createBaseline(input: BaselineInput): PlanState {
  const plan: PlanState = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    projectId: input.projectId,
    title: input.title,
    goal: input.goal,
    version: 1,
    currentCommitId: "000001",
    weeklyHours: input.weeklyHours,
    nodes: structuredClone(input.nodes),
    relations: structuredClone(input.relations),
    evidence: structuredClone(input.evidence),
    updatedAt: input.createdAt,
  };
  assertValid(validatePlan(plan));
  return plan;
}

export function validatePlan(plan: PlanState): ValidationResult {
  const issues: ValidationIssue[] = [];
  const nodeIds = new Set<string>();
  const evidenceIds = new Set(plan.evidence.map((item) => item.id));

  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION) {
    issues.push(issue("UNSUPPORTED_SCHEMA", `不支持的 Schema：${plan.schemaVersion}`, "schemaVersion"));
  }
  if (!Number.isInteger(plan.version) || plan.version < 1) {
    issues.push(issue("INVALID_VERSION", "Plan version 必须是大于 0 的整数", "version"));
  }
  if (!Number.isFinite(plan.weeklyHours) || plan.weeklyHours <= 0) {
    issues.push(issue("INVALID_WEEKLY_HOURS", "每周投入时间必须大于 0", "weeklyHours"));
  }

  for (const [index, node] of plan.nodes.entries()) {
    const path = `nodes.${index}`;
    if (nodeIds.has(node.id)) {
      issues.push(issue("DUPLICATE_NODE", `节点 ID 重复：${node.id}`, `${path}.id`));
    }
    nodeIds.add(node.id);
    if (!node.title.trim()) {
      issues.push(issue("EMPTY_TITLE", `节点 ${node.id} 缺少标题`, `${path}.title`));
    }
    if (node.startDate && !isoDatePattern.test(node.startDate)) {
      issues.push(issue("INVALID_DATE", `节点 ${node.id} 的开始日期格式无效`, `${path}.startDate`));
    }
    if (node.endDate && !isoDatePattern.test(node.endDate)) {
      issues.push(issue("INVALID_DATE", `节点 ${node.id} 的结束日期格式无效`, `${path}.endDate`));
    }
    if (node.startDate && node.endDate && node.startDate > node.endDate) {
      issues.push(issue("DATE_ORDER", `节点 ${node.id} 的结束日期早于开始日期`, path));
    }
    if (node.estimatedHours !== undefined && node.estimatedHours <= 0) {
      issues.push(issue("INVALID_HOURS", `节点 ${node.id} 的预计工时必须大于 0`, `${path}.estimatedHours`));
    }
    for (const evidenceId of node.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        issues.push(issue("MISSING_EVIDENCE", `节点 ${node.id} 引用了不存在的证据 ${evidenceId}`, `${path}.evidenceIds`));
      }
    }
  }

  const relationIds = new Set<string>();
  for (const [index, relation] of plan.relations.entries()) {
    const path = `relations.${index}`;
    if (relationIds.has(relation.id)) {
      issues.push(issue("DUPLICATE_RELATION", `关系 ID 重复：${relation.id}`, `${path}.id`));
    }
    relationIds.add(relation.id);
    if (!nodeIds.has(relation.sourceId) || !nodeIds.has(relation.targetId)) {
      issues.push(issue("BROKEN_RELATION", `关系 ${relation.id} 引用了不存在的节点`, path));
    }
    if (relation.sourceId === relation.targetId) {
      issues.push(issue("SELF_RELATION", `关系 ${relation.id} 不能指向自身`, path));
    }
  }

  for (const node of plan.nodes) {
    if (node.milestoneId && !nodeIds.has(node.milestoneId)) {
      issues.push(issue("MISSING_MILESTONE", `节点 ${node.id} 的里程碑不存在`, `nodes.${node.id}.milestoneId`));
    }
  }

  issues.push(...validateDependencyRules(plan));
  issues.push(...validateDependencyCycles(plan));
  return { valid: issues.length === 0, issues };
}

export function validateEvent(event: PlanEvent, plan: PlanState): ValidationResult {
  const issues: ValidationIssue[] = [];
  const nodeIds = new Set(plan.nodes.map((node) => node.id));
  if (!event.title.trim() || !event.description.trim()) {
    issues.push(issue("EMPTY_EVENT", "Event 必须包含标题和说明"));
  }
  for (const nodeId of event.targetNodeIds) {
    if (!nodeIds.has(nodeId)) {
      issues.push(issue("UNKNOWN_EVENT_TARGET", `Event 引用了不存在的节点 ${nodeId}`, "targetNodeIds"));
    }
  }
  if (event.type === "constraint_changed") {
    const weeklyHours = event.changes?.weeklyHours;
    if (weeklyHours === undefined || !Number.isFinite(weeklyHours) || weeklyHours <= 0) {
      issues.push(issue("INVALID_EVENT_CHANGE", "时间约束变化必须提供大于 0 的 weeklyHours", "changes.weeklyHours"));
    }
  }
  if (event.type === "custom" && event.targetNodeIds.length === 0) {
    issues.push(issue("CUSTOM_EVENT_TARGET_REQUIRED", "路标变化必须选择至少一个受影响节点", "targetNodeIds"));
  }
  return { valid: issues.length === 0, issues };
}

export function calculateImpact(plan: PlanState, event: PlanEvent): ImpactDiff {
  assertValid(validateEvent(event, plan));
  const activeNodes = plan.nodes.filter((node) => node.status !== "archived");
  const affected = new Set<string>();

  if (event.type === "constraint_changed") {
    for (const node of activeNodes) {
      if (node.type === "task" && node.status !== "done") affected.add(node.id);
    }
  }
  for (const nodeId of event.targetNodeIds) affected.add(nodeId);

  const dependents = new Map<string, string[]>();
  for (const relation of plan.relations) {
    if (relation.type !== "depends_on") continue;
    const current = dependents.get(relation.targetId) ?? [];
    current.push(relation.sourceId);
    dependents.set(relation.targetId, current);
  }
  const queue = [...affected];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    for (const dependentId of dependents.get(current) ?? []) {
      if (!affected.has(dependentId)) {
        affected.add(dependentId);
        queue.push(dependentId);
      }
    }
  }

  for (const node of activeNodes) {
    if (node.type === "task" && affected.has(node.id) && node.milestoneId) {
      affected.add(node.milestoneId);
    }
  }

  const byType = (type: PlanNode["type"]) =>
    activeNodes.filter((node) => node.type === type && affected.has(node.id)).map((node) => node.id).sort();
  const blockedNodeIds = activeNodes
    .filter((node) => node.status === "blocked" && affected.has(node.id))
    .map((node) => node.id)
    .sort();
  const affectedNodeIds = [...affected].sort();

  return {
    eventId: event.id,
    affectedNodeIds,
    invalidatedAssumptionIds: byType("assumption"),
    decisionsToReevaluateIds: byType("decision"),
    tasksToRescheduleIds: activeNodes
      .filter((node) => node.type === "task" && node.status !== "done" && affected.has(node.id))
      .map((node) => node.id)
      .sort(),
    blockedNodeIds,
    unaffectedNodeIds: activeNodes.filter((node) => !affected.has(node.id)).map((node) => node.id).sort(),
  };
}

export function validatePatch(plan: PlanState, patch: PatchProposal): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (patch.baseVersion !== plan.version) {
    issues.push(issue("VERSION_CONFLICT", `Patch 基于版本 ${patch.baseVersion}，当前版本是 ${plan.version}`, "baseVersion"));
  }
  if (!patch.reason.trim()) {
    issues.push(issue("MISSING_REASON", "Patch 必须说明修改原因", "reason"));
  }
  if (patch.origin === "agent" && !patch.eventId) {
    issues.push(issue("MISSING_EVENT", "Agent Patch 必须关联已确认 Event", "eventId"));
  }

  const nodeMap = new Map(plan.nodes.map((node) => [node.id, structuredClone(node)]));
  const relationMap = new Map(plan.relations.map((relation) => [relation.id, structuredClone(relation)]));

  for (const [index, operation] of patch.operations.entries()) {
    const path = `operations.${index}`;
    if (operation.op === "add_node") {
      if (nodeMap.has(operation.node.id)) {
        issues.push(issue("DUPLICATE_NODE", `节点已存在：${operation.node.id}`, path));
      } else {
        nodeMap.set(operation.node.id, structuredClone(operation.node));
      }
    }
    if (operation.op === "update_node") {
      const node = nodeMap.get(operation.nodeId);
      if (!node) {
        issues.push(issue("UNKNOWN_NODE", `节点不存在：${operation.nodeId}`, path));
      } else {
        const protectedFields = Object.keys(operation.changes).filter((field) =>
          node.manualFields.includes(field as keyof PlanNode),
        );
        if (patch.origin === "agent" && protectedFields.length > 0) {
          issues.push(issue("MANUAL_FIELD_PROTECTED", `Agent 不能覆盖用户字段：${protectedFields.join(", ")}`, path));
        } else {
          assignNodeChanges(node, operation.changes);
        }
      }
    }
    if (operation.op === "archive_node") {
      const node = nodeMap.get(operation.nodeId);
      if (!node) issues.push(issue("UNKNOWN_NODE", `节点不存在：${operation.nodeId}`, path));
      else node.status = "archived";
    }
    if (operation.op === "add_relation") {
      if (relationMap.has(operation.relation.id)) {
        issues.push(issue("DUPLICATE_RELATION", `关系已存在：${operation.relation.id}`, path));
      } else {
        relationMap.set(operation.relation.id, structuredClone(operation.relation));
      }
    }
    if (operation.op === "remove_relation") {
      if (!relationMap.delete(operation.relationId)) {
        issues.push(issue("UNKNOWN_RELATION", `关系不存在：${operation.relationId}`, path));
      }
    }
    if (operation.op === "set_weekly_hours" && operation.weeklyHours <= 0) {
      issues.push(issue("INVALID_WEEKLY_HOURS", "每周投入时间必须大于 0", path));
    }
  }

  if (issues.length === 0) {
    const candidate = applyPatchUnchecked(plan, patch);
    issues.push(...validatePlan(candidate).issues);
  }
  return { valid: issues.length === 0, issues };
}

export function applyPatch(plan: PlanState, patch: PatchProposal, updatedAt: string): PlanState {
  assertValid(validatePatch(plan, patch));
  const next = applyPatchUnchecked(plan, patch);
  next.updatedAt = updatedAt;
  return next;
}

export function createCommit(
  before: PlanState | null,
  after: PlanState,
  metadata: Omit<PlanCommit, "parentId" | "planVersion" | "snapshot">,
): PlanCommit {
  return {
    ...metadata,
    parentId: before?.currentCommitId ?? null,
    planVersion: after.version,
    snapshot: structuredClone(after),
  };
}

export function restoreVersion(plan: PlanState, commit: PlanCommit, patchId: string): PatchProposal {
  const operations: PatchProposal["operations"] = [];
  const targetNodes = new Map(commit.snapshot.nodes.map((node) => [node.id, node]));
  const currentIds = new Set(plan.nodes.map((node) => node.id));
  for (const node of plan.nodes) {
    if (!targetNodes.has(node.id)) operations.push({ op: "archive_node", nodeId: node.id });
  }
  for (const node of commit.snapshot.nodes) {
    if (!currentIds.has(node.id)) {
      operations.push({ op: "add_node", node: structuredClone(node) });
      continue;
    }
    const changes: PlanNodeUpdate = {
      title: node.title,
      status: node.status,
      evidenceIds: node.evidenceIds,
    };
    copyOptionalNodeFields(node, changes);
    operations.push({ op: "update_node", nodeId: node.id, changes });
  }
  for (const relation of plan.relations) operations.push({ op: "remove_relation", relationId: relation.id });
  for (const relation of commit.snapshot.relations) operations.push({ op: "add_relation", relation: structuredClone(relation) });
  operations.push({ op: "set_weekly_hours", weeklyHours: commit.snapshot.weeklyHours });
  return {
    id: patchId,
    baseVersion: plan.version,
    origin: "user",
    reason: `恢复版本 ${commit.id}`,
    operations,
  };
}

export function projectView(plan: PlanState): RoadmapView {
  const visible = plan.nodes.filter((node) => node.status !== "archived");
  const milestones = visible
    .filter((node) => node.type === "milestone")
    .map((milestone) => ({
      milestone,
      tasks: visible
        .filter((node) => node.type === "task" && node.milestoneId === milestone.id)
        .sort(compareByDate),
    }))
    .sort((left, right) => compareByDate(left.milestone, right.milestone));
  const groupedIds = new Set(milestones.flatMap((group) => [group.milestone.id, ...group.tasks.map((task) => task.id)]));
  return {
    milestones,
    ungroupedNodes: visible.filter((node) => !groupedIds.has(node.id)).sort(compareByDate),
    relations: structuredClone(plan.relations),
  };
}

function applyPatchUnchecked(plan: PlanState, patch: PatchProposal): PlanState {
  const next = structuredClone(plan);
  for (const operation of patch.operations) {
    if (operation.op === "add_node") next.nodes.push(structuredClone(operation.node));
    if (operation.op === "update_node") {
      const node = next.nodes.find((item) => item.id === operation.nodeId);
      if (node) {
        assignNodeChanges(node, operation.changes);
        if (patch.origin === "user") {
          for (const field of Object.keys(operation.changes) as Array<keyof PlanNode>) {
            if (!node.manualFields.includes(field)) node.manualFields.push(field);
          }
        }
      }
    }
    if (operation.op === "archive_node") {
      const node = next.nodes.find((item) => item.id === operation.nodeId);
      if (node) node.status = "archived";
    }
    if (operation.op === "add_relation") next.relations.push(structuredClone(operation.relation));
    if (operation.op === "remove_relation") {
      next.relations = next.relations.filter((relation) => relation.id !== operation.relationId);
    }
    if (operation.op === "set_weekly_hours") next.weeklyHours = operation.weeklyHours;
  }
  next.version += 1;
  return next;
}

function assignNodeChanges(node: PlanNode, changes: PlanNodeUpdate): void {
  Object.assign(node, changes);
}

function copyOptionalNodeFields(node: PlanNode, changes: PlanNodeUpdate): void {
  if (node.description !== undefined) changes.description = node.description;
  if (node.milestoneId !== undefined) changes.milestoneId = node.milestoneId;
  if (node.startDate !== undefined) changes.startDate = node.startDate;
  if (node.endDate !== undefined) changes.endDate = node.endDate;
  if (node.estimatedHours !== undefined) changes.estimatedHours = node.estimatedHours;
  if (node.deliverable !== undefined) changes.deliverable = node.deliverable;
  if (node.acceptanceCriteria !== undefined) changes.acceptanceCriteria = node.acceptanceCriteria;
  if (node.adjustmentReason !== undefined) changes.adjustmentReason = node.adjustmentReason;
}

function validateDependencyRules(plan: PlanState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodeMap = new Map(plan.nodes.map((node) => [node.id, node]));
  for (const relation of plan.relations) {
    if (relation.type !== "depends_on" || !relation.hard) continue;
    const source = nodeMap.get(relation.sourceId);
    const target = nodeMap.get(relation.targetId);
    if (!source || !target) continue;
    if (["ready", "in_progress", "done"].includes(source.status) && target.status !== "done") {
      issues.push(issue("HARD_DEPENDENCY_UNMET", `${source.title} 的硬依赖 ${target.title} 尚未完成`, `relations.${relation.id}`));
    }
  }
  return issues;
}

function validateDependencyCycles(plan: PlanState): ValidationIssue[] {
  const graph = new Map<string, string[]>();
  for (const relation of plan.relations) {
    if (relation.type !== "depends_on") continue;
    graph.set(relation.sourceId, [...(graph.get(relation.sourceId) ?? []), relation.targetId]);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const hasCycle = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const dependencyId of graph.get(nodeId) ?? []) {
      if (hasCycle(dependencyId)) return true;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };
  for (const node of plan.nodes) {
    if (hasCycle(node.id)) return [issue("DEPENDENCY_CYCLE", "计划中存在循环依赖", "relations")];
  }
  return [];
}

function compareByDate(left: PlanNode, right: PlanNode): number {
  return (left.startDate ?? "9999-12-31").localeCompare(right.startDate ?? "9999-12-31");
}

function issue(code: string, message: string, path?: string): ValidationIssue {
  return path ? { code, message, path } : { code, message };
}

function assertValid(result: ValidationResult): void {
  if (!result.valid) throw new PlanEngineError(result.issues);
}
