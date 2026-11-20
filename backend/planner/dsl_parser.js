/**
 * GeoARK 1-Line DSL Parser.
 *
 * Converts a 1-line pipe-delimited analysis plan string into GeoARK's AST format:
 *   {
 *     intent: string,
 *     output_type: "map" | "statistics",
 *     entity_type: "COUNTY",
 *     steps: [ ... ]
 *   }
 *
 * Adheres strictly to backend/planner/dsl_spec.md and PLAN_SCHEMA invariants.
 */

const { POSTAL_TO_NAME } = require("../states");

class DslParseError extends Error {
  constructor(message, position = null) {
    super(message);
    this.name = "DslParseError";
    this.position = position;
  }
}

const OP_ARITY = {
  load: 0,
  count_features: 0,
  count_near: 0,
  nearest_distance: 0,
  select_features: 0,
  zonal: 0,

  summarize: 1,
  filter_attr: 1,
  filter_area: 1,
  filter_place: 1,
  per_area: 1,
  aggregate: 1,
  rank: 1,
  hotspot: 1,
  outlier: 1,
  explain: 1,
  neighbors: 1,
  access: 1,
  output: 1,

  within: 2,
  overlay: 2,
  normalize: 2,
  join: 2,
  combine: 2,
  correlate: 2,
  intersect: 2,
  compare_groups: 2,
  residual: 2,
};

const ATTR_OPS = new Set([
  "load",
  "count_features",
  "count_near",
  "nearest_distance",
  "select_features",
  "access",
  "zonal",
]);

/**
 * Splits top-level pipe segments, ignoring pipes inside strings, brackets, parens, or braces.
 */
function splitPipes(dsl) {
  const segments = [];
  let current = "";
  let inDouble = false;
  let inSingle = false;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let escaped = false;

  for (let i = 0; i < dsl.length; i++) {
    const ch = dsl[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }

    if (inDouble || inSingle) {
      current += ch;
      continue;
    }

    // Single-line comments (# or //) outside quotes
    if (ch === '#' || (ch === '/' && i + 1 < dsl.length && dsl[i + 1] === '/')) {
      while (i < dsl.length && dsl[i] !== '\n') {
        i++;
      }
      continue;
    }

    if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === '[') bracketDepth++;
    else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === '{') braceDepth++;
    else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);

    if (ch === '|' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      segments.push(current);
      current = "";
    } else {
      current += ch;
    }
  }

  if (inDouble || inSingle) {
    throw new DslParseError("Unterminated string quote");
  }
  if (parenDepth > 0) {
    throw new DslParseError("Unmatched opening parenthesis '('");
  }
  if (bracketDepth > 0) {
    throw new DslParseError("Unmatched opening bracket '['");
  }
  if (braceDepth > 0) {
    throw new DslParseError("Unmatched opening brace '{'");
  }

  segments.push(current);
  return segments;
}

/**
 * Tokenizes argument strings inside op(...).
 */
function tokenize(str) {
  const tokens = [];
  let i = 0;
  const n = str.length;

  while (i < n) {
    const ch = str[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Quoted strings
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let val = "";
      let escaped = false;
      while (i < n) {
        const c = str[i];
        if (escaped) {
          if (c === "n") val += "\n";
          else if (c === "t") val += "\t";
          else if (c === "r") val += "\r";
          else val += c;
          escaped = false;
        } else if (c === "\\") {
          escaped = true;
        } else if (c === quote) {
          i++;
          break;
        } else {
          val += c;
        }
        i++;
      }
      tokens.push({ type: "STRING", value: val });
      continue;
    }

    // Comparison / equality operators
    if (ch === '<' || ch === '>' || ch === '!' || ch === '=') {
      if (i + 1 < n && str[i + 1] === '=') {
        const opVal = str.slice(i, i + 2);
        tokens.push({ type: "OPERATOR", value: opVal });
        i += 2;
        continue;
      }
      if (ch === '=') {
        tokens.push({ type: "EQUALS", value: "=" });
      } else {
        tokens.push({ type: "OPERATOR", value: ch });
      }
      i++;
      continue;
    }

    // Single-character delimiters
    if (ch === ':' || ch === ',' || ch === '[' || ch === ']' || ch === '{' || ch === '}' || ch === '(' || ch === ')') {
      tokens.push({ type: ch, value: ch });
      i++;
      continue;
    }

    // Numbers (including negative numbers)
    if (/\d/.test(ch) || (ch === '-' && i + 1 < n && /\d/.test(str[i + 1]))) {
      let numStr = ch;
      i++;
      while (i < n && /[\d.]/.test(str[i])) {
        numStr += str[i];
        i++;
      }
      const num = Number(numStr);
      if (Number.isNaN(num)) {
        throw new DslParseError(`Invalid number: "${numStr}"`);
      }
      tokens.push({ type: "NUMBER", value: num });
      continue;
    }

    // Identifiers and words
    if (/[a-zA-Z0-9_\-.]/.test(ch)) {
      let word = "";
      while (i < n && /[a-zA-Z0-9_\-.]/.test(str[i])) {
        word += str[i];
        i++;
      }
      const lower = word.toLowerCase();
      if (lower === "true") {
        tokens.push({ type: "BOOLEAN", value: true });
      } else if (lower === "false") {
        tokens.push({ type: "BOOLEAN", value: false });
      } else if (lower === "null") {
        tokens.push({ type: "NULL", value: null });
      } else {
        tokens.push({ type: "IDENTIFIER", value: word });
      }
      continue;
    }

    tokens.push({ type: "CHAR", value: ch });
    i++;
  }

  return tokens;
}

/**
 * Splits argument tokens at depth 0 on commas.
 */
function splitArgTokens(tokens) {
  const argSlices = [];
  let current = [];
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  for (const token of tokens) {
    if (token.type === "(") parenDepth++;
    else if (token.type === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (token.type === "[") bracketDepth++;
    else if (token.type === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (token.type === "{") braceDepth++;
    else if (token.type === "}") braceDepth = Math.max(0, braceDepth - 1);

    if (token.type === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      if (current.length > 0) {
        argSlices.push(current);
        current = [];
      }
    } else {
      current.push(token);
    }
  }

  if (current.length > 0) {
    argSlices.push(current);
  }

  return argSlices;
}

/**
 * Parses a value from a token slice.
 */
function parseValueTokens(tokens) {
  if (!tokens || tokens.length === 0) return null;

  // Single literal token
  if (tokens.length === 1) {
    const t = tokens[0];
    if (t.type === "STRING" || t.type === "NUMBER" || t.type === "BOOLEAN" ||
        t.type === "IDENTIFIER" || t.type === "OPERATOR") {
      return t.value;
    }
    if (t.type === "NULL") return null;
  }

  // Operator followed by number, e.g. [> 10]
  if (tokens.length === 2 && tokens[0].type === "OPERATOR" && tokens[1].type === "NUMBER") {
    return { operator: tokens[0].value, value: tokens[1].value };
  }

  // Array: [ ... ]
  if (tokens[0].type === "[" && tokens[tokens.length - 1].type === "]") {
    const inner = tokens.slice(1, -1);
    const itemSlices = splitArgTokens(inner);
    const list = [];
    for (const slice of itemSlices) {
      // Check for object or key=value shorthand inside array
      if (slice.length >= 3 && (slice[1].type === "EQUALS" || slice[1].type === ":")) {
        const k = slice[0].value;
        const v = parseValueTokens(slice.slice(2));
        list.push({ column: String(k), value: String(v) });
      } else {
        list.push(parseValueTokens(slice));
      }
    }
    return list;
  }

  // Object: { ... }
  if (tokens[0].type === "{" && tokens[tokens.length - 1].type === "}") {
    const inner = tokens.slice(1, -1);
    const pairSlices = splitArgTokens(inner);
    const obj = {};
    for (const pair of pairSlices) {
      if (pair.length >= 3 && (pair[1].type === "EQUALS" || pair[1].type === ":")) {
        const k = pair[0].value;
        const v = parseValueTokens(pair.slice(2));
        obj[k] = v;
      }
    }
    return obj;
  }

  // Fallback: join token values
  return tokens.map(t => t.value).join(" ");
}

/**
 * Parses arguments into positional and named maps.
 */
function parseArguments(argsStr) {
  if (!argsStr || !argsStr.trim()) {
    return { positional: [], named: {} };
  }

  const tokens = tokenize(argsStr);
  const slices = splitArgTokens(tokens);
  const positional = [];
  const named = {};

  for (const slice of slices) {
    if (slice.length === 0) continue;

    // Check for key=value or key: value
    if (slice.length >= 3 &&
        (slice[0].type === "IDENTIFIER" || slice[0].type === "STRING") &&
        (slice[1].type === "EQUALS" || slice[1].type === ":")) {
      const key = slice[0].value;
      const val = parseValueTokens(slice.slice(2));
      named[key] = val;
    } else {
      // Check for operator + number, e.g. > 10 in filter_attr
      if (slice.length === 2 && slice[0].type === "OPERATOR" && slice[1].type === "NUMBER") {
        positional.push(slice[0].value);
        positional.push(slice[1].value);
      } else {
        const val = parseValueTokens(slice);
        positional.push(val);
      }
    }
  }

  return { positional, named };
}

/**
 * Normalizes state lists (handles 2-letter postal codes e.g. MO -> Missouri).
 */
function toStateList(val) {
  if (!val) return [];
  const rawList = Array.isArray(val) ? val : [val];
  return rawList.map(item => {
    const s = String(item).trim();
    const upper = s.toUpperCase();
    if (POSTAL_TO_NAME[upper]) {
      return POSTAL_TO_NAME[upper];
    }
    return s;
  });
}

/**
 * Determines whether a token is a step ID reference.
 */
function isStepRef(token, existingIds) {
  if (typeof token !== "string") return false;
  const s = token.trim();
  if (existingIds.has(s)) return true;
  return /^s\d+$/i.test(s);
}

/**
 * Extracts and normalizes attribute filters.
 */
function extractAttributeFilters(named, positional) {
  const filters = [];

  if (Array.isArray(named.attribute_filters)) {
    for (const f of named.attribute_filters) {
      if (f && typeof f === "object") {
        const col = f.column || Object.keys(f).find(k => k !== "negate");
        const val = f.value !== undefined ? f.value : f[col];
        const entry = { column: String(col), value: String(val) };
        if (f.negate) entry.negate = true;
        filters.push(entry);
      }
    }
  }

  // Any named argument that represents a filter column (type, status, owner, etc.)
  const knownKeys = new Set([
    "attr_id", "near_attr_id", "miles", "states", "city", "limit",
    "inputs", "in1", "in2", "year", "operator", "value", "percentile",
    "definition", "exclude", "function", "group_by", "direction",
    "scale", "place_kind", "place_name", "operation", "attribute_filters",
  ]);

  for (const [k, v] of Object.entries(named)) {
    if (!knownKeys.has(k) && v !== undefined && v !== null) {
      filters.push({ column: k, value: String(v) });
    }
  }

  // Positional objects (e.g. { column: "type", value: "CRITICAL ACCESS" })
  for (const p of positional) {
    if (p && typeof p === "object" && !Array.isArray(p)) {
      if (p.column !== undefined && p.value !== undefined) {
        const entry = { column: String(p.column), value: String(p.value) };
        if (p.negate) entry.negate = true;
        filters.push(entry);
      }
    }
  }

  return filters;
}

/**
 * Derives a fallback intent string if INTENT(...) is omitted.
 */
function deriveDefaultIntent(steps) {
  if (!steps.length) return "Spatial analysis plan";
  const ops = steps.map(s => s.op);
  return `Spatial analysis: ${ops.join(" -> ")}`;
}

/**
 * Parses a 1-line DSL plan string into GeoARK's AST object.
 *
 * @param {string} dslString
 * @returns {object} GeoARK Plan AST
 * @throws {DslParseError} on invalid or malformed syntax
 */
function parsePlan(dslString) {
  if (typeof dslString !== "string" || !dslString.trim()) {
    throw new DslParseError("Plan string is empty or invalid");
  }

  const trimmed = dslString.trim();

  // Handle REFUSE(...)
  const refuseMatch = trimmed.match(/^REFUSE(?:\s*\(([\s\S]*)\))?\s*$/i);
  if (refuseMatch) {
    const argsStr = refuseMatch[1] || "";
    const { positional, named } = parseArguments(argsStr);

    let reason = named.reason || positional.find(p => typeof p === "string");
    let missing = named.missing;
    if (positional.find(p => Array.isArray(p))) {
      missing = positional.find(p => Array.isArray(p));
    }

    let intent = "Refusal: requested data unavailable";
    if (reason) {
      intent = String(reason).startsWith("Refusal:") ? String(reason) : `Refusal: ${reason}`;
    }

    return {
      intent,
      output_type: "map",
      entity_type: "COUNTY",
      steps: [],
    };
  }

  // Split into pipe segments
  const rawSegments = splitPipes(trimmed);
  const segments = [];
  for (const seg of rawSegments) {
    const s = seg.trim();
    if (!s) {
      throw new DslParseError("Empty step segment found (consecutive or trailing pipes)");
    }
    segments.push(s);
  }

  if (segments.length === 0) {
    throw new DslParseError("Plan has no steps");
  }

  // Check for INTENT(...) prefix
  let explicitIntent = null;
  const firstSeg = segments[0];
  const intentMatch = firstSeg.match(/^INTENT(?:\s*\(([\s\S]*)\)|\s*:\s*(.*))$/i);
  if (intentMatch) {
    const rawIntent = intentMatch[1] !== undefined ? intentMatch[1] : intentMatch[2];
    const { positional } = parseArguments(rawIntent);
    explicitIntent = positional[0] !== undefined ? String(positional[0]) : rawIntent.trim().replace(/^["']|["']$/g, "");
    segments.shift(); // remove INTENT segment
  }

  if (segments.length === 0) {
    throw new DslParseError("Plan has no steps after INTENT");
  }

  const steps = [];
  const existingIds = new Set();
  let autoIdCounter = 1;

  for (let idx = 0; idx < segments.length; idx++) {
    const segment = segments[idx];

    // Optional step ID prefix: "s1: op(...)"
    let explicitId = null;
    let rest = segment;
    const colonMatch = segment.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (colonMatch) {
      explicitId = colonMatch[1];
      rest = colonMatch[2];
    }

    // Parse op and arguments: "op(args)" or "op"
    const opMatch = rest.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*\(([\s\S]*)\))?$/);
    if (!opMatch) {
      throw new DslParseError(`Malformed step syntax: "${segment}"`);
    }

    const opName = opMatch[1].toLowerCase();
    const argsStr = opMatch[2] || "";

    if (OP_ARITY[opName] === undefined) {
      throw new DslParseError(`Unknown operator "${opName}" in step "${segment}"`);
    }

    // Assign Step ID
    let stepId;
    if (explicitId) {
      if (existingIds.has(explicitId)) {
        throw new DslParseError(`Duplicate step id "${explicitId}"`);
      }
      stepId = explicitId;
    } else {
      while (existingIds.has(`s${autoIdCounter}`)) {
        autoIdCounter++;
      }
      stepId = `s${autoIdCounter}`;
      autoIdCounter++;
    }
    existingIds.add(stepId);

    const { positional, named } = parseArguments(argsStr);
    const arity = OP_ARITY[opName];

    // Build Step
    const step = {
      id: stepId,
      op: opName,
      inputs: [],
      attr_id: "",
    };

    // Wiring inputs
    let explicitInputs = null;
    if (Array.isArray(named.inputs)) {
      explicitInputs = named.inputs.map(String);
    } else if (named.in1 || named.in2) {
      explicitInputs = [named.in1, named.in2].filter(Boolean).map(String);
    }

    switch (opName) {
      case "load": {
        step.attr_id = String(named.attr_id || positional[0] || "");
        const y = named.year !== undefined ? named.year : positional[1];
        if (y !== undefined && y !== null) step.year = parseInt(y, 10);
        step.inputs = [];
        break;
      }

      case "count_features": {
        step.attr_id = String(named.attr_id || positional[0] || "");
        const filters = extractAttributeFilters(named, positional.slice(1));
        if (filters.length > 0) step.attribute_filters = filters;
        step.inputs = [];
        break;
      }

      case "count_near": {
        step.attr_id = String(named.attr_id || positional[0] || "");
        step.near_attr_id = String(named.near_attr_id || positional[1] || "");
        const m = named.miles !== undefined ? named.miles : positional[2];
        if (m !== undefined && m !== null) step.miles = Number(m);
        step.inputs = [];
        break;
      }

      case "nearest_distance": {
        step.attr_id = String(named.attr_id || positional[0] || "");
        step.inputs = [];
        break;
      }

      case "select_features": {
        step.attr_id = String(named.attr_id || positional[0] || "");
        if (named.states || (positional[1] && Array.isArray(positional[1]))) {
          step.states = toStateList(named.states || positional[1]);
        }
        if (named.city) step.city = String(named.city);
        const lim = named.limit !== undefined ? named.limit : positional.find((p, i) => i > 0 && typeof p === "number");
        if (lim !== undefined && lim !== null) step.limit = parseInt(lim, 10);
        const filters = extractAttributeFilters(named, positional.slice(1));
        if (filters.length > 0) step.attribute_filters = filters;
        step.inputs = [];
        break;
      }

      case "zonal": {
        step.attr_id = String(named.attr_id || positional[0] || "");
        const y = named.year !== undefined ? named.year : (typeof positional[1] === "number" && positional[1] >= 1900 ? positional[1] : undefined);
        if (y !== undefined && y !== null) step.year = parseInt(y, 10);
        if (named.operator) step.operator = String(named.operator);
        if (named.value !== undefined && named.value !== null) step.value = Number(named.value);
        // Positional operator and value
        const opTok = positional.find(p => ["<", "<=", ">", ">=", "=", "!="].includes(p));
        if (opTok) step.operator = opTok;
        const valTok = positional.find(p => typeof p === "number" && p !== step.year);
        if (valTok !== undefined && step.value === undefined) step.value = Number(valTok);
        const filters = extractAttributeFilters(named, positional.slice(1));
        if (filters.length > 0) step.attribute_filters = filters;
        step.inputs = [];
        break;
      }

      case "within": {
        let pIdx = 0;
        const inList = [];
        if (isStepRef(positional[0], existingIds)) {
          inList.push(positional[0]);
          pIdx++;
          if (isStepRef(positional[1], existingIds)) {
            inList.push(positional[1]);
            pIdx++;
          }
        }
        if (explicitInputs) step.inputs = explicitInputs;
        else if (inList.length > 0) step.inputs = inList;
        else {
          step.inputs = steps.length >= 2 ? [steps[steps.length - 2].id, steps[steps.length - 1].id] : (steps.length === 1 ? [steps[0].id] : []);
        }
        const m = named.miles !== undefined ? named.miles : positional[pIdx];
        if (m !== undefined && typeof m === "number") {
          step.miles = Number(m);
          pIdx++;
        }
        const ex = named.exclude !== undefined ? named.exclude : positional[pIdx];
        if (ex !== undefined && typeof ex === "boolean") step.exclude = Boolean(ex);
        break;
      }

      case "overlay": {
        let pIdx = 0;
        const inList = [];
        if (isStepRef(positional[0], existingIds)) {
          inList.push(positional[0]);
          pIdx++;
          if (isStepRef(positional[1], existingIds)) {
            inList.push(positional[1]);
            pIdx++;
          }
        }
        if (explicitInputs) step.inputs = explicitInputs;
        else if (inList.length > 0) step.inputs = inList;
        else {
          step.inputs = steps.length >= 2 ? [steps[steps.length - 2].id, steps[steps.length - 1].id] : (steps.length === 1 ? [steps[0].id] : []);
        }
        const ex = named.exclude !== undefined ? named.exclude : positional[pIdx];
        if (ex !== undefined && typeof ex === "boolean") step.exclude = Boolean(ex);
        break;
      }

      case "summarize": {
        let pIdx = 0;
        if (isStepRef(positional[0], existingIds)) {
          step.inputs = [positional[0]];
          pIdx++;
        } else if (explicitInputs) {
          step.inputs = explicitInputs.slice(0, 1);
        } else {
          step.inputs = steps.length > 0 ? [steps[steps.length - 1].id] : [];
        }
        const grp = named.group_by || positional[pIdx];
        if (grp) step.group_by = String(grp).toLowerCase();
        break;
      }

      case "filter_attr": {
        let pIdx = 0;
        if (isStepRef(positional[0], existingIds)) {
          step.inputs = [positional[0]];
          pIdx++;
        } else if (explicitInputs) {
          step.inputs = explicitInputs.slice(0, 1);
        } else {
          step.inputs = steps.length > 0 ? [steps[steps.length - 1].id] : [];
        }

        if (named.operator) step.operator = String(named.operator);
        if (named.value !== undefined && named.value !== null) step.value = Number(named.value);
        if (named.percentile !== undefined && named.percentile !== null) step.percentile = parseInt(named.percentile, 10);
        if (named.definition) step.definition = String(named.definition);

        // Positional operator / value / percentile / definition
        for (let j = pIdx; j < positional.length; j++) {
          const p = positional[j];
          if (["<", "<=", ">", ">=", "=", "!="].includes(p)) {
            step.operator = p;
          } else if (typeof p === "number") {
            if (step.value === undefined && step.percentile === undefined) {
              step.value = p;
            }
          } else if (typeof p === "string" && /^d\d+$/i.test(p)) {
            step.definition = p;
          }
        }
        break;
      }

      case "filter_area": {
        let pIdx = 0;
        if (isStepRef(positional[0], existingIds)) {
          step.inputs = [positional[0]];
          pIdx++;
        } else if (explicitInputs) {
          step.inputs = explicitInputs.slice(0, 1);
        } else {
          step.inputs = steps.length > 0 ? [steps[steps.length - 1].id] : [];
        }
        const rawStates = named.states !== undefined ? named.states : positional[pIdx];
        step.states = toStateList(rawStates);
        break;
      }

      case "filter_place": {
        let pIdx = 0;
        if (isStepRef(positional[0], existingIds)) {
          step.inputs = [positional[0]];
          pIdx++;
        } else if (explicitInputs) {
          step.inputs = explicitInputs.slice(0, 1);
        } else {
          step.inputs = steps.length > 0 ? [steps[steps.length - 1].id] : [];
        }

        const kind = named.place_kind || positional[pIdx];
        if (kind) {
          step.place_kind = String(kind).toLowerCase();
          pIdx++;
        }
        const name = named.place_name || positional[pIdx];
        if (name !== undefined && name !== null) {
          step.place_name = String(name);
          pIdx++;
        }
        const st = named.states !== undefined ? named.states : positional[pIdx];
        if (st) step.states = toStateList(st);
        break;
      }

      case "per_area": {
        if (isStepRef(positional[0], existingIds)) {
          step.inputs = [positional[0]];
        } else if (explicitInputs) {
          step.inputs = explicitInputs.slice(0, 1);
        } else {
          step.inputs = steps.length > 0 ? [steps[steps.length - 1].id] : [];
        }
        break;
      }

      case "normalize": {
        let pIdx = 0;
        const inList = [];
        if (isStepRef(positional[0], existingIds)) {
          inList.push(positional[0]);
          pIdx++;
          if (isStepRef(positional[1], existingIds)) {
            inList.push(positional[1]);
            pIdx++;
          }
        }
        if (explicitInputs) step.inputs = explicitInputs;
        else if (inList.length > 0) step.inputs = inList;
        else {
          step.inputs = steps.length >= 2 ? [steps[steps.length - 2].id, steps[steps.length - 1].id] : (steps.length === 1 ? [steps[0].id] : []);
        }
        const sc = named.scale !== undefined ? named.scale : positional[pIdx];
        if (sc !== undefined && sc !== null) step.scale = Number(sc);
        break;
      }

      case "aggregate": {
        let pIdx = 0;
        if (isStepRef(positional[0], existingIds)) {
          step.inputs = [positional[0]];
          pIdx++;
        } else if (explicitInputs) {
          step.inputs = explicitInputs.slice(0, 1);
        } else {
          step.inputs = steps.length > 0 ? [steps[steps.length - 1].id] : [];
        }
        const fn = named.function || positional[pIdx];
        if (fn) {
          step.function = String(fn).toLowerCase();
          pIdx++;
        }
        const grp = named.group_by || positional[pIdx];
        if (grp) step.group_by = String(grp).toLowerCase();
        break;
      }

      case "rank": {
        let pIdx = 0;
        if (isStepRef(positional[0], existingIds)) {
          step.inputs = [positional[0]];
          pIdx++;
        } else if (explicitInputs) {
          step.inputs = explicitInputs.slice(0, 1);
        } else {
          step.inputs = steps.length > 0 ? [steps[steps.length - 1].id] : [];
        }

        const dir = named.direction || (["asc", "desc"].includes(String(positional[pIdx]).toLowerCase()) ? positional[pIdx] : undefined);
        if (dir) {
          step.direction = String(dir).toLowerCase();
          pIdx++;
        }
        const lim = named.limit !== undefined ? named.limit : (typeof positional[pIdx] === "number" ? positional[pIdx] : undefined);
        if (lim !== undefined && lim !== null) step.limit = parseInt(lim, 10);
        break;
      }

      case "join":
      case "correlate":
      case "compare_groups":
      case "residual": {
        let pIdx = 0;
        const inList = [];
        if (isStepRef(positional[0], existingIds)) {
          inList.push(positional[0]);
          pIdx++;
          if (isStepRef(positional[1], existingIds)) {
            inList.push(positional[1]);
            pIdx++;
          }
        }
        if (explicitInputs) step.inputs = explicitInputs;
        else if (inList.length > 0) step.inputs = inList;
        else {
          step.inputs = steps.length >= 2 ? [steps[steps.length - 2].id, steps[steps.length - 1].id] : (steps.length === 1 ? [steps[0].id] : []);
        }
        break;
      }

      case "combine": {
        let pIdx = 0;
        const inList = [];
        if (isStepRef(positional[0], existingIds)) {
          inList.push(positional[0]);
          pIdx++;
          if (isStepRef(positional[1], existingIds)) {
            inList.push(positional[1]);
            pIdx++;
          }
        }
        if (explicitInputs) step.inputs = explicitInputs;
        else if (inList.length > 0) step.inputs = inList;
        else {
          step.inputs = steps.length >= 2 ? [steps[steps.length - 2].id, steps[steps.length - 1].id] : (steps.length === 1 ? [steps[0].id] : []);
        }

        const opVal = named.operation || positional[pIdx];
        if (opVal) {
          step.operation = String(opVal).toLowerCase();
          pIdx++;
        }
        const sc = named.scale !== undefined ? named.scale : positional[pIdx];
        if (sc !== undefined && sc !== null) step.scale = Number(sc);
        break;
      }

      case "hotspot":
      case "outlier":
      case "explain": {
        if (isStepRef(positional[0], existingIds)) {
          step.inputs = [positional[0]];
        } else if (explicitInputs) {
          step.inputs = explicitInputs.slice(0, 1);
        } else {
          step.inputs = steps.length > 0 ? [steps[steps.length - 1].id] : [];
        }
        break;
      }

      case "intersect": {
        let pIdx = 0;
        const inList = [];
        if (isStepRef(positional[0], existingIds)) {
          inList.push(positional[0]);
          pIdx++;
          if (isStepRef(positional[1], existingIds)) {
            inList.push(positional[1]);
            pIdx++;
          }
        }
        if (explicitInputs) step.inputs = explicitInputs;
        else if (inList.length > 0) step.inputs = inList;
        else {
          step.inputs = steps.length >= 2 ? [steps[steps.length - 2].id, steps[steps.length - 1].id] : (steps.length === 1 ? [steps[0].id] : []);
        }
        const ex = named.exclude !== undefined ? named.exclude : positional[pIdx];
        if (ex !== undefined && typeof ex === "boolean") step.exclude = Boolean(ex);
        break;
      }

      case "neighbors": {
        let pIdx = 0;
        if (isStepRef(positional[0], existingIds)) {
          step.inputs = [positional[0]];
          pIdx++;
        } else if (explicitInputs) {
          step.inputs = explicitInputs.slice(0, 1);
        } else {
          step.inputs = steps.length > 0 ? [steps[steps.length - 1].id] : [];
        }
        const opVal = named.operation || positional[pIdx];
        if (opVal) step.operation = String(opVal).toLowerCase();
        break;
      }

      case "access": {
        let pIdx = 0;
        if (isStepRef(positional[0], existingIds)) {
          step.inputs = [positional[0]];
          pIdx++;
        } else if (explicitInputs) {
          step.inputs = explicitInputs.slice(0, 1);
        } else {
          step.inputs = steps.length > 0 ? [steps[steps.length - 1].id] : [];
        }

        step.attr_id = String(named.attr_id || positional[pIdx] || "");
        if (positional[pIdx] !== undefined) pIdx++;

        const m = named.miles !== undefined ? named.miles : positional[pIdx];
        if (m !== undefined && m !== null) step.miles = Number(m);
        break;
      }

      case "output": {
        if (isStepRef(positional[0], existingIds)) {
          step.inputs = [positional[0]];
        } else if (explicitInputs) {
          step.inputs = explicitInputs.slice(0, 1);
        } else {
          step.inputs = steps.length > 0 ? [steps[steps.length - 1].id] : [];
        }
        break;
      }
    }

    // Ensure invariants: attr_id string and inputs array
    if (!ATTR_OPS.has(step.op)) {
      step.attr_id = "";
    } else if (typeof step.attr_id !== "string") {
      step.attr_id = "";
    }

    if (!Array.isArray(step.inputs)) {
      step.inputs = [];
    }

    steps.push(step);
  }

  // Derive root AST properties
  const hasStatsOp = steps.some(s => s.op === "correlate" || s.op === "explain");
  const output_type = hasStatsOp ? "statistics" : "map";
  const intent = explicitIntent || deriveDefaultIntent(steps);

  return {
    intent,
    output_type,
    entity_type: "COUNTY",
    steps,
  };
}

module.exports = {
  parsePlan,
  DslParseError,
};
