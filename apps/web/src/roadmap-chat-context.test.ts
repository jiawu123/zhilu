import { describe, expect, it } from "vitest";
import { contextualChatMessage, chatContextPrefix, CHAT_MESSAGE_LIMIT, displayChatMessage } from "./roadmap-chat-context";
import { globalChangeContext, type ChangeContext } from "./ChangeComposer";

describe("all three change entry points use the upstream chat message contract", () => {
  it("leaves global descriptions intact", () => {
    expect(contextualChatMessage("  项目预算发生变化。  ", globalChangeContext)).toBe("项目预算发生变化。");
  });
  it.each(["task", "segment"] as const)("includes %s context without inventing API fields", kind => {
    const context: ChangeContext = { kind, label: "需求与设计", nodeIds: ["t1", "t2"] };
    const message = contextualChatMessage("需要重新评估。", context);
    expect(message).toContain("需求与设计");
    expect(message).toContain("关联任务 ID：t1、t2");
    expect(message).toContain("变更说明：需要重新评估。");
  });
  it("counts context towards the server limit and never silently truncates task IDs", () => {
    const context: ChangeContext = { kind: "task", label: "长标题", nodeIds: ["t1"] };
    const available = CHAT_MESSAGE_LIMIT - chatContextPrefix(context).length;
    expect(contextualChatMessage("字".repeat(available), context)).toHaveLength(CHAT_MESSAGE_LIMIT);
    expect(() => contextualChatMessage("字".repeat(available + 1), context)).toThrow("长度限制");
  });
  it("shows the scope and description without transport instructions", () => {
    const context: ChangeContext = { kind: "task", label: "需求核验", nodeIds: ["t1"] };
    expect(displayChatMessage(contextualChatMessage("需要重新评估。", context))).toBe("关联任务：需求核验\n\n需要重新评估。");
    const ordinaryText = "关联任务 ID：请保留用户自行输入的说明。";
    expect(displayChatMessage(ordinaryText)).toBe(ordinaryText);
  });
});
