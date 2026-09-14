import { resolve } from "node:path";
import { PlanRepository } from "../src/repository";
import { createCommit, validatePlan } from "@zhilu/plan-engine";

// Explicit one-project migration; old versions remain recoverable in commit history.
const projectId = process.argv[2];
if (!projectId) throw new Error("Usage: remove-review-nodes.ts <projectId>");
const repository = new PlanRepository(process.env.ZHILU_DATA_DIR ?? resolve("data"), resolve("examples/agent-engineer/plan-state.json"));
const before = await repository.getExistingPlan(projectId);
const removed = new Set(before.nodes.filter(node => node.type === "checkpoint").map(node => node.id));
if (removed.size) {
  const next = structuredClone(before);
  next.nodes = next.nodes.filter(node => !removed.has(node.id));
  next.relations = next.relations.filter(relation => !removed.has(relation.sourceId) && !removed.has(relation.targetId));
  next.version++;
  next.currentCommitId = String(next.version).padStart(6, "0");
  next.updatedAt = new Date().toISOString();
  const validation = validatePlan(next);
  if (!validation.valid) throw new Error(validation.issues.map(issue => issue.message).join("; "));
  const commit = createCommit(before, next, { id: next.currentCommitId, createdAt: next.updatedAt, actor: "user", reason: "移除每周复盘功能及自动复盘节点" });
  await repository.savePlan(next);
  await repository.saveCommit(projectId, commit);
  console.log(JSON.stringify({ projectId, removed: removed.size, version: next.version }));
} else console.log(JSON.stringify({ projectId, removed: 0, version: before.version }));
