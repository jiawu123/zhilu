import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { InterviewSession } from "@zhilu/contracts";
import { acceptInterviewAnswers, generateInterviewBatch, saveInterviewDraft } from "./interview";
import { createZhiluServer } from "./index";
import { PlanRepository } from "./repository";
import { createRoadmapperProvider, RoadmapperProviderError } from "./roadmapper-provider";

const today = new Date().toISOString().slice(0, 10);
const start = (): InterviewSession => ({ id: `interview-${crypto.randomUUID()}`, goal: "完成第一场马拉松", questions: [], answers: [], status: "asking" });
const batch = (offset: number, count: number) => ({ done: false, decisionReason: "还需要了解训练背景", missingInformation: ["训练条件"], questions: Array.from({ length: count }, (_, i) => ({ question: `跑步背景 ${offset + i + 1}？`, options: ["已有经验", "尚无经验", "不确定"] })) });
const done = () => ({ done: true, decisionReason: "已有背景足以形成计划", missingInformation: [], questions: [], summary: { userContext: { currentSituation: "有跑步经验", weeklyHours: 6, constraints: ["周末可训练"] }, goalContract: {
  targetDate: new Date(Date.now() + 84 * 86400000).toISOString().slice(0, 10), successCriteria: ["完成比赛"], nonGoals: [], mustHaveOutcomes: ["安全完赛"], tradeoffs: ["优先安全"], reviewCadence: "weekly",
} } });
const answers = (session: InterviewSession) => session.questions.slice(session.answers.length).map(q => ({ questionId: q.id, optionId: q.options[0]!.id }));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanup.splice(0)) await clean(); });

describe("finish interview early", () => {
  it("preserves answers and the finish request across failure, reload and retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "zhilu-interview-finish-"));
    const repository = new PlanRepository(root, "unused");
    const generate = vi.fn().mockResolvedValueOnce(batch(0, 2)).mockRejectedValueOnce(new Error("test failure")).mockResolvedValueOnce(done());
    const server = createZhiluServer(repository, { roadmapperProvider: { generate } });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/interviews`;
    const post = (path: string, body: unknown) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const session = await (await post(url, { goal: start().goal })).json() as InterviewSession;
    const submitted = [answers(session)[0], { questionId: session.questions[1]!.id, skipped: true }];
    expect((await post(`${url}/${session.id}/finish`, { answers: [{ questionId: "forged", skipped: true }] })).status).toBe(400);
    expect((await post(`${url}/${session.id}/finish`, { answers: submitted })).status).toBe(502);
    const saved = await new PlanRepository(root, "unused").getInterview(session.id);
    expect(saved).toMatchObject({ finishRequested: true, status: "asking", draftAnswers: [] });
    expect(saved.answers).toMatchObject([{ questionId: "q-1", optionIds: ["q-1-o-1"] }, { questionId: "q-2", skipped: true }]);
    const response = await post(`${url}/${session.id}/next`, {});
    expect(response.status).toBe(200);
    const completed = await response.json() as InterviewSession;
    expect(completed).toMatchObject({ finishRequested: true, status: "complete", answers: saved.answers });
    expect(completed.questions).toHaveLength(2);
    expect(completed.summary?.userContext.confirmed).toBe(false);
    for (const call of generate.mock.calls.slice(1)) expect(call[0].context).toMatchObject({ summaryOnly: true, maxBatchSize: 0 });
    expect((await post(`${url}/${session.id}/finish`, { answers: [] })).status).toBe(409);
  });

  it("rejects follow-up questions after finishing, including before the first batch", async () => {
    const generate = vi.fn().mockResolvedValueOnce(batch(0, 2)).mockResolvedValueOnce(done());
    const completed = await generateInterviewBatch({ ...start(), finishRequested: true }, { generate }, today);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(completed.status).toBe("complete");
    expect(completed.questions).toEqual([]);
    expect(completed.summary?.adaptiveAnswer).toBe(start().goal);
  });
});

describe("interview generation recovery", () => {
  it("regenerates malformed model JSON and an invalid summary using the original answers", async () => {
    const session = acceptInterviewAnswers(
      await generateInterviewBatch(start(), { generate: async () => batch(0, 2) }, today),
      [{ questionId: "q-1", optionIds: ["q-1-o-2"] }, { questionId: "q-2", skipped: true }],
    );
    const before = structuredClone(session);
    const invalidSummary = done();
    invalidSummary.summary.goalContract.targetDate = "2020-01-01";
    const envelope = (content: string) => Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] });
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(envelope('{"done":true,"summary":'))
      .mockResolvedValueOnce(envelope(JSON.stringify(invalidSummary)))
      .mockResolvedValueOnce(envelope(JSON.stringify(done())));
    const provider = createRoadmapperProvider({ apiUrl: "https://model.example/chat/completions", apiKey: "private-test-key", model: "test" }, { fetch: request });
    const root = await mkdtemp(join(tmpdir(), "zhilu-interview-diagnostic-"));
    cleanup.push(async () => { await rm(root, { recursive: true, force: true }); });
    const repository = new PlanRepository(root, "unused");
    const result = await generateInterviewBatch(session, provider, today, diagnostic => repository.saveInterviewDiagnostic(diagnostic));
    expect(request).toHaveBeenCalledTimes(3);
    expect(result.status).toBe("complete");
    expect(result.answers).toEqual(before.answers);
    expect(session).toEqual(before);
    const contexts = request.mock.calls.map(([, options]) => JSON.parse(JSON.parse(options!.body as string).messages[1].content));
    expect(contexts[1].correction.validationError).toContain("JSON");
    expect(contexts[2].correction.validationError).toContain("goalContract.targetDate");
    for (const context of contexts) expect(context.history).toEqual(contexts[0].history);
    expect(result.summary?.userContext.confirmed).toBe(false);
    const directory = join(root, "diagnostics", "interviews", session.id);
    const files = (await readdir(directory)).sort();
    expect(files).toHaveLength(3);
    const logs = await Promise.all(files.map(async file => JSON.parse(await readFile(join(directory, file), "utf8")))) as any[];
    expect(logs.map(log => log.status)).toEqual(["failed", "failed", "passed"]);
    expect(logs[0].transport.rawContent).toBe('{"done":true,"summary":');
    expect(logs[1].validationError).toContain("goalContract.targetDate");
    expect(logs[2].decision).toEqual({ done: true, reason: "已有背景足以形成计划", missingInformation: [] });
    for (const log of logs) {
      expect(log.questions).toEqual(session.questions);
      expect(log.answers).toEqual(session.answers);
      expect(log.transport.request.messages[1].content).toContain("尚无经验");
      expect(log.completedAt).toBeTruthy();
    }
    expect(JSON.stringify(logs)).not.toContain("private-test-key");
    if (process.platform !== "win32") expect((await stat(join(directory, files[0]!))).mode & 0o777).toBe(0o600);
  });

  it("finishes a thirty-question session even when the model tries to ask more", async () => {
    const count = 30;
    const session = start();
    session.questions = Array.from({ length: count }, (_, i) => ({ id: `q-${i + 1}`, question: `旧题 ${i + 1}`, options: [{ id: "yes", label: "尚无经验" }] }));
    session.answers = session.questions.map(q => ({ questionId: q.id, skipped: true }));
    const generate = vi.fn().mockResolvedValueOnce(batch(count, 4)).mockResolvedValueOnce(done());
    const result = await generateInterviewBatch(session, { generate }, today);
    expect(result.status).toBe("complete");
    expect(result.questions).toHaveLength(count);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[0]![0].context).toMatchObject({ remainingBudget: 0, maxBatchSize: 0, summaryOnly: true });
    expect(generate.mock.calls[1]![0].context.correction.validationError).toContain("必须 done=true");
  });

  it("lets the AI add the final two questions at 28 instead of forcing a summary", async () => {
    const session = start();
    session.questions = Array.from({ length: 28 }, (_, i) => ({ id: `q-${i + 1}`, question: `旧题 ${i + 1}`, options: [] }));
    session.answers = session.questions.map(q => ({ questionId: q.id, skipped: true }));
    const generate = vi.fn().mockResolvedValue(batch(28, 2));
    const result = await generateInterviewBatch(session, { generate }, today);
    expect(result.status).toBe("asking");
    expect(result.questions).toHaveLength(30);
    expect(generate.mock.calls[0]![0].context).toMatchObject({ remainingBudget: 2, maxBatchSize: 2, summaryOnly: false });
  });

  it("bounds malformed-output retries without replacing saved answers or exposing validation internals", async () => {
    const session = start();
    const before = structuredClone(session);
    const generate = vi.fn().mockResolvedValue({ done: false, questions: [] });
    await expect(generateInterviewBatch(session, { generate }, today)).rejects.toThrow("已自动重试并保留回答");
    expect(generate).toHaveBeenCalledTimes(3);
    expect(session).toEqual(before);
  });

  it.each(["timeout", "upstream_failed", "network_failed", "invalid_configuration"] as const)("does not retry %s as a format problem", async code => {
    const generate = vi.fn().mockRejectedValue(new RoadmapperProviderError(code));
    await expect(generateInterviewBatch(start(), { generate }, today)).rejects.toMatchObject({ code });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("returns HTTP success after automatic recovery at both the first batch and summary stages", async () => {
    const root = await mkdtemp(join(tmpdir(), "zhilu-interview-recovery-"));
    const repository = new PlanRepository(root, "unused");
    const generate = vi.fn().mockRejectedValueOnce(new RoadmapperProviderError("invalid_response"))
      .mockResolvedValueOnce(batch(0, 2)).mockResolvedValueOnce({ done: true, questions: [], summary: {} })
      .mockResolvedValueOnce(done());
    const server = createZhiluServer(repository, { roadmapperProvider: { generate } });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/interviews`;
    const post = (path: string, body: unknown) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const initial = await post(url, { goal: "从未开发过游戏，想做一个能和朋友玩的小游戏" });
    expect(initial.status).toBe(201);
    const session = await initial.json() as InterviewSession;
    const response = await post(`${url}/${session.id}/answers`, { answers: answers(session) });
    expect(response.status).toBe(200);
    const completed = await response.json() as InterviewSession;
    expect(completed.status).toBe("complete");
    expect(completed.generationError).toBeUndefined();
    expect(completed.history?.map(event => event.kind)).toEqual(["questions_generated", "answers_submitted", "summary_generated"]);
    expect((await repository.getInterview(session.id)).answers).toHaveLength(2);
    expect(generate).toHaveBeenCalledTimes(4);
    const directory = join(root, "diagnostics", "interviews", session.id);
    const logs = await Promise.all((await readdir(directory)).map(async file => JSON.parse(await readFile(join(directory, file), "utf8"))));
    expect(logs).toHaveLength(4);
    const questionsLog = logs.find(log => log.acceptedQuestions?.length);
    expect(questionsLog.acceptedQuestions).toEqual(session.questions);
    expect(questionsLog.modelOutput.questions).toEqual(batch(0, 2).questions);
    expect(questionsLog.decision).toEqual({ done: false, reason: "还需要了解训练背景", missingInformation: ["训练条件"] });
    expect(logs.find(log => log.decision?.done).answers).toEqual(completed.answers);
  });
});

describe("adaptive interview", () => {
  it("can end after the first five answers when the AI considers the background sufficient", async () => {
    const generate = vi.fn().mockResolvedValueOnce(batch(0, 5)).mockResolvedValueOnce(done());
    const session = await generateInterviewBatch(start(), { generate }, today);
    const completed = await generateInterviewBatch(acceptInterviewAnswers(session, answers(session)), { generate }, today);
    expect(completed.status).toBe("complete");
    expect(completed.questions).toHaveLength(5);
    expect(generate.mock.calls[1]![0].context).toMatchObject({ remainingBudget: 25, summaryOnly: false });
  });

  it("keeps full interview diagnostics within the owning account directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "zhilu-account-diagnostic-"));
    cleanup.push(async () => { await rm(root, { recursive: true, force: true }); });
    const repository = new PlanRepository(root, "unused");
    const session = start();
    const alice = repository.forAccount("a".repeat(64));
    const bob = repository.forAccount("b".repeat(64));
    await generateInterviewBatch({ ...session, backgroundNotes: "Alice 的背景" }, { generate: async () => batch(0, 5) }, today,
      diagnostic => alice.saveInterviewDiagnostic(diagnostic));
    await generateInterviewBatch({ ...session, backgroundNotes: "Bob 的背景" }, { generate: async () => batch(0, 5) }, today,
      diagnostic => bob.saveInterviewDiagnostic(diagnostic));
    for (const [account, owner, other] of [["a", "Alice", "Bob"], ["b", "Bob", "Alice"]] as const) {
      const directory = join(root, "accounts", account.repeat(64), "diagnostics", "interviews", session.id);
      const files = await readdir(directory);
      expect(files).toHaveLength(1);
      const content = await readFile(join(directory, files[0]!), "utf8");
      expect(content).toContain(`${owner} 的背景`);
      expect(content).not.toContain(`${other} 的背景`);
    }
    await expect(readdir(join(root, "diagnostics"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lets the AI continue in five-question rounds past twelve, then end at twenty", async () => {
    const generate = vi.fn();
    let offset = 0;
    for (const count of [5, 5, 5, 5]) { generate.mockResolvedValueOnce(batch(offset, count)); offset += count; }
    generate.mockResolvedValueOnce(done());
    let session = await generateInterviewBatch(start(), { generate }, today);
    for (const count of [5, 5, 5, 5]) {
      expect(session.questions.length - session.answers.length).toBe(count);
      session = await generateInterviewBatch(acceptInterviewAnswers(session, answers(session)), { generate }, today);
    }
    expect(session.status).toBe("complete");
    expect(session.answers).toHaveLength(20);
    expect(session.summary?.userContext.confirmed).toBe(false);
    expect(session.summary?.goalContract).toMatchObject({ goal: "完成第一场马拉松", confirmed: false });
    expect(generate).toHaveBeenCalledTimes(5);
    expect(generate.mock.calls[1]![0].context).toMatchObject({ goal: session.goal, remainingBudget: 25, maxBatchSize: 5,
      history: expect.arrayContaining([expect.objectContaining({ question: "跑步背景 1？", options: ["已有经验", "尚无经验", "不确定"], answer: "已有经验" })]) });
    expect(generate.mock.calls[4]![0].context.history).toHaveLength(20);
  });

  it("enforces thirty questions, then requests only a summary", async () => {
    let session = start();
    for (const count of [5, 5, 5, 5, 5, 5]) {
      session = await generateInterviewBatch(session, { generate: async () => batch(session.questions.length, count) }, today);
      session = acceptInterviewAnswers(session, answers(session));
    }
    expect(session.questions).toHaveLength(30);
    await expect(generateInterviewBatch(session, { generate: async () => batch(30, 1) }, today)).rejects.toThrow("已自动重试");
    const generate = vi.fn().mockResolvedValue(done());
    expect((await generateInterviewBatch(session, { generate }, today)).status).toBe("complete");
    expect(generate.mock.calls[0]![0].context).toMatchObject({ remainingBudget: 0, maxBatchSize: 0, summaryOnly: true });
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
    const draft = [{ questionId: session.questions[0]!.id, optionIds: [session.questions[0]!.options[0]!.id] }];
    expect((await post(`${url}/${session.id}/draft`, { answers: draft })).status).toBe(200);
    // A fresh repository instance (as after a process restart) restores the partial batch.
    expect((await new PlanRepository(root, "unused").getInterview(session.id)).draftAnswers).toEqual(draft);
    const listing = await (await fetch(url.replace("/interviews", "/history"))).json();
    expect(listing.interviews).toMatchObject([{ id: session.id, draftCount: 1, answerCount: 0 }]);
    const silent = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await post(`${url}/${session.id}/answers`, { answers: answers(session) })).status).toBe(502);
    silent.mockRestore();
    const saved = await (await fetch(`${url}/${session.id}`)).json() as InterviewSession;
    expect(saved.answers).toHaveLength(2);
    expect(saved.draftAnswers).toEqual([]);
    expect((await post(`${url}/${session.id}/draft`, { answers: draft })).status).toBe(400);
    expect(saved.history?.map(event => event.kind)).toEqual(["questions_generated", "answers_submitted", "generation_failed"]);
    expect((await post(`${url}/${session.id}/answers`, { answers: answers(session) })).status).toBe(409);
    const final = await post(`${url}/${session.id}/next`, { goal: "伪造目标", questions: batch(0, 30).questions });
    expect(final.status).toBe(200);
    const completed = await final.json() as InterviewSession;
    expect(completed).toMatchObject({ goal: session.goal, status: "complete" });
    const projectResponse = await post(url.replace("/interviews", "/projects"), { ...completed.summary,
      interviewId: session.id, userContext: { ...completed.summary!.userContext, confirmed: true },
      goalContract: { ...completed.summary!.goalContract, confirmed: true } });
    expect(projectResponse.status).toBe(201);
    const project = await projectResponse.json();
    const restored = await new PlanRepository(root, "unused").getInterview(session.id);
    expect(restored.projectId).toBe(project.projectId);
    expect(restored.history?.at(-1)?.kind).toBe("project_created");
    expect((await (await fetch(url.replace("/interviews", "/history"))).json()).projects).toMatchObject([{ id: project.projectId }]);
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
  it("saves incomplete other/text drafts, but rejects forged or already submitted questions", async () => {
    const session = await generateInterviewBatch(start(), { generate: async () => mixed() }, today);
    const draft = saveInterviewDraft(session, [
      { questionId: "q-1", optionIds: ["q-1-o-2"] }, { questionId: "q-3", text: "" },
      { questionId: "q-2", optionIds: ["q-2-o-1", "q-2-o-2"], text: "草稿" }, { questionId: "q-4", skipped: true },
    ]);
    expect(draft.answers).toHaveLength(0);
    expect(draft.draftAnswers).toHaveLength(4);
    expect(() => acceptInterviewAnswers(session, draft.draftAnswers)).toThrow("补充");
    expect(() => saveInterviewDraft(session, [{ questionId: "unknown", text: "x" }])).toThrow();
    expect(() => saveInterviewDraft(session, [{ questionId: "q-1", optionIds: ["forged"] }])).toThrow();
  });
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
    await expect(generateInterviewBatch(answered, { generate }, today)).rejects.toThrow("已自动重试");
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
