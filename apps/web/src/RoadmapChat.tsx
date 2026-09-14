import { ChangeComposer, globalChangeContext, type ChangeContext } from "./ChangeComposer";
import { CHAT_MESSAGE_LIMIT, chatContextPrefix, contextualChatMessage, displayChatMessage } from "./roadmap-chat-context";
import { useEffect, useRef, useState } from "react";
import type { PlanState, RoadmapChatState } from "@zhilu/contracts";
import { trackedFetch, useRequestProgress } from "./request-progress";
import { WaitStatus } from "./WaitStatus";
import { getPlanDiff } from "./plan-diff";
import { formatApiError } from "./api-error";

async function chatRequest(path: string, body?: unknown, signal?: AbortSignal): Promise<RoadmapChatState> {
  const response = await trackedFetch(path, { ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}), ...(signal ? { signal } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(formatApiError(result, response.status));
  return result;
}

export function RoadmapChat({ plan, onApplied, context = globalChangeContext, onResetContext = () => {}, onEditHours = () => {}, externalBusy = false, externalError = null }: {
  plan: PlanState; onApplied: () => Promise<void>; context?: ChangeContext;
  onResetContext?: () => void; onEditHours?: () => void; externalBusy?: boolean; externalError?: string | null;
}) {
  const [chat, setChat] = useState<RoadmapChatState>({ messages: [] });
  const [busy, setBusy] = useState<"send" | "apply" | "discard" | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const path = `/api/projects/${encodeURIComponent(plan.projectId)}/chat`;
  const progress = useRequestProgress().find(item => item.path === path || item.path.startsWith(`${path}/`));
  useEffect(() => {
    const abort = new AbortController(); controller.current = abort;
    void chatRequest(path, undefined, abort.signal).then(setChat).catch(reason => {
      if (!abort.signal.aborted) setError(reason.message);
    }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => { controller.current?.abort(); };
  }, [path]);
  useEffect(() => { conversation.current?.scrollTo({ top: conversation.current.scrollHeight }); }, [chat.messages.length, busy, expanded]);
  const perform = async (action: "send" | "apply" | "discard", message?: string): Promise<boolean> => {
    if (busy || loading || externalBusy || (action === "send" && !message?.trim())) return false;
    setBusy(action); setError(null); setExpanded(true);
    const abort = new AbortController(); controller.current = abort;
    try {
      const next = await chatRequest(action === "send" ? path : `${path}/${action}`,
        action === "send" ? { message, baseVersion: plan.version } : { proposalId: chat.proposal?.id }, abort.signal);
      setChat(next);
      if (action === "apply") await onApplied();
      return true;
    } catch (reason) {
      if (!abort.signal.aborted) {
        setError(reason instanceof Error ? reason.message : "对话未完成，请重试。");
        // Recover messages already accepted by the server; never automatically resend a paid model call.
        try { setChat(await chatRequest(path, undefined, abort.signal)); } catch { /* Keep the current visible conversation. */ }
      }
      return false;
    } finally { if (!abort.signal.aborted) setBusy(null); }
  };
  const proposal = chat.proposal?.status === "pending" ? chat.proposal : undefined;
  const stale = proposal && proposal.baseVersion !== plan.version;
  const diff = proposal && !stale ? getPlanDiff(plan, proposal.afterPreview) : [];
  const maxLength = Math.max(0, CHAT_MESSAGE_LIMIT - chatContextPrefix(context).length);
  return <ChangeComposer context={context} busy={Boolean(busy) || loading || externalBusy} pending={Boolean(proposal)}
    error={error || externalError || (maxLength === 0 ? "关联任务过多，请缩小关联范围后提交。" : null)}
    onResetContext={onResetContext} onEditHours={onEditHours} expanded={expanded} maxLength={maxLength}
    onSubmit={async (description, selectedContext) => {
      try { return await perform("send", contextualChatMessage(description, selectedContext)); }
      catch (reason) { setError(reason instanceof Error ? reason.message : "变更说明提交失败。"); return false; }
    }}>
    <header className="chat-toolbar"><strong>计划调整</strong><button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "收起对话" : "展开对话"}</button></header>
    {expanded && <div className="roadmap-conversation" ref={conversation} role="log" aria-label="路线对话记录">
      {!chat.messages.length && <p className="chat-empty">可提交目标、资源、时间安排等变化，或查询任务执行建议。计划修改经预览确认后应用。</p>}
      {chat.messages.map(message => <article key={message.id} className={`chat-message from-${message.role}`}>
        <small>{message.role === "user" ? "提交人" : "知路"}</small><p>{message.role === "user" ? displayChatMessage(message.content) : message.content}</p>
        {message.role === "assistant" && <small className="chat-plan-effect">{message.planEffect === "applied" ? `已保存 · v${message.planVersion}` : message.planEffect === "proposal" ? "已生成方案，确认后更新路线" : message.planEffect === "unchanged" ? "本条回复未修改路线" : "历史对话 · 修改结果以当前路线为准"}</small>}
        {!!message.research?.sources.length && <details><summary>参考来源 · {message.research.sources.length}</summary>
          {message.research.sources.map(source => <a key={source.id} href={source.url} target="_blank" rel="noreferrer">{source.title} ↗</a>)}
        </details>}
      </article>)}
      {proposal && <section className="chat-proposal" aria-label="待确认的计划修改">
        <strong>{stale ? "方案需要更新" : "审阅计划调整"}</strong><p>{stale ? "计划版本已变更，请提交补充说明，以当前版本重新生成方案。" : proposal.summary}</p>
        {!stale && <details open><summary>查看修改内容 · {diff.length}</summary>{diff.map(entry => <article key={entry.id}>
          <b>{entry.title}</b>{entry.fields.map(field => <p key={field.key}><span>{field.label}</span><del>{field.before}</del><span>→ {field.after}</span></p>)}
        </article>)}</details>}
        <div><button disabled={!!busy || externalBusy || !!stale} onClick={() => void perform("apply")}>确认更新路线图</button><button disabled={!!busy || externalBusy} onClick={() => void perform("discard")}>放弃本次修改</button></div>
      </section>}
    </div>}
    {(loading || (busy && (busy === "send" || progress))) && <WaitStatus label={loading ? "正在读取对话…" : "正在处理变更说明…"} progress={progress} />}
  </ChangeComposer>;
}
