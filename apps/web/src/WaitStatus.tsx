import { useEffect, useState } from "react";
import { isRoadmapChatRequest, useRequestProgress, type RequestProgress } from "./request-progress";

export function WaitStatus({ label, progress }: { label: string; progress?: RequestProgress | undefined }) {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const elapsed = Math.max(0, Math.floor((now - (progress?.startedAt ?? start)) / 1000));
  const message = progress?.steps.at(-1)?.message ?? label;
  const steps = progress?.steps ?? [];
  return <div className="model-running" aria-busy="true">
    <span className="model-spinner" aria-hidden="true"><i /></span>
    <div className="wait-content"><strong key={message} className="wait-message" role="status" aria-live="polite">{message}</strong>
      <div className="wait-meta"><small>已等待 {elapsed} 秒</small><span className="wait-dots" aria-hidden="true"><i /><i /><i /></span></div>
      <div className="wait-track" aria-hidden="true"><span /></div>
      {steps.length > 0 && <ol className="wait-recent-steps" aria-label="已收到的进度反馈">{steps.slice(-3).map((step, i) => <li key={`${step.at}-${step.message}`} className={i === Math.min(steps.length, 3) - 1 ? "is-current" : ""}><span aria-hidden="true">{i === Math.min(steps.length, 3) - 1 ? "●" : "✓"}</span>{step.message}</li>)}</ol>}
      {progress?.connectionLost && <small>暂时无法获取实时进度，原请求仍在等待响应。</small>}
      {elapsed >= 30 && <small>尚未收到最终结果，已保留输入内容，请勿重复提交。</small>}
      {progress && progress.steps.length > 1 && <details className="activity-steps"><summary>查看已执行步骤 · {progress.steps.length}</summary>
        <ol>{progress.steps.map((step, i) => <li key={i}>{step.message} <small>{Math.max(0, Math.floor((step.at - progress.startedAt) / 1000))} 秒</small></li>)}</ol>
      </details>}
    </div>
  </div>;
}

/** Covers every network wait, including history, saving and model generation. */
export function RequestActivity() {
  const requests = useRequestProgress().filter(item => !isRoadmapChatRequest(item.path));
  const foreground = requests.filter(item => !item.path.endsWith("/draft"));
  const current = foreground.at(-1) ?? requests.at(-1);
  if (!current) return null;
  return <aside className="request-activity" aria-label="当前操作进度"><WaitStatus key={current.id} label={current.label} progress={current} /></aside>;
}
