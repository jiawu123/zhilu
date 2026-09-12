import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parseResearchResponse } from "./zhihu-boundary.js";

it("accepts real Python compiler output across UTF-8 and codepoint offsets", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const local = resolve(root, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
  const python = process.env.ZHIHU_TEST_PYTHON_BIN || (existsSync(local) ? local : "python");
  const stdout = execFileSync(python, ["-X", "utf8", "tests/fixtures/compiler_boundary_offline.py"], {
    cwd: resolve(root, "packages/zhihu"), encoding: "utf8", timeout: 15_000,
    env: { ...process.env, PYTHONPATH: resolve(root, "packages/zhihu"), PYTHON_DOTENV_DISABLED: "1", PYTHONDONTWRITEBYTECODE: "1" },
  });
  const result = parseResearchResponse(JSON.parse(stdout), { id: "external-rq", question: "怎样检查程序？", searchQueries: ["程序 检查"], relevantUserConditions: [], evidenceLimit: 1 });
  expect(result.pack.evidence[0]).toMatchObject({ author: "合成作者", supportingQuote: "给程序输入固定样例，并检查输出结果。", verificationStatus: "unverified", riskTags: ["search_snippet_only", "not_independently_verified", "semantic_support_not_checked"] });
  expect(result.pack.evidence[0]!.retrievedAt).toBeUndefined();
});
