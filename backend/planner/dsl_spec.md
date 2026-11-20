# GeoARK 1-Line DSL Specification

## 1. Syntax Overview
A plan is either a refusal:
```
REFUSE(missing: ["concept1", ...])
REFUSE(reason: "data_unavailable")
REFUSE()
```
Or a pipe-delimited sequence of operator steps:
```
step1 | step2 | ... | stepN
```
Optionally prefixed by an intent string:
```
INTENT("Description of analysis") | load(a1) | filter_area([MO]) | output
```
If `INTENT(...)` is omitted, the parser derives a sensible default intent string.

## 2. Step Structure
Each step has the format:
```
[step_id:] op_name(arguments...)
```
- If `step_id:` is omitted, steps are auto-numbered sequentially: `s1`, `s2`, `s3`, ...
- Step IDs are alphanumeric (e.g., `s1`, `s2`, `s3`).

## 3. Wiring and Inputs
- **0-input ops** (`load`, `count_features`, `count_near`, `nearest_distance`, `select_features`, `zonal`):
  `inputs: []`
- **1-input ops** (`filter_attr`, `filter_area`, `filter_place`, `per_area`, `aggregate`, `rank`, `hotspot`, `outlier`, `explain`, `summarize`, `neighbors`, `access`, `output`):
  - If a step ID reference (e.g. `s1`) is given as an argument, `inputs: ["s1"]`.
  - If NO step ID reference is given, it defaults to the preceding step: `inputs: [prev_step_id]`.
- **2-input ops** (`normalize`, `join`, `combine`, `correlate`, `intersect`, `compare_groups`, `within`, `overlay`, `residual`):
  - Inputs can be passed positionally first: `op(s1, s2, ...)` or as `inputs=[s1, s2]`.
  - If omitted and there are preceding steps, it wires to `[s_{n-2}, s_{n-1}]` or `[s1, s_{prev}]`.

## 4. Operator Signatures & Arguments
Arguments can be positional or `key=value` (or `key: value`). Strings can be quoted or unquoted identifiers where unambiguous. Arrays use `[...]`.

1. `load(attr_id, year=YYYY)`
   - `load(a1)`
   - `load(a1, year=2021)`
   - AST: `{ id, op: "load", attr_id: "a1", inputs: [], year: 2021 }`

2. `count_features(attr_id, [column="value", ...])`
   - `count_features(a2)`
   - `count_features(a2, type="CRITICAL ACCESS")`
   - AST: `{ id, op: "count_features", attr_id: "a2", inputs: [], attribute_filters: [{column: "type", value: "CRITICAL ACCESS"}] }`

3. `count_near(attr_id, near_attr_id, miles=N)`
   - `count_near(a1, a2, 5)` or `count_near(a1, a2, miles=5)`
   - AST: `{ id, op: "count_near", attr_id: "a1", near_attr_id: "a2", miles: 5, inputs: [] }`

4. `nearest_distance(attr_id)`
   - `nearest_distance(a3)`
   - AST: `{ id, op: "nearest_distance", attr_id: "a3", inputs: [] }`

5. `select_features(attr_id, states=[...], city="...", limit=N, [column="value"])`
   - `select_features(a4, states=["Missouri"], limit=50)`
   - `select_features(a4, city="Springfield")`
   - AST: `{ id, op: "select_features", attr_id: "a4", inputs: [], states: ["Missouri"], limit: 50 }`

6. `within(in1, in2, miles=N, exclude=bool)`
   - `within(s1, s2, miles=5)`
   - `within(s1, s2, 3, exclude=true)`
   - AST: `{ id, op: "within", attr_id: "", inputs: ["s1", "s2"], miles: 5 }`

7. `overlay(in1, in2, exclude=bool)`
   - `overlay(s1, s2)`
   - `overlay(s1, s2, exclude=true)`
   - AST: `{ id, op: "overlay", attr_id: "", inputs: ["s1", "s2"] }`

8. `summarize([in1], group_by="state"|"none")`
   - `summarize()` or `summarize(s1)` or `summarize(group_by="state")`
   - AST: `{ id, op: "summarize", attr_id: "", inputs: ["s1"], group_by: "state" }`

9. `filter_attr([in1], operator="...", value=N, percentile=N, definition="...")`
   - `filter_attr(">", 10)` or `filter_attr(operator=">=", value=50)`
   - `filter_attr(">=", percentile=75)`
   - `filter_attr(definition="d1")`
   - AST: `{ id, op: "filter_attr", attr_id: "", inputs: ["s1"], operator: ">=", value: 50 }`

10. `filter_area([in1], states=[...])`
    - `filter_area(["Missouri"])` or `filter_area(states=["Midwest", "Texas"])`
    - AST: `{ id, op: "filter_area", attr_id: "", inputs: ["s1"], states: ["Missouri"] }`

11. `filter_place([in1], place_kind="place"|"zcta"|"cbsa"|"urban", place_name="...", states=[...])`
    - `filter_place(cbsa, "Chicago")` or `filter_place(place_kind="cbsa", place_name="Chicago", states=["Illinois"])`
    - AST: `{ id, op: "filter_place", attr_id: "", inputs: ["s1"], place_kind: "cbsa", place_name: "Chicago" }`

12. `per_area([in1])`
    - `per_area()` or `per_area(s1)`
    - AST: `{ id, op: "per_area", attr_id: "", inputs: ["s1"] }`

13. `normalize(in1, in2, scale=N)`
    - `normalize(s1, s2, scale=100)` or `normalize(s1, s2, 100)` or `normalize(s1, s2)`
    - AST: `{ id, op: "normalize", attr_id: "", inputs: ["s1", "s2"], scale: 100 }`

14. `aggregate([in1], function="mean"|"sum"|"count"|"min"|"max", group_by="state"|"none")`
    - `aggregate(mean)` or `aggregate(function="mean", group_by="state")`
    - AST: `{ id, op: "aggregate", attr_id: "", inputs: ["s1"], function: "mean" }`

15. `rank([in1], direction="desc"|"asc", limit=N)`
    - `rank(desc, 10)` or `rank(direction="desc", limit=10)`
    - AST: `{ id, op: "rank", attr_id: "", inputs: ["s1"], direction: "desc", limit: 10 }`

16. `join(in1, in2)`
    - `join(s1, s2)`
    - AST: `{ id, op: "join", attr_id: "", inputs: ["s1", "s2"] }`

17. `combine(in1, in2, operation="ratio"|"sum"|"difference"|"percent_change", scale=N)`
    - `combine(s1, s2, operation="difference")` or `combine(s1, s2, percent_change)`
    - AST: `{ id, op: "combine", attr_id: "", inputs: ["s1", "s2"], operation: "difference" }`

18. `hotspot([in1])`
    - `hotspot()` or `hotspot(s1)`
    - AST: `{ id, op: "hotspot", attr_id: "", inputs: ["s1"] }`

19. `outlier([in1])`
    - `outlier()` or `outlier(s1)`
    - AST: `{ id, op: "outlier", attr_id: "", inputs: ["s1"] }`

20. `correlate(in1, in2)`
    - `correlate(s1, s2)`
    - AST: `{ id, op: "correlate", attr_id: "", inputs: ["s1", "s2"] }`

21. `explain([in1])`
    - `explain()` or `explain(s1)`
    - AST: `{ id, op: "explain", attr_id: "", inputs: ["s1"] }`

22. `intersect(in1, in2, exclude=bool)`
    - `intersect(s1, s2)` or `intersect(s1, s2, exclude=true)`
    - AST: `{ id, op: "intersect", attr_id: "", inputs: ["s1", "s2"] }`

23. `compare_groups(in1, in2)`
    - `compare_groups(s1, s2)`
    - AST: `{ id, op: "compare_groups", attr_id: "", inputs: ["s1", "s2"] }`

24. `neighbors([in1], operation="difference"|"ratio")`
    - `neighbors()` or `neighbors(s1, operation="difference")`
    - AST: `{ id, op: "neighbors", attr_id: "", inputs: ["s1"] }`

25. `residual(in1, in2)`
    - `residual(s1, s2)`
    - AST: `{ id, op: "residual", attr_id: "", inputs: ["s1", "s2"] }`

26. `access([in1], attr_id, miles=N)`
    - `access(s1, a2, miles=30)` or `access(a2, 30)`
    - AST: `{ id, op: "access", attr_id: "a2", inputs: ["s1"], miles: 30 }`

27. `zonal(attr_id, year=YYYY, [column="value"], operator="...", value=N)`
    - `zonal(a1)` or `zonal(a1, year=2021)`
    - AST: `{ id, op: "zonal", attr_id: "a1", inputs: [] }`

28. `output([in1])`
    - `output()` or `output(s3)`
    - AST: `{ id, op: "output", attr_id: "", inputs: ["s3"] }`

29. `REFUSE(...)`
    - `REFUSE(missing=["rainfall"])`
    - AST: `{ intent: "Refusal: requested data unavailable", output_type: "map", entity_type: "COUNTY", steps: [] }`

## 5. Output AST Schema
Every successful parse produces:
```json
{
  "intent": "String describing plan",
  "output_type": "map",
  "entity_type": "COUNTY",
  "steps": [ ... ]
}
```
If `correlate` or `explain` is present, `output_type` is `"statistics"`.
Every step always has `id`, `op`, `inputs` (array), and `attr_id` (string, `""` for non-load steps) to satisfy `PLAN_SCHEMA` invariants.
