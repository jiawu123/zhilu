import type { EvidenceCard, InsufficientResearchSource } from "@zhilu/contracts";

const reasonLabels: Record<InsufficientResearchSource["reasonCode"], string> = {
  no_evidence: "未提取到足以回答研究问题的证据",
  compiler_rejected: "内容未通过证据校验",
  not_selected: "本轮未被选为计划依据",
};
const riskLabels: Record<string, string> = {
  search_snippet_only: "仅有检索片段",
  not_independently_verified: "未经独立核实",
  semantic_support_not_checked: "尚未人工确认片段是否支持结论",
  needs_human_review: "待人工审阅",
};

export function InsufficientEvidenceNotice() {
  return <section className="insufficient-evidence-notice" role="status">
    <strong>证据不足 · 暂定计划</strong>
    <p>模型根据已确认的目标与背景生成了暂定计划。现有知乎内容不足以支持完整路线，请先核实关键假设、时间和风险，再决定是否采用。</p>
  </section>;
}

export function InsufficientSourcesDisclosure({ sources, showEmpty = false, description }: {
  sources: InsufficientResearchSource[]; showEmpty?: boolean; description?: string;
}) {
  if (sources.length === 0) return showEmpty ? <p className="insufficient-sources-empty">尚未取得可展示的知乎原帖；暂定计划仍需补充依据。</p> : null;
  return <details className="research-details insufficient-sources">
    <summary>未作为计划依据的知乎原帖 · {sources.length}</summary>
    <p>{description ?? "这些检索内容供你自行核对，不计入有效证据，也不代表已被路线采用。"}</p>
    {sources.map(({ source, reasonCode, riskTags }, index) => <article className="insufficient-source" key={`${source.id}-${index}`}>
      <span className="insufficient-source-tag">证据不足</span>
      <h3><a href={source.url} target="_blank" rel="noreferrer">{source.title || "打开知乎原帖"} ↗</a></h3>
      <p>{reasonLabels[reasonCode]}</p>
      <small>{source.author && `作者：${source.author} · `}{source.retrievedAt ? <>检索时间：<time dateTime={source.retrievedAt}>{source.retrievedAt}</time></> : "检索时间未提供"}</small>
      <blockquote style={{ whiteSpace: "pre-wrap" }}>{source.snippet}</blockquote>
      {riskTags.length > 0 && <ul className="insufficient-source-risks" aria-label="原帖风险标签">{riskTags.map((tag, tagIndex) => <li key={tagIndex}>{riskLabels[tag] ? <>{riskLabels[tag]} <small>（{tag}）</small></> : tag}</li>)}</ul>}
    </article>)}
  </details>;
}

export function CollectedSourcesDisclosure({ evidence }: { evidence: EvidenceCard[] }) {
  if (evidence.length === 0) return null;
  return <details className="research-details collected-sources">
    <summary>当前路标未采用的知乎材料 · {evidence.length}</summary>
    <p>这些材料已在本次研究中收集，但当前路标没有引用。以下仅展示已保存的原文摘录，相关性与适用性需自行核对。</p>
    {evidence.map(card => <article className="collected-source" key={card.id}>
      <span className="collected-source-tag">当前路标未采用</span>
      <h3>{card.sourceUrl ? <a href={card.sourceUrl} target="_blank" rel="noreferrer">{card.sourceTitle ?? card.title} ↗</a> : card.sourceTitle ?? card.title}</h3>
      <small>{card.author && `作者：${card.author} · `}{card.retrievedAt ? <>检索时间：<time dateTime={card.retrievedAt}>{card.retrievedAt}</time></> : "检索时间未提供"}</small>
      {card.supportingQuote ? <>
        <p>已保存的原文摘录</p>
        <blockquote style={{ whiteSpace: "pre-wrap" }}>{card.supportingQuote}</blockquote>
      </> : <p>未保存原文摘录；请打开原始来源核对。</p>}
      {!card.sourceUrl && <p>原始链接未提供。</p>}
      {card.riskTags.length > 0 && <ul className="insufficient-source-risks" aria-label="原帖风险标签">{card.riskTags.map((tag, tagIndex) => <li key={tagIndex}>{riskLabels[tag] ? <>{riskLabels[tag]} <small>（{tag}）</small></> : tag}</li>)}</ul>}
    </article>)}
  </details>;
}
