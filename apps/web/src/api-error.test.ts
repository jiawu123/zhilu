import { describe, expect, it } from "vitest";
import { formatApiError } from "./api-error";

describe("API error messages", () => {
  it("shows specific coverage gaps in the existing error message", () => {
    expect(formatApiError({ error: "证据覆盖不足，未生成计划。", code: "insufficient_coverage", controller: {
      coverage: { status: "insufficient", gaps: [
        { kind: "evidence_count", reason: "可用证据少于 6 张" },
        { kind: "conditions", reason: "缺少适合业余实践的依据" },
      ] },
    } }, 422)).toBe("证据覆盖不足，未生成计划。 缺口：可用证据少于 6 张；缺少适合业余实践的依据");
  });

  it("preserves validation issues priority over server errors and coverage gaps", () => {
    expect(formatApiError({ issues: [{ message: "时间范围无效" }, { message: "每周投入不能为空" }], error: "研究失败", controller: {
      coverage: { status: "insufficient", gaps: [{ kind: "route", reason: "没有路线依据" }] },
    } }, 422)).toBe("时间范围无效；每周投入不能为空");
  });

  it("deduplicates whitespace variants and displays no more than three gaps", () => {
    const gaps = [" 路线依据不足 ", "路线依据不足", "适用条件\n待确认", "适用条件 待确认", "缺少反例", "第四条不显示"]
      .map(reason => ({ kind: "route", reason }));
    expect(formatApiError({ controller: { coverage: { status: "insufficient", gaps } } }, 422))
      .toBe("请求失败：422 缺口：路线依据不足；适用条件 待确认；缺少反例");
  });

  it("limits each gap to 160 Unicode characters including the ellipsis", () => {
    const prefix = "研究失败 缺口：";
    const message = formatApiError({ error: "研究失败", controller: { coverage: {
      status: "insufficient", gaps: [{ kind: "counterevidence", reason: "🧭".repeat(200) }],
    } } }, 422);
    expect(message).toBe(`${prefix}${"🧭".repeat(159)}…`);
    expect([...message.slice(prefix.length)]).toHaveLength(160);
  });

  it("ignores malformed fields and does not stringify diagnostics or request input", () => {
    const payload = { error: { secret: "private-error" }, issues: [null, "private-issue", { message: 8 }],
      request: { goal: "private-goal" }, controller: { stages: [{ query: "private-query" }], coverage: {
        status: "insufficient", gaps: [null, { kind: "unknown", reason: "private-kind" },
          { kind: "route", reason: { input: "private-input" } }, { kind: "conditions", reason: " " },
          { kind: "counterevidence", reason: "需要检验反例" }],
      } } };
    expect(formatApiError(payload, 502)).toBe("请求失败：502 缺口：需要检验反例");
  });

  it.each([null, undefined, "private-body", [], { error: 42, issues: {}, controller: [] }])("falls back safely for malformed error bodies", body => {
    expect(formatApiError(body, 503)).toBe("请求失败：503");
  });

  it("keeps ordinary errors unchanged and ignores inconsistent sufficient coverage gaps", () => {
    expect(formatApiError({ error: "模型调用超时" }, 504)).toBe("模型调用超时");
    expect(formatApiError({ error: "模型调用超时", controller: { coverage: {
      status: "sufficient", gaps: [{ kind: "route", reason: "不应显示" }],
    } } }, 504)).toBe("模型调用超时");
  });
});


it("shows the actual quota failure without an unmeasured evidence gap", () => {
  expect(formatApiError({ code: "process_failed", error: "知乎搜索触发限流或额度不足", controller: {
    coverage: { status: "insufficient", gaps: [{ kind: "evidence_count", reason: "尚未取得研究证据" }] },
  } }, 502)).toBe("知乎搜索触发限流或额度不足");
});
