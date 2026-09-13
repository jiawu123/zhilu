import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { InterviewSession } from "@zhilu/contracts";
import { acceptInterviewAnswers, generateInterviewBatch } from "./interview";
import { createZhiluServer } from "./index";
import { PlanRepository } from "./repository";

const today = new Date().toISOString().slice(0, 10);
const start = (): InterviewSession => ({ id: `interview-${crypto.randomUUID()}`, goal: "完成第一场马拉松", questions: [], answers: [], status: "asking" });
const batch = (offset: number, count: number) => ({ done: false, questions: Array.from({ length: count }, (_, i) => ({ question: `跑步背景 ${offset + i + 1}？`, options: ["已有经验", "尚无经验", "不确定"] })) });
const done = () => ({ done: true, questions: [], summary: { userContext: { currentSituation: "有跑步经验", weeklyHours: 6, constraints: ["周末可训练"] }, goalContract: {
  targetDate: new Date(Date.now() + 84 * 86400000).toISOString().slice(0, 10), successCriteria: ["完成比赛"], nonGoals: [], mustHaveOutcomes: ["安全完赛"], tradeoffs: ["优先安全"], reviewCadence: "weekly",
} } });
const answers = (session: InterviewSession) => session.questions.slice(session.answers.length).map(q => ({ questionId: q.id, optionId: q.options[0]!.id }));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanup.splice(0)) await clean(); });

describe("adaptive interview", () => {
  it("ends at 22 questions with a final batch of two and sends cumulative questions and answer labels", async () => {
    const generate = vi.fn();
    let offset = 0;
    for (const count of [5, 5, 5, 5, 2]) { generate.mockResolvedValueOnce(batch(offset, count)); offset += count; }
    generate.mockResolvedValueOnce(done());
    let session = await generateInterviewBatch(start(), { generate }, today);
    for (const count of [5, 5, 5, 5, 2]) {
      expect(session.questions.length - session.answers.length).toBe(count);
      session = await generateInterviewBatch(acceptInterviewAnswers(session, answers(session)), { generate }, today);
    }
    expect(session.status).toBe("complete");
    expect(session.answers).toHaveLength(22);
    expect(session.summary?.userContext.confirmed).toBe(false);
    expect(session.summary?.goalContract).toMatchObject({ goal: "完成第一场马拉松", confirmed: false });
    expect(generate).toHaveBeenCalledTimes(6);
    expect(generate.mock.calls[1]![0].context).toMatchObject({ goal: session.goal, remainingBudget: 25,
      history: expect.arrayContaining([expect.objectContaining({ question: "跑步背景 1？", options: ["已有经验", "尚无经验", "不确定"], answer: "已有经验" })]) });
    expect(generate.mock.calls[5]![0].context.history).toHaveLength(22);
  });

  it("enforces 30 questions and permits a final summary call", async () => {
    let session = start();
    for (let offset = 0; offset < 30; offset += 5) {
      session = await generateInterviewBatch(session, { generate: async () => batch(offset, 5) }, today);
      session = acceptInterviewAnswers(session, answers(session));
    }
    await expect(generateInterviewBatch(session, { generate: async () => batch(30, 1) }, today)).rejects.toThrow("不符合要求");
    const generate = vi.fn().mockResolvedValue(done());
    expect((await generateInterviewBatch(session, { generate }, today)).status).toBe("complete");
    expect(generate.mock.calls[0]![0].context).toMatchObject({ remainingBudget: 0, maxBatchSize: 0 });
  });

  it("rejects incomplete, forged, repeated answers and repeated or oversized batches", async () => {
    const session = await generateInterviewBatch(start(), { generate: async () => batch(0, 2) }, today);
    expect(() => acceptInterviewAnswers(session, answers(session).slice(0, 1))).toThrow();
    expect(() => acceptInterviewAnswers(session, answers(session).map(a => ({ ...a, optionId: "forged" })))).toThrow();
    expect(() => acceptInterviewAnswers(session, [answers(session)[0], answers(session)[0]])).toThrow();
    const answered = acceptInterviewAnswers(session, answers(session));
    await expect(generateInterviewBatch(answered, { generate: async () => batch(0, 1) }, today)).rejects.toThrow();
    await expect(generateInterviewBatch(answered, { generate: async () => batch(2, 6) }, today)).rejects.toThrow();
    const finished = await generateInterviewBatch(answered, { generate: async () => done() }, today);
    expect(() => acceptInterviewAnswers(finished, [])).toThrow("已结束");
  });

  it("persists authoritative history, resumes via GET and preserves the current batch on a model failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "zhilu-interview-"));
    const repository = new PlanRepository(root, "unused");
    const generate = vi.fn().mockResolvedValueOnce(batch(0, 2)).mockRejectedValueOnce(new Error("test failure")).mockResolvedValueOnce(done());
    const server = createZhiluServer(repository, { roadmapperProvider: { generate } });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/interviews`;
    const post = (path: string, body: unknown) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const response = await post(url, { goal: start().goal });
    expect(response.status).toBe(201);
    const session = await response.json() as InterviewSession;
    expect((await post(`${url}/${session.id}/answers`, { answers: [] })).status).toBe(400);
    expect(generate).toHaveBeenCalledTimes(1);
    const silent = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await post(`${url}/${session.id}/answers`, { answers: answers(session) })).status).toBe(500);
    silent.mockRestore();
    expect(await (await fetch(`${url}/${session.id}`)).json()).toEqual(session);
    const final = await post(`${url}/${session.id}/answers`, { answers: answers(session), goal: "伪造目标", questions: batch(0, 30).questions });
    expect(final.status).toBe(200);
    expect(await final.json()).toMatchObject({ goal: session.goal, status: "complete" });
    expect((await post(`${url}/${session.id}/answers`, { answers: answers(session) })).status).toBe(409);
  });
});


describe("mixed interview answers", () => {
  const choice = [{ label: "基本了解", allowsText: false }, { label: "其他", allowsText: true }];
  const mixed = () => ({ done: false, questions: [
    { type: "single", question: "已有基础？", options: choice },
    { type: "multiple", question: "有哪些资源？", options: choice },
    { type: "text", question: "具体成果是什么？", options: [] },
    { type: "toggle", question: "重视程度？", options: ["低", "中", "高"] },
  ] });
  it("preserves multiple selections, other text, text answers and explicitly skipped facts in model history", async () => {
    const session = await generateInterviewBatch(start(), { generate: async () => mixed() }, today);
    const answered = acceptInterviewAnswers(session, [
      { questionId: "q-1", skipped: true },
      { questionId: "q-2", optionIds: ["q-2-o-1", "q-2-o-2"], text: "有朋友一起练习" },
      { questionId: "q-3", text: "完成一次公开比赛" },
      { questionId: "q-4", optionIds: ["q-4-o-3"] },
    ]);
    const generate = vi.fn().mockResolvedValue(done());
    const completed = await generateInterviewBatch(answered, { generate }, today);
    const history = generate.mock.calls[0]![0].context.history;
    expect(history[0]).toMatchObject({ skipped: true, answer: "用户跳过此题，未提供该信息" });
    expect(history[1].answer).toBe("基本了解；其他；补充：有朋友一起练习");
    expect(history[2].answer).toBe("完成一次公开比赛");
    expect(history[3].answer).toBe("高");
    expect(completed.summary?.adaptiveAnswer).toBe("高");
  });

  it("counts skipped fill-in questions toward the global limit of three", async () => {
    const session = await generateInterviewBatch(start(), { generate: async () => ({ done: false,
      questions: Array.from({ length: 3 }, (_, i) => ({ type: "text", question: `必要背景${i}`, options: [] })) }) }, today);
    const answered = acceptInterviewAnswers(session, session.questions.map(q => ({ questionId: q.id, skipped: true })));
    const generate = vi.fn().mockResolvedValue({ done: false, questions: [{ type: "text", question: "第四题", options: [] }] });
    await expect(generateInterviewBatch(answered, { generate }, today)).rejects.toThrow("不符合要求");
    expect(generate.mock.calls[0]![0].context.remainingTextBudget).toBe(0);
    const completed = await generateInterviewBatch(answered, { generate: async () => done() }, today);
    expect(completed.summary?.adaptiveAnswer).toBe("用户跳过此题，未提供该信息");
    expect(completed.summary?.goalContract.confirmed).toBe(false);
  });

  it("requires other text, rejects multiple answers for single choice, and disallows answers on skipped questions", async () => {
    const session = await generateInterviewBatch(start(), { generate: async () => ({ done: false, questions: [mixed().questions[0]] }) }, today);
    for (const answer of [
      { questionId: "q-1", optionIds: ["q-1-o-2"] },
      { questionId: "q-1", optionIds: ["q-1-o-1", "q-1-o-2"], text: "补充" },
      { questionId: "q-1", skipped: true, text: "不能同时提供事实" },
      { questionId: "q-1", optionIds: ["q-1-o-1"], text: "没有选其他" },
      { questionId: "q-1", optionIds: ["q-1-o-2"], text: "字".repeat(1001) },
    ]) expect(() => acceptInterviewAnswers(session, [answer])).toThrow();
    expect(acceptInterviewAnswers(session, [{ questionId: "q-1", optionIds: ["q-1-o-2"], text: "实际背景" }]).answers[0]?.text).toBe("实际背景");
  });

  it("rejects four text questions in one batch and recognizes legacy other options", async () => {
    await expect(generateInterviewBatch(start(), { generate: async () => ({ done: false,
      questions: Array.from({ length: 4 }, (_, i) => ({ type: "text", question: `填写${i}`, options: [] })) }) }, today)).rejects.toThrow();
    const session = await generateInterviewBatch(start(), { generate: async () => ({ done: false, questions: [
      { question: "其他背景？", options: ["暂无", "其他（请说明）"] },
    ] }) }, today);
    expect(session.questions[0]?.options[1]?.allowsText).toBe(true);
    expect(() => acceptInterviewAnswers(session, [{ questionId: "q-1", optionId: "q-1-o-2" }])).toThrow("补充说明");
  });
});
