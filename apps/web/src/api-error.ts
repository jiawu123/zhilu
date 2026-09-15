import type { ResearchCoverage } from "@zhilu/contracts";

const gapKinds: Record<ResearchCoverage["gaps"][number]["kind"], true> = {
  route: true, conditions: true, counterevidence: true, evidence_count: true,
};

/** Only user-facing error fields are displayed, never the request or raw diagnostics. */
export function formatApiError(body: unknown, status: number): string {
  const payload = record(body);
  const issues = Array.isArray(payload?.issues)
    ? payload.issues.map(issue => text(record(issue)?.message)).filter(Boolean) : [];
  if (issues.length) return issues.join("；");
  const message = text(payload?.error) || `请求失败：${status}`;
  // Transport/upstream failures need their actual cause, not an unmeasured coverage placeholder.
  if (["process_failed", "startup_failed", "stdin_failed", "timeout", "output_limit", "invalid_response"].includes(text(payload?.code))) return message;
  const coverage = record(record(payload?.controller)?.coverage);
  if (coverage?.status !== "insufficient" || !Array.isArray(coverage.gaps)) return message;
  const reasons: string[] = [];
  for (const value of coverage.gaps) {
    const gap = record(value);
    if (typeof gap?.kind !== "string" || !Object.hasOwn(gapKinds, gap.kind)) continue;
    const reason = text(gap.reason).replace(/\s+/gu, " ");
    if (!reason) continue;
    const characters = [...reason];
    const bounded = characters.length > 160 ? `${characters.slice(0, 159).join("")}…` : reason;
    if (!reasons.includes(bounded)) reasons.push(bounded);
    if (reasons.length === 3) break;
  }
  return reasons.length ? `${message} 缺口：${reasons.join("；")}` : message;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
