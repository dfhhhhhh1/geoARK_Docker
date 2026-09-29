/**
 * Behavior pin for the op-registry refactor.
 *
 * `buildSystemPrompt` and `planSchemaFor` are the two things every planner
 * measurement in this project rests on. Moving them into a registry is a pure
 * restructuring, so their output must not move by a single byte -- if it does,
 * 95.2% op appropriateness was measured against a prompt that no longer exists.
 *
 *   node backend/planner/snapshot_prompt.js --write   # before the refactor
 *   node backend/planner/snapshot_prompt.js           # after; exits non-zero on drift
 *
 * The matrix is every combination of narrowing inputs that changes the output,
 * so a regression in ANY branch is caught rather than just the default one.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { buildSystemPrompt } = require("./index");
const { planSchemaFor } = require("../schemas");

const SNAP = path.join(__dirname, "prompt_snapshot.json");

/** Every context that produces a distinct prompt or schema. */
function contexts() {
  const out = [];
  for (const hasFeatureTables of [false, true]) {
    for (const featureTableCount of [0, 1, 2]) {
      for (const mentionsArea of [false, true]) {
        for (const wantsLocations of [false, true]) {
          for (const hasFilterableValues of [false, true]) {
            for (const hasPlaceBoundaries of [false, true]) {
              // featureTableCount only means anything when there ARE feature
              // tables; skip the impossible combinations rather than pinning
              // states the caller can never produce.
              if (!hasFeatureTables && featureTableCount > 0) continue;
              if (hasFeatureTables && featureTableCount === 0) continue;
              out.push({
                hasFeatureTables, featureTableCount, mentionsArea,
                wantsLocations, hasFilterableValues, hasPlaceBoundaries,
              });
            }
          }
        }
      }
    }
  }
  return out;
}

const digest = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

function capture() {
  const rows = [];
  for (const ctx of contexts()) {
    const prompt = buildSystemPrompt(ctx);
    const schema = planSchemaFor(ctx);
    rows.push({
      ctx,
      prompt_sha: digest(prompt),
      prompt_len: prompt.length,
      // The op enum and field list are the parts a refactor is most likely to
      // reorder, and order matters: it is what the decoder sees.
      ops: schema.properties.steps.items.properties.op.enum,
      fields: Object.keys(schema.properties.steps.items.properties),
      prompt,
    });
  }
  return rows;
}

function main() {
  const rows = capture();
  const write = process.argv.includes("--write");

  if (write) {
    fs.writeFileSync(SNAP, JSON.stringify(rows, null, 2), "utf8");
    console.log(`wrote ${rows.length} contexts -> ${path.relative(process.cwd(), SNAP)}`);
    return 0;
  }

  if (!fs.existsSync(SNAP)) {
    console.error(`no snapshot at ${SNAP}; run with --write first`);
    return 2;
  }

  const old = JSON.parse(fs.readFileSync(SNAP, "utf8"));
  if (old.length !== rows.length) {
    console.error(`context count changed: ${old.length} -> ${rows.length}`);
    return 1;
  }

  let drift = 0;
  for (let i = 0; i < rows.length; i++) {
    const a = old[i], b = rows[i];
    const label = JSON.stringify(b.ctx);
    if (a.prompt_sha !== b.prompt_sha) {
      drift++;
      console.error(`\nPROMPT DRIFT  ${label}`);
      const al = a.prompt.split("\n"), bl = b.prompt.split("\n");
      for (let n = 0; n < Math.max(al.length, bl.length); n++) {
        if (al[n] !== bl[n]) {
          console.error(`  line ${n + 1}\n    was: ${JSON.stringify(al[n])}\n    now: ${JSON.stringify(bl[n])}`);
          break;
        }
      }
    }
    if (JSON.stringify(a.ops) !== JSON.stringify(b.ops)) {
      drift++;
      console.error(`\nOP ENUM DRIFT ${label}\n  was: ${a.ops}\n  now: ${b.ops}`);
    }
    if (JSON.stringify(a.fields) !== JSON.stringify(b.fields)) {
      drift++;
      console.error(`\nFIELD DRIFT   ${label}\n  was: ${a.fields}\n  now: ${b.fields}`);
    }
  }

  if (drift) {
    console.error(`\n${drift} difference(s) across ${rows.length} contexts`);
    return 1;
  }
  console.log(`prompt and schema identical across ${rows.length} contexts`);
  return 0;
}

process.exit(main());
