import type { PlanNode } from "@zhilu/contracts";

export function TaskDeadline({ task }: { task: Pick<PlanNode, "endDate"> }) {
  return <span className="task-deadline"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="10" rx="2" /><path d="M5 2v3M11 2v3M3 7h10" /></svg>{task.endDate ? <><span>截止</span><time dateTime={task.endDate}>{task.endDate.replaceAll("-", "/")}</time></> : "待安排"}</span>;
}
