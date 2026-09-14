import type { ChangeContext } from "./ChangeComposer";

export const CHAT_MESSAGE_LIMIT = 4000;

export function chatContextPrefix(context: ChangeContext): string {
  if (context.kind === "global") return "";
  return `关联${context.kind === "task" ? "任务" : "阶段"}：${context.label}\n关联任务 ID：${context.nodeIds.join("、")}\n请结合这些任务及其依赖关系评估调整，并提供可确认的修改方案。\n\n变更说明：`;
}

export function contextualChatMessage(description: string, context: ChangeContext): string {
  const message = chatContextPrefix(context) + description.trim();
  if (message.length > CHAT_MESSAGE_LIMIT) throw new Error("关联任务与变更说明超过长度限制，请缩小关联范围或精简说明。");
  return message;
}

// Keep transport-only context out of the conversation while preserving ordinary user text.
export function displayChatMessage(message: string): string {
  return message.replace(
    /^(关联(?:任务|阶段)：[^\n]*)\n关联任务 ID：[^\n]*\n请结合这些任务及其依赖关系评估调整，并提供可确认的修改方案。\n\n变更说明：/,
    "$1\n\n",
  );
}
