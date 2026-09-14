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

export function RoadmapChat({ plan, onApplied }: { plan: PlanState; onApplied: () => Promise<void> }) {
  const [chat, setChat] = useState<RoadmapChatState>({ messages: [] });
  const [input, setInput] = useState("");
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
  const perform = async (action: "send" | "apply" | "discard") => {
    if (busy || loading || (action === "send" && !input.trim())) return;
    setBusy(action); setError(null); setExpanded(true);
    const abort = new AbortController(); controller.current = abort;
    try {
      const next = await chatRequest(action === "send" ? path : `${path}/${action}`,
        action === "send" ? { message: input.trim(), baseVersion: plan.version } : { proposalId: chat.proposal?.id }, abort.signal);
      setChat(next);
      if (action === "send") setInput("");
      if (action === "apply") await onApplied();
    } catch (reason) {
      if (!abort.signal.aborted) {
        setError(reason instanceof Error ? reason.message : "对话未完成，请重试。");
        // Recover messages already accepted by the server; never automatically resend a paid model call.
        try { setChat(await chatRequest(path, undefined, abort.signal)); } catch { /* Keep the current visible conversation. */ }
      }
    } finally { if (!abort.signal.aborted) setBusy(null); }
  };
  const proposal = chat.proposal?.status === "pending" ? chat.proposal : undefined;
  const stale = proposal && proposal.baseVersion !== plan.version;
  const diff = proposal && !stale ? getPlanDiff(plan, proposal.afterPreview) : [];
  return <section className={`roadmap-chat ${expanded ? "is-expanded" : ""}`} aria-label="与 AI 调整路线">
    <header><strong>和知路聊聊</strong><button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "收起对话" : "展开对话"}</button></header>
    {expanded && <div className="roadmap-conversation" ref={conversation} role="log" aria-label="路线对话记录">
      {!chat.messages.length && <p className="chat-empty">可以问我下一步怎么做，也可以告诉我新的想法、时间安排或遇到的困难。</p>}
      {chat.messages.map(message => <article key={message.id} className={`chat-message from-${message.role}`}>
        <small>{message.role === "user" ? "你" : "知路"}</small><p>{message.content}</p>
        {message.role === "assistant" && <small className="chat-plan-effect">{message.planEffect === "applied" ? `已保存 · v${message.planVersion}` : message.planEffect === "proposal" ? "已生成方案，确认后更新路线" : message.planEffect === "unchanged" ? "本条回复未修改路线" : "历史对话 · 修改结果以当前路线为准"}</small>}
        {!!message.research?.sources.length && <details><summary>参考来源 · {message.research.sources.length}</summary>
          {message.research.sources.map(source => <a key={source.id} href={source.url} target="_blank" rel="noreferrer">{source.title} ↗</a>)}
        </details>}
      </article>)}
      {proposal && <section className="chat-proposal" aria-label="待确认的计划修改">
        <strong>{stale ? "这份方案需要更新" : "确认这次调整"}</strong><p>{stale ? "你已修改过路线，请继续对话，让 AI 根据最新计划更新方案。" : proposal.summary}</p>
        {!stale && <details open><summary>查看修改内容 · {diff.length}</summary>{diff.map(entry => <article key={entry.id}>
          <b>{entry.title}</b>{entry.fields.map(field => <p key={field.key}><span>{field.label}</span><del>{field.before}</del><span>→ {field.after}</span></p>)}
        </article>)}</details>}
        <div><button disabled={!!busy || !!stale} onClick={() => void perform("apply")}>确认更新路线图</button><button disabled={!!busy} onClick={() => void perform("discard")}>放弃这次修改</button></div>
      </section>}
    </div>}
    {(loading || (busy && (busy === "send" || progress))) && <WaitStatus label={loading ? "正在读取对话…" : "正在处理你的消息…"} progress={progress} />}
    {error && <p className="chat-error" role="alert">{error}</p>}
    <form onSubmit={event => { event.preventDefault(); void perform("send"); }}>
      <textarea aria-label="给知路发送消息" placeholder="例如：这周只有 2 小时，帮我调整后面的任务…" rows={2} maxLength={4000} disabled={!!busy} value={input} onChange={event => setInput(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void perform("send"); } }} />
      <button disabled={!!busy || loading || !input.trim()} type="submit">{busy ? "处理中…" : "发送 ↑"}</button>
    </form>
  </section>;
}
