import { spawn } from "node:child_process";
import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createGateway } from "./gateway.mjs";

// Do not silently put account history on the container's disposable filesystem.
const dataRoot = resolve(process.env.ZHILU_DATA_DIR ?? "/mnt/zhilu");
const mounts = (await readFile("/proc/self/mountinfo", "utf8")).split("\n").map(line => line.split(" ")[4]);
if (!mounts.some(path => path && path !== "/" && (dataRoot === path || dataRoot.startsWith(path + "/")))) {
  throw new Error("ZHILU_DATA_DIR must be on a persistent storage mount before starting the deployment.");
}
await mkdir(dataRoot, { recursive: true });
const probe = join(dataRoot, `.zhilu-storage-check-${process.pid}`);
await writeFile(probe, "storage-check", { mode: 0o600 });
await rename(probe, probe + ".renamed");
await rm(probe + ".renamed");

const backend = spawn(process.execPath, ["--import", "tsx", "apps/server/src/index.ts"], {
  stdio: "inherit", env: { ...process.env, PORT: "8787" },
});
const gateway = createGateway({ webRoot: "apps/web/dist" });
gateway.listen(Number(process.env.PORT ?? 8080), "0.0.0.0");
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  gateway.close();
  gateway.closeAllConnections();
  backend.kill("SIGTERM");
  setTimeout(() => { backend.kill("SIGKILL"); process.exit(code); }, 5000).unref();
  process.exitCode = code;
}
backend.on("error", () => stop(1));
backend.on("exit", code => stop(code ?? 1));
gateway.on("error", () => stop(1));
process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0));
