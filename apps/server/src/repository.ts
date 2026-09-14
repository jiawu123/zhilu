import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BaselineProposal, EventProcessingRecord, InterviewSession, PatchProposal, PlanCommit, PlanEvent, PlanState, RoadmapChatState } from "@zhilu/contracts";
import { createCommit } from "@zhilu/plan-engine";
import type { LiveResearchInput } from "@zhilu/agent-runtime";
import type { CompletedResearchEvidence } from "./research-controller";
import type { InterviewDiagnostic } from "./interview";

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

  forAccount(id: string): PlanRepository {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid account identifier.");
    return new PlanRepository(join(this.dataRoot, "accounts", id), this.fixturePath);
  }

  async listInterviews() {
    const sessions = await Promise.all((await directoryEntries(join(this.dataRoot, "interviews")))
      .filter(name => /^interview-[a-f0-9-]{36}\.json$/.test(name)).map(name => this.getInterview(name.slice(0, -5))));
    return sessions.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")).map(session => ({
      id: session.id, goal: session.goal, status: session.status, questionCount: session.questions.length,
      answerCount: session.answers.length, draftCount: session.draftAnswers?.length ?? 0,
      createdAt: session.createdAt, updatedAt: session.updatedAt, projectId: session.projectId,
    }));
  }

  async listProjects() {
    const plans: PlanState[] = [];
    for (const id of await directoryEntries(this.dataRoot)) {
      if (!/^(project-[a-f0-9]{8}|agent-engineer-demo)$/.test(id)) continue;
      try { plans.push(await this.getExistingPlan(id)); } catch (error) { if (!isMissingFile(error)) throw error; }
    }
    return plans.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(plan => ({
      id: plan.projectId, goal: plan.goal, updatedAt: plan.updatedAt, version: plan.version,
      awaitingConfirmation: plan.evidence.some(item => item.riskTags.includes("等待知乎研究")),
    }));
  }

  async saveInterview(session: InterviewSession): Promise<void> {
    await writeJsonAtomic(join(this.dataRoot, "interviews", `${session.id}.json`), session);
  }

  async getInterview(id: string): Promise<InterviewSession> {
    if (!/^interview-[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid interview identifier.");
    return JSON.parse(await readFile(join(this.dataRoot, "interviews", `${id}.json`), "utf8")) as InterviewSession;
  }

  async saveInterviewDiagnostic(diagnostic: InterviewDiagnostic): Promise<void> {
    if (!/^interview-[a-f0-9-]{36}$/.test(diagnostic.sessionId)
      || !/^interview-run-[a-f0-9-]{36}$/.test(diagnostic.runId)
      || !Number.isSafeInteger(diagnostic.attempt) || diagnostic.attempt < 1 || diagnostic.attempt > 3) {
      throw new Error("Invalid interview diagnostic identifier.");
    }
    await writeJsonAtomic(join(this.dataRoot, "diagnostics", "interviews", diagnostic.sessionId,
      `${diagnostic.runId}-attempt-${diagnostic.attempt}.json`), diagnostic);
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

  async getRoadmapChat(projectId: string): Promise<RoadmapChatState> {
    try { return JSON.parse(await readFile(join(this.projectRoot(projectId), "chat.json"), "utf8")); }
    catch (error) { if (isMissingFile(error)) return { messages: [] }; throw error; }
  }

  async saveRoadmapChat(projectId: string, chat: RoadmapChatState): Promise<void> {
    await writeJsonAtomic(join(this.projectRoot(projectId), "chat.json"), chat);
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

  /** Restore actionable proposals without deleting older records needed for conflict checks. */
  async getActivePending(plan: Pick<PlanState, "projectId" | "version">): Promise<PendingChange[]> {
    const eventTime = (pending: PendingChange) => {
      const parsed = Date.parse(pending.event.occurredAt);
      return Number.isFinite(parsed) ? parsed : -Infinity;
    };
    return (await this.getPending(plan.projectId))
      .filter(pending => pending.patch.baseVersion === plan.version && pending.afterPreview.projectId === plan.projectId)
      .sort((left, right) => eventTime(right) - eventTime(left)
        || (left.patch.id < right.patch.id ? -1 : left.patch.id > right.patch.id ? 1 : 0));
  }

  async removePending(projectId: string, patchId: string): Promise<void> {
    await rm(join(this.projectRoot(projectId), "pending", `${patchId}.json`), { force: true });
  }

  async saveBaselineProposal(projectId: string, proposal: BaselineProposal): Promise<void> {
    await writeJsonAtomic(join(this.projectRoot(projectId), "planning-history", `${proposal.id}.json`), {
      id: proposal.id, createdAt: proposal.createdAt, conversation: proposal.conversation ?? [],
    });
    await writeJsonAtomic(join(this.projectRoot(projectId), "baseline-proposals", `${proposal.id}.json`), proposal);
  }

  async getPlanningHistory(projectId: string): Promise<Array<{ id: string; createdAt: string; conversation: Array<{ role: string; content: string }> }>> {
    const directory = join(this.projectRoot(projectId), "planning-history");
    const entries = await Promise.all((await directoryEntries(directory)).filter(name => name.endsWith(".json"))
      .map(async name => JSON.parse(await readFile(join(directory, name), "utf8"))));
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(projectId)) throw new Error("Invalid project identifier.");
    return join(this.dataRoot, projectId, ".plan");
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
}

async function directoryEntries(path: string): Promise<string[]> {
  try { return await readdir(path); } catch (error) { if (isMissingFile(error)) return []; throw error; }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
