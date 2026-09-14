import type { PlanNode, PlanRelation, PlanState } from "@zhilu/contracts";

export interface PlanFieldDiff {
  key: string;
  label: string;
  before: string;
  after: string;
}

export interface PlanDiffEntry {
  id: string;
  title: string;
  kind: "global" | "changed" | "added" | "removed" | "archived" | "relation";
  fields: PlanFieldDiff[];
}

const nodeFields: Array<[keyof PlanNode, string]> = [
  ["title", "名称"], ["type", "类型"], ["description", "说明"], ["status", "状态"],
  ["milestoneId", "所属里程碑"], ["startDate", "开始日期"], ["endDate", "结束日期"],
  ["estimatedHours", "预计工时"], ["deliverable", "交付物"], ["acceptanceCriteria", "验收条件"],
  ["evidenceIds", "依据"], ["adjustmentReason", "调整原因"],
];

function fieldValue(key: keyof PlanNode, value: PlanNode[keyof PlanNode] | undefined, plan: PlanState): string {
  if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return "未设置";
  if (key === "estimatedHours") return `${value} 小时`;
  if (key === "status") return { draft: "草稿", todo: "待开始", ready: "可开始", in_progress: "进行中", blocked: "受阻", done: "已完成", archived: "已归档" }[value as PlanNode["status"]];
  if (key === "type") return { milestone: "里程碑", task: "任务", decision: "决策", assumption: "假设", checkpoint: "复盘" }[value as PlanNode["type"]];
  if (key === "milestoneId") return plan.nodes.find((node) => node.id === value)?.title ?? String(value);
  if (key === "evidenceIds") return (value as string[]).map((id) => plan.evidence.find((card) => card.id === id)?.title ?? id).join("；");
  return Array.isArray(value) ? value.join("；") : String(value);
}

function relationValue(relation: PlanRelation | undefined, plan: PlanState): string {
  if (!relation) return "无";
  const source = plan.nodes.find((node) => node.id === relation.sourceId)?.title ?? relation.sourceId;
  const target = plan.nodes.find((node) => node.id === relation.targetId)?.title ?? relation.targetId;
  const type = { depends_on: "依赖", supports: "支持", contradicts: "矛盾于", invalidates: "使其失效" }[relation.type];
  return `${source} → ${type} → ${target}${relation.hard ? "（强依赖）" : ""}`;
}

/** Compare actual plan values, not the impact graph: an affected node need not change. */
export function getPlanDiff(before: PlanState, after: PlanState): PlanDiffEntry[] {
  const entries: PlanDiffEntry[] = [];
  if (before.weeklyHours !== after.weeklyHours) entries.push({
    id: "weekly-hours", title: "全局约束", kind: "global",
    fields: [{ key: "weeklyHours", label: "每周可投入", before: `${before.weeklyHours} 小时`, after: `${after.weeklyHours} 小时` }],
  });
  for (const [key, label, previous, next] of [
    ["goal", "目标", before.goal, after.goal],
    ["targetDate", "截止日期", before.goalContract?.targetDate, after.goalContract?.targetDate],
  ]) if (previous !== next) entries.push({ id: key!, title: label!, kind: "global", fields: [{ key: key!, label: label!, before: previous ?? "未设置", after: next ?? "未设置" }] });
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));
  for (const id of new Set([...beforeNodes.keys(), ...afterNodes.keys()])) {
    const previous = beforeNodes.get(id);
    const next = afterNodes.get(id);
    const fields = nodeFields.flatMap(([key, label]) => {
      if (JSON.stringify(previous?.[key]) === JSON.stringify(next?.[key])) return [];
      return [{ key, label, before: previous ? fieldValue(key, previous[key], before) : "不存在", after: next ? fieldValue(key, next[key], after) : "已移除" }];
    });
    if (fields.length) entries.push({
      id, title: next?.title ?? previous!.title,
      kind: !previous ? "added" : !next ? "removed" : next.status === "archived" && previous.status !== "archived" ? "archived" : "changed",
      fields,
    });
  }
  const beforeRelations = new Map(before.relations.map((relation) => [relation.id, relation]));
  const afterRelations = new Map(after.relations.map((relation) => [relation.id, relation]));
  for (const id of new Set([...beforeRelations.keys(), ...afterRelations.keys()])) {
    const previous = beforeRelations.get(id);
    const next = afterRelations.get(id);
    if (previous?.type === next?.type && previous?.sourceId === next?.sourceId && previous?.targetId === next?.targetId && Boolean(previous?.hard) === Boolean(next?.hard)) continue;
    entries.push({ id: `relation-${id}`, title: "节点关系", kind: "relation", fields: [{ key: "relation", label: "关系", before: relationValue(previous, before), after: relationValue(next, after) }] });
  }
  return entries;
}
