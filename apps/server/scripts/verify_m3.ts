/** Local M3-only acceptance. No Zhihu provider or PlanRepository is imported. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executeM3Replay, parseM3ReplayArguments, readM3Snapshot, safeM3ReplayFailure, saveM3ReplayArtifacts } from "../src/m3-replay";
import { syntheticM3Snapshot } from "../src/fixtures/m3-replay";

export async function main(args = process.argv.slice(2)): Promise<void> {
  try {
    const options = parseM3ReplayArguments(args);
    if (options.help) {
      console.log("Usage: verify_m3.ts [--snapshot <local JSON path>] [--live]\nDefault: synthetic offline fixture, zero API calls. --snapshot alone: synthetic model replay on local evidence.\n--live requires --snapshot and makes at most one real Roadmapper call; no Zhihu, retry, Plan or History writes.\nSnapshot: {plan: research-ready PlanState, research: LiveResearchInput}, at most 2 MiB. Provider settings come only from process.env.\nArtifacts: data/verification/m3-<new UUID>/. Structural pass still requires source, semantic and plan review; offline is not true M3 acceptance.");
      return;
    }
    const snapshot = options.snapshotPath ? await readM3Snapshot(options.snapshotPath) : syntheticM3Snapshot();
    const result = await executeM3Replay(snapshot, { live: options.live });
    const outputDir = await saveM3ReplayArtifacts(resolve(import.meta.dirname, "../../.."), result);
    console.log(JSON.stringify({ ...result.report, inputKind: options.snapshotPath ? "local_snapshot" : "synthetic_fixture", outputDir }, null, 2));
    if (result.report.status !== "structural_pass") process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ status: "failed", failureCode: safeM3ReplayFailure(error) }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
