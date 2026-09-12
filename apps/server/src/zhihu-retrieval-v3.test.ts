import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BoundaryError, parseResearchResponse } from "./zhihu-boundary.js";

const request = { id: "external-v3-🧪", question: "如何判断调用参数正确？", searchQueries: ["调用参数 检查", "实际参数 预期 比较"], relevantUserConditions: [], evidenceLimit: 1 };
// The real Python V3 runner and compiler validator produce this value; only search/model are fake.
let fixture: any;
beforeAll(() => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const local = resolve(root, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
  const python = process.env.ZHIHU_TEST_PYTHON_BIN || (existsSync(local) ? local : "python");
  fixture = JSON.parse(execFileSync(python, ["-B", "-X", "utf8", "tests/fixtures/retrieval_v3_runner_offline.py"], {
    cwd: resolve(root, "packages/zhihu"), encoding: "utf8", timeout: 15_000,
    env: { ...process.env, PYTHONPATH: resolve(root, "packages/zhihu"), PYTHON_DOTENV_DISABLED: "1", PYTHONDONTWRITEBYTECODE: "1", ZHIHU_RETRIEVAL_PROFILE: "legacy" },
  }));
});

describe("synthetic real V3 runner crossing the strict TS boundary", () => {
  it("preserves request ID, selected raw variant, codepoint quote offsets, URL, time and all risks", () => {
    const output = fixture.data.compilerOutputs[0];
    const card = output.evidence_cards[0];
    expect(output.source.snippet).toBe("😀开头\r\n记录调用的实际参数，再与预先写下的期望参数逐项比较。");
    expect(card.quote_start).toBe(5);
    expect([...output.source.snippet].slice(card.quote_start, card.quote_end).join("")).toBe(card.supporting_quote);
    const result = parseResearchResponse(fixture, request);
    expect(result.pack.requestId).toBe(request.id);
    expect(result.pack.evidence).toHaveLength(request.evidenceLimit);
    expect(result.pack.evidence[0]).toMatchObject({ supportingQuote: card.supporting_quote,
      sourceUrl: output.source.url, retrievedAt: "2026-09-12T00:00:00+00:00", verificationStatus: "unverified",
      riskTags: ["search_snippet_only", "not_independently_verified", "semantic_support_not_checked"] });
    expect(result.metrics).toMatchObject({ search_calls_attempted: 2, compiler_calls_attempted: 1, candidate_count: 1, evidence_count: 1 });
  });
  it("passes through additional finite numeric metrics", () => {
    const value = structuredClone(fixture);
    value.metrics.synthetic_stage_elapsed_ms = 1.25;
    expect(parseResearchResponse(value, request).metrics.synthetic_stage_elapsed_ms).toBe(1.25);
  });
  it.each([NaN, Infinity, -1, {}])("rejects invalid additional metrics %s", value => {
    const data = structuredClone(fixture);
    data.metrics.synthetic_stage_elapsed_ms = value;
    expect(() => parseResearchResponse(data, request)).toThrow(BoundaryError);
  });
  it.each(["cleaned-source", "quote", "risk", "extra-data", "id", "limit"])("rejects corrupted %s", kind => {
    const data = structuredClone(fixture);
    const output = data.data.compilerOutputs[0];
    if (kind === "cleaned-source") output.source.snippet = output.source.snippet.replace("\r\n", "\n");
    if (kind === "quote") output.evidence_cards[0].supporting_quote = "这句伪造引文不在原文中。";
    if (kind === "risk") output.evidence_cards[0].risk_flags = ["search_snippet_only"];
    if (kind === "extra-data") data.data.diagnostics = { priority: 0.9 };
    if (kind === "id") data.data.requestId = "internal-id";
    if (kind === "limit") {
      const other = structuredClone(output);
      other.evidence_cards[0].id = "ev_over_limit";
      data.data.compilerOutputs.push(other);
    }
    expect(() => parseResearchResponse(data, request)).toThrow(BoundaryError);
  });
});
