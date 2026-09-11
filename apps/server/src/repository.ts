import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BaselineProposal, PatchProposal, PlanCommit, PlanEvent, PlanState } from "@zhilu/contracts";
import { createCommit } from "@zhilu/plan-engine";

export interface PendingChange {
  event: PlanEvent;
  patch: PatchProposal;
  impact: import("@zhilu/contracts").ImpactDiff;
  afterPreview: PlanState;
}

export class PlanRepository {
  constructor(
    private readonly dataRoot: string,
    private readonly fixturePath: string,
  ) {}

  async getPlan(projectId: string): Promise<PlanState> {
    const path = this.planPath(projectId);
    try {
      return JSON.parse(await readFile(path, "utf8")) as PlanState;
    } catch (error) {
      if (!isMissingFile(error) || projectId !== "agent-engineer-demo") throw error;
      const plan = JSON.parse(await readFile(this.fixturePath, "utf8")) as PlanState;
      await this.savePlan(plan);
      const baseline = createCommit(null, plan, {
        id: plan.currentCommitId,
        createdAt: plan.updatedAt,
        actor: "system",
        reason: "Demo Baseline",
      });
      await this.saveCommit(plan.projectId, baseline);
      return plan;
    }
  }

  async savePlan(plan: PlanState): Promise<void> {
    await writeJsonAtomic(this.planPath(plan.projectId), plan);
  }

  async saveCommit(projectId: string, commit: PlanCommit): Promise<void> {
    await writeJsonAtomic(join(this.projectRoot(projectId), "commits", `${commit.id}.json`), commit);
  }

  async getHistory(projectId: string): Promise<PlanCommit[]> {
    const directory = join(this.projectRoot(projectId), "commits");
    try {
      const files = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort().reverse();
      return await Promise.all(
        files.map(async (file) => JSON.parse(await readFile(join(directory, file), "utf8")) as PlanCommit),
      );
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
  }

  async savePending(projectId: string, pending: PendingChange): Promise<void> {
    await writeJsonAtomic(join(this.projectRoot(projectId), "pending", `${pending.patch.id}.json`), pending);
  }

  async getPending(projectId: string): Promise<PendingChange[]> {
    const directory = join(this.projectRoot(projectId), "pending");
    try {
      const files = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort();
      return await Promise.all(
        files.map(async (file) => JSON.parse(await readFile(join(directory, file), "utf8")) as PendingChange),
      );
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
  }

  async removePending(projectId: string, patchId: string): Promise<void> {
    await rm(join(this.projectRoot(projectId), "pending", `${patchId}.json`), { force: true });
  }

  async saveBaselineProposal(projectId: string, proposal: BaselineProposal): Promise<void> {
    await writeJsonAtomic(join(this.projectRoot(projectId), "baseline-proposals", `${proposal.id}.json`), proposal);
  }

  async getBaselineProposals(projectId: string): Promise<BaselineProposal[]> {
    const directory = join(this.projectRoot(projectId), "baseline-proposals");
    try {
      const files = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort();
      return await Promise.all(
        files.map(async (file) => JSON.parse(await readFile(join(directory, file), "utf8")) as BaselineProposal),
      );
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
  }

  async removeBaselineProposal(projectId: string, proposalId: string): Promise<void> {
    await rm(join(this.projectRoot(projectId), "baseline-proposals", `${proposalId}.json`), { force: true });
  }

  private planPath(projectId: string): string {
    return join(this.projectRoot(projectId), "plan.json");
  }

  private projectRoot(projectId: string): string {
    return join(this.dataRoot, projectId, ".plan");
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
