import { useEffect, useRef, useState } from "react";
import { ErrorNotice } from "./ErrorNotice";

export interface ChangeContext { kind: "global" | "segment" | "task"; label: string; nodeIds: string[]; focusKey?: number }
export const globalChangeContext: ChangeContext = { kind: "global", label: "全局变更", nodeIds: [] };

export function ChangeComposer({ context, busy, pending, error, onResetContext, onSubmit, onEditHours }: {
  context: ChangeContext; busy: boolean; pending: boolean; error: string | null;
  onResetContext: () => void; onSubmit: (description: string, context: ChangeContext) => Promise<boolean>; onEditHours: () => void;
}) {
  const [description, setDescription] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (context.focusKey) input.current?.focus({ preventScroll: true }); }, [context.focusKey]);
  return <section className="change-composer" aria-label="计划变更对话">
    {error && <ErrorNotice message={error} className="composer-error" />}
    <form onSubmit={async event => { event.preventDefault(); if (!busy && description.trim() && await onSubmit(description.trim(), context)) setDescription(""); }}>
      <div className="composer-context"><span className="composer-context-dot" /><strong>{context.kind === "global" ? "变更说明" : context.kind === "task" ? "任务变更" : "阶段变更"}</strong>
        {context.kind !== "global" && <span className="composer-scope" title={context.label}>{context.label}<button type="button" aria-label="取消变更范围" disabled={busy} onClick={onResetContext}>×</button></span>}
        {context.kind === "global" && <small>目标、资源、时间及其他条件</small>}</div>
      <textarea ref={input} aria-label="变更说明" disabled={busy} maxLength={2000} rows={2} value={description} onChange={event => setDescription(event.target.value)} placeholder="请描述需要调整的事项及相关情况。" onKeyDown={event => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
      }} />
      <div className="composer-actions"><button type="button" className="composer-hours" disabled={busy} onClick={onEditHours}><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M10 6v4l3 2"/></svg>时间约束</button>
        <span aria-live="polite">{busy ? "正在处理变更说明" : pending ? "变更预览待确认" : "提交后预览，确认后生效"}</span>
        <button className="composer-send" type="submit" disabled={busy || !description.trim()} aria-label="提交变更说明"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 15V5m-5 5 5-5 5 5"/></svg></button></div>
    </form>
  </section>;
}
