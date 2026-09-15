import type { EvidenceCard, ZhihuEvidenceCompilerOutput } from "@zhilu/contracts";

/** 将 Kyle 当前 Python 编译器的边界输出转换为 Plan 使用的 EvidenceCard。 */
export function adaptZhihuCompilerOutput(output: ZhihuEvidenceCompilerOutput): EvidenceCard[] {
  if (output.status === "no_evidence") return [];
  return output.evidence_cards.map((card) => ({
    id: card.id,
    title: card.source_title,
    summary: card.claim,
    sourceType: "zhihu",
    contentType: card.claim_type,
    verificationStatus: card.verification_status,
    sourceTitle: card.source_title,
    sourceUrl: card.source_url,
    author: output.source.author,
    ...(output.source.retrievedAt ? { retrievedAt: output.source.retrievedAt } : {}),
    supportingQuote: card.supporting_quote,
    applicableWhen: [card.applies_when],
    caveats: [...card.caveats],
    riskTags: [...card.risk_flags],
    adoptionReason: output.reason || "该主张直接回答当前研究问题",
  }));
}
