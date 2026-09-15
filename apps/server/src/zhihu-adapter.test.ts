import { describe, expect, it } from "vitest";
import type { ZhihuEvidenceCompilerOutput } from "@zhilu/contracts";
import { adaptZhihuCompilerOutput } from "./zhihu-adapter";

describe("Zhihu compiler adapter", () => {
  it("keeps source, claim type and verification as separate dimensions", () => {
    const output: ZhihuEvidenceCompilerOutput = {
      compiler_version: "m2-evidence-v0.1.2",
      status: "ok",
      reason: "引文直接回答了检验方法",
      source: {
        id: "zhihu:Answer:1",
        provider: "zhihu",
        title: "如何检查 Agent 输出",
        url: "https://www.zhihu.com/question/1/answer/1",
        author: "测试作者",
        snippet: "给程序输入固定样例，并将输出与预期逐项比较。",
        retrievedAt: "2026-09-11T00:00:00+00:00",
        source_scope: "search_snippet",
      },
      evidence_cards: [
        {
          id: "ev_1",
          source_id: "zhihu:Answer:1",
          source_url: "https://www.zhihu.com/question/1/answer/1",
          source_title: "如何检查 Agent 输出",
          source_scope: "search_snippet",
          claim: "作者建议用固定样例比较输出。",
          claim_type: "advice",
          supporting_quote: "给程序输入固定样例，并将输出与预期逐项比较。",
          quote_start: 0,
          quote_end: 24,
          citation_status: "exact_match",
          verification_status: "unverified",
          applies_when: "需要建立可复现评测时",
          applicability_basis: "ai_inference",
          caveats: [],
          risk_flags: ["search_snippet_only"],
        },
      ],
    };

    expect(adaptZhihuCompilerOutput(output)[0]).toMatchObject({
      sourceType: "zhihu",
      contentType: "advice",
      verificationStatus: "unverified",
      sourceUrl: "https://www.zhihu.com/question/1/answer/1",
      supportingQuote: "给程序输入固定样例，并将输出与预期逐项比较。",
    });
  });
});
