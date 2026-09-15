import { AsyncLocalStorage } from "node:async_hooks";

export interface OperationProgress {
  id: string;
  startedAt: number;
  updatedAt: number;
  status: "running" | "complete" | "failed";
  steps: Array<{ message: string; at: number }>;
}
const context = new AsyncLocalStorage<OperationProgress>();

/** Only server-authored activity descriptions; never model reasoning or private input. */
export function reportProgress(message: string) {
  const progress = context.getStore();
  if (!progress || progress.steps.at(-1)?.message === message) return;
  progress.updatedAt = Date.now();
  progress.steps.push({ message, at: progress.updatedAt });
  if (progress.steps.length > 30) progress.steps.shift();
}

export class OperationTracker {
  private entries = new Map<string, OperationProgress>();
  get(owner: string, id: string) {
    this.prune();
    return this.entries.get(`${owner}:${id}`);
  }
  async run(owner: string, id: string, work: () => Promise<void>, succeeded: () => boolean) {
    this.prune();
    const progress: OperationProgress = { id, startedAt: Date.now(), updatedAt: Date.now(), status: "running", steps: [] };
    this.entries.set(`${owner}:${id}`, progress);
    await context.run(progress, async () => {
      reportProgress("请求已收到，正在准备处理…");
      try {
        await work();
        progress.status = succeeded() ? "complete" : "failed";
      } catch (error) { progress.status = "failed"; throw error; }
      finally { progress.updatedAt = Date.now(); }
    });
  }
  private prune() {
    for (const [key, value] of this.entries) {
      if (Date.now() - value.updatedAt > 15 * 60 * 1000) this.entries.delete(key);
    }
    while (this.entries.size >= 500) this.entries.delete(this.entries.keys().next().value!);
  }
}
