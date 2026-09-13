import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BaselineProposal, EventProcessingRecord, InterviewSession, PatchProposal, PlanCommit, PlanEvent, PlanState } from "@zhilu/contracts";
import { createCommit } from "@zhilu/plan-engine";
import type { LiveResearchInput } from "@zhilu/agent-runtime";
import type { CompletedResearchEvidence } from "./research-controller";

export interface PendingChange {
  event: PlanEvent;
  patch: PatchProposal;
  impact: import("@zhilu/contracts").ImpactDiff;
  afterPreview: PlanState;
  processing?: EventProcessingRecord;
}

export class PlanRepository {
  constructor(
    private readonly dataRoot: string,
    private readonly fixturePath: string,
  ) {}

  async saveInterview(session: InterviewSession): Promise<void> {
    await writeJsonAtomic(join(this.dataRoot, "interviews", `${session.id}.json`), session);
  }

  async getInterview(id: string): Promise<InterviewSession> {
    if (!/^interview-[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid interview identifier.");
    return JSON.parse(await readFile(join(this.dataRoot, "interviews", `${id}.json`), "utf8")) as InterviewSession;
  }

  /** Read only: live research must never initialize the demo or write commits. */
  async getExistingPlan(projectId: string): Promise<PlanState> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(projectId)) throw new Error("Invalid project identifier.");
    return JSON.parse(await readFile(this.planPath(projectId), "utf8")) as PlanState;
  }

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

  async replaceBaselineProposal(projectId: string, previousId: string, proposal: BaselineProposal): Promise<void> {
    await this.saveBaselineProposal(projectId, proposal);
    await this.removeBaselineProposal(projectId, previousId);
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

  /** Private, immutable M3 input; never changes Plan or History and is not exported. */
  async saveResearchSnapshot(plan: PlanState, research: LiveResearchInput): Promise<void> {
    if (![plan.projectId, research.runId].every(id => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))) {
      throw new Error("Invalid research snapshot identifier.");
    }
    const body = `${JSON.stringify({ plan, research }, null, 2)}\n`;
    if (Buffer.byteLength(body, "utf8") > 2 * 1024 * 1024) throw new Error("Research snapshot exceeds size limit.");
    const directory = join(this.projectRoot(plan.projectId), "research-snapshots");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, `${research.runId}.json`), body, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }

  async saveResearchFailure(projectId: string, failure: {
    occurredAt: string; code: string; message: string; controller: import("@zhilu/contracts").ResearchControllerReport;
    completedResearch?: CompletedResearchEvidence;
  }): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(projectId)) throw new Error("Invalid research diagnostic identifier.");
    const { completedResearch, ...diagnostic } = failure;
    let partialArtifactId: string | undefined;
    if (completedResearch?.requests.length) {
      // Separate from M3 snapshots: these outputs have not completed the research round.
      const body = `${JSON.stringify({ artifactKind: "partial-research", ...diagnostic, completedResearch }, null, 2)}\n`;
      if (Buffer.byteLength(body, "utf8") > 2 * 1024 * 1024) throw new Error("Partial research diagnostic exceeds size limit.");
      partialArtifactId = `partial-${randomUUID()}`;
      const directory = join(this.projectRoot(projectId), "research-partials");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(join(directory, `${partialArtifactId}.json`), body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
    await writeJsonAtomic(join(this.projectRoot(projectId), "research-failure.json"), {
      ...diagnostic, ...(partialArtifactId ? { partialArtifactId } : {}),
    });
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
