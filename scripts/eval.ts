// npm run eval: score every classifier configuration on the same golden dataset.
// With ANTHROPIC_API_KEY set (and `npm install`), Claude is added as a configuration.
import { mkdirSync, writeFileSync } from "node:fs";
import { heuristic, reckless, rulesOnly, type Classifier } from "../src/classify.ts";
import { goldenDataset, SCENARIOS } from "../src/dataset.ts";
import { evaluate, table } from "../src/eval.ts";

const SEED = Number(process.env.SEED ?? 7);
const PER_SCENARIO = Number(process.env.PER_SCENARIO ?? 25);
const cases = goldenDataset(SEED, PER_SCENARIO);
mkdirSync("evals", { recursive: true });
writeFileSync("evals/golden_dataset.jsonl", cases.map((c) => JSON.stringify(c)).join("\n") + "\n");

const configs: [string, Classifier][] = [["rules-only", rulesOnly], ["heuristic", heuristic], ["reckless", reckless]];
if (process.env.ANTHROPIC_API_KEY) {
  const { claudeClassifier } = await import("../adapters/claude.ts");
  configs.push([process.env.CLAUDE_MODEL ?? "claude-opus-5-5", claudeClassifier()]);
}

const reports = [];
for (const [name, c] of configs) reports.push(await evaluate(name, c, cases));

console.log(`${cases.length} synthetic cases, ${SCENARIOS.length} scenarios x ${PER_SCENARIO} (seed ${SEED}); written to evals/golden_dataset.jsonl\n`);
console.log(table(reports));
console.log("\nWhere each configuration acted wrongly:");
for (const r of reports) {
  const bad = Object.entries(r.byScenario).filter(([, o]) => o["false-auto"] > 0).map(([s, o]) => `${s} ${o["false-auto"]}`);
  console.log(`  ${r.config.padEnd(18)} ${bad.length ? bad.join(", ") : "none"}`);
}
writeFileSync("evals/report.json", JSON.stringify(reports, null, 2) + "\n");
