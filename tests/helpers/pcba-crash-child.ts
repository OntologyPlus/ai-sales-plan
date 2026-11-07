import { writeFile } from "node:fs/promises";
import { openPcbaPoc } from "../../scripts/poc/pcba-runtime.js";
import { syntheticPcbaSnapshot } from "../fixtures/pcba.js";

const [path, marker] = process.argv.slice(2);
if (!path || !marker) throw new Error("Expected temporary session and marker paths");
const observations = { modelRequests: 0, tools: [] as string[] };
const session = await openPcbaPoc(path, syntheticPcbaSnapshot(), async () => {
  if (observations.tools.includes("read_evidence")) {
    // The previous read_application result is committed. Die inside a replay-safe read.
    await writeFile(marker, "paused-in-read-tool");
    await new Promise<void>(() => { setInterval(() => {}, 1000); });
  }
}, observations);
await session.run();
await session.close();
