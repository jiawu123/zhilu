import { ChangeComposer, globalChangeContext, type ChangeContext } from "./ChangeComposer";
import { CHAT_MESSAGE_LIMIT, chatContextPrefix, contextualChatMessage, displayChatMessage } from "./roadmap-chat-context";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  const [hidden, setHidden] = useState(false);
  const surface = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(164);
  const toggleExpanded = () => setExpanded(value => !value);
  const hide = () => setHidden(true);
  useEffect(() => {
    if (hidden) surface.current?.querySelector<HTMLButtonElement>(".chat-launcher")?.focus({ preventScroll: true });
  }, [hidden]);
  useLayoutEffect(() => {
    const panel = surface.current?.querySelector<HTMLElement>(".change-composer");
    if (!panel) return;
    const measure = () => setContentHeight(Math.ceil(panel.getBoundingClientRect().height) + 2);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [expanded]);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const focusRequested = useRef(false);
  const reveal = () => {
    focusRequested.current = true;
    setHidden(false);
  };
  useEffect(() => { if (context.focusKey) reveal(); }, [context.focusKey]);
  useEffect(() => {
    const focus = () => {
      if (hidden || !focusRequested.current || loading || busy || externalBusy) return;
      const input = surface.current?.querySelector<HTMLTextAreaElement>("textarea");
      if (input && !input.disabled) { input.focus({ preventScroll: true }); if (document.activeElement === input) focusRequested.current = false; }
    };
    focus(); window.addEventListener("zhilu:surfaceclosed", focus);
    return () => window.removeEventListener("zhilu:surfaceclosed", focus);
  }, [hidden, context.focusKey, loading, busy, externalBusy]);
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
  return <div ref={surface} className={`chat-shell ${hidden ? "is-collapsed" : "is-open"}`} style={{ height: hidden ? 44 : contentHeight }}><button className="chat-launcher" tabIndex={hidden ? 0 : -1} aria-hidden={!hidden} onClick={reveal} aria-label="打开计划调整" aria-expanded="false"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 3h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 3v-3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/></svg>计划调整{(busy || proposal || error) && <span className="chat-launcher-state">{busy ? "处理中" : error ? "需查看" : "待确认"}</span>}</button>
    <div aria-hidden={hidden} inert={hidden} className="chat-visibility"><ChangeComposer context={context} busy={Boolean(busy) || loading || externalBusy} pending={Boolean(proposal)}
    error={error || externalError || (maxLength === 0 ? "关联任务过多，请缩小关联范围后提交。" : null)}
    onResetContext={onResetContext} onEditHours={onEditHours} expanded={expanded} maxLength={maxLength}
    onSubmit={async (description, selectedContext) => {
      try { return await perform("send", contextualChatMessage(description, selectedContext)); }
      catch (reason) { setError(reason instanceof Error ? reason.message : "变更说明提交失败。"); return false; }
    }}>
    <header className="chat-toolbar"><strong>计划调整</strong><div className="chat-toolbar-actions"><button type="button" aria-expanded={expanded} onClick={toggleExpanded}>{expanded ? "收起对话" : "展开对话"}</button><button type="button" className="chat-hide" aria-label="隐藏对话框" title="隐藏对话框" onClick={hide}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button></div></header>
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
  </ChangeComposer></div></div>;
}
