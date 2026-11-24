/** Run: node backend/test_place_case.js */
const assert = require("node:assert");
const { capitalizePlaces } = require("./place_case");

const PLACES = new Set(["columbus", "springfield", "salt lake city", "poverty"]);
const sql = async (text, [names]) => ({
  rows: text.includes("split_part") ? [] : names.filter(n => PLACES.has(n)).map(n => ({ n })),
});
let fail = 0;
async function t(name, q, expect) {
  const got = (await capitalizePlaces(q, sql)).query;
  try { assert.strictEqual(got, expect); console.log("  ok  ", name); }
  catch (e) { fail++; console.log("  FAIL", name, "->", got); }
}
(async () => {
  await t("city", "elderly population in columbus", "elderly population in Columbus");
  await t("city + state", "elderly population in springfield, missouri", "elderly population in Springfield, Missouri");
  await t("multi-word", "poverty around salt lake city", "poverty around Salt Lake City");
  await t("already capitalised", "elderly population in Columbus", "elderly population in Columbus");
  await t("not a place", "people in each county", "people in each county");
  await t("trailing words kept", "income in columbus by county", "income in Columbus by county");
  console.log(fail ? `${fail} failed` : "all passed");
  process.exit(fail ? 1 : 0);
})();
