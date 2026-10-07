// DSH host RSI — coding-loop convergence rules.
//
// Ported from D:\bonsia\dsh-bonsai-fast (itself a DSH port of
// pi-extension-convergence). Kept pure so the state machine is unit-testable
// without the host: detect repeated passing tests / business API checks and
// steer the agent to converge instead of over-verifying.

export const STRONG_STEER =
  "The required validation has already passed and no source code has changed since then. " +
  "Do not perform additional verification. Review the explicit task requirements once, " +
  "provide the final result, and end the task.";

export const SOFT_STEER =
  "You have repeated the same successful validation without source changes. " +
  "Do not run the same check again. If all explicit requirements are satisfied, " +
  "finish the task now. Otherwise continue only with the remaining unmet requirements.";

export const POLICY_TEXT = `TASK COMPLETION POLICY

Focus only on the explicit requirements of the task.

When all requested requirements are satisfied and the relevant tests pass:

1. Consider the task complete.
2. Do not repeat an already-passing test unless the source code changed afterward.
3. Do not add optional refactoring, extra tests, or unrelated improvements.
4. Do not continue investigating hypothetical problems without new evidence.
5. Give the final result and end the task immediately.

A passing validation with no new errors is sufficient evidence of completion.

Keep each turn's output, including thinking, within 8000 tokens.`;

const SOURCE_TOOLS = new Set(["edit", "write"]);
const SHELL_TOOLS = new Set(["pwsh", "bash", "powershell"]);

export function createState() {
  return {
    steered: false,
    passedFamilies: new Set(),
    fingerprintCounts: new Map(),
    consecutivePassCount: 0,
    lastPassedFingerprint: null,
  };
}

export function resetState(state) {
  state.steered = false;
  state.passedFamilies.clear();
  state.fingerprintCounts.clear();
  state.consecutivePassCount = 0;
  state.lastPassedFingerprint = null;
}

export function isSourceEdit(toolName) {
  return SOURCE_TOOLS.has(toolName);
}

export function isShellTool(toolName) {
  return SHELL_TOOLS.has(toolName);
}

export function commandOf(args) {
  if (typeof args === "object" && args !== null && typeof args.command === "string") return args.command;
  return "";
}

export function resultText(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("\n");
}

/**
 * Coerce a config `models` value into a normalized target list.
 * Absent / null means "all models" (legacy behavior); an empty array is also all.
 * @param {unknown} models
 * @returns {string[]}
 */
export function normalizeModels(models) {
  if (models === undefined || models === null) return [];
  const list = Array.isArray(models) ? models : [models];
  const out = [];
  for (const entry of list) {
    if (typeof entry === "string" && entry.trim() !== "") out.push(entry.trim());
  }
  return out;
}

/**
 * Whether the guard is active for one session model.
 * An empty target list is active for every model (including unknown ones).
 * A non-empty list fails closed. Matching is case-insensitive; targets may use `*`.
 */
export function isModelActive(model, models) {
  if (models.length === 0) return true;
  if (typeof model !== "string" || model.trim() === "") return false;
  const m = model.trim().toLowerCase();
  return models.some((target) => {
    const t = target.trim().toLowerCase();
    if (!t.includes("*")) return t === m;
    const pattern = `^${t.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`;
    return new RegExp(pattern, "i").test(m);
  });
}

/** @returns {{ family: string, fingerprint: string } | null} */
export function classifyCheck(command) {
  const c = command.toLowerCase();
  if (c.includes("pytest") || c.includes("python -m pytest") || c.includes("python -m unittest")) {
    const match = command.match(/tests\/[a-zA-Z0-9_\-.]+/i);
    return { family: "test", fingerprint: `pytest:${match ? match[0] : "all"}` };
  }
  if (c.includes("npm test") || c.includes("npm run test") || c.includes("node --test")) {
    const match = command.match(/dist\/tests\/[a-zA-Z0-9_\-.]+/i) || command.match(/tests\/[a-zA-Z0-9_\-.]+/i);
    return { family: "test", fingerprint: `npm_test:${match ? match[0] : "default"}` };
  }
  if (c.includes("npm run build") || c.includes("tsc ") || c.endsWith("tsc")) {
    return { family: "build", fingerprint: "build:tsc" };
  }
  if (c.includes("curl")) {
    if (c.includes("/health") && !c.includes("/api/")) return null;
    const match = command.match(/(\/api\/[a-zA-Z0-9_\-\/]+)/i);
    if (match) return { family: "runtime", fingerprint: `curl:${match[1]}` };
    const urlMatch = command.match(/https?:\/\/[^\s\/]+(\/api\/[^\s?"']*)/i);
    if (urlMatch) return { family: "runtime", fingerprint: `curl:${urlMatch[1]}` };
  }
  return null;
}

export function looksPassed(text, family) {
  const t = text.toLowerCase();
  if (
    t.includes("error:") ||
    t.includes("err_assertion") ||
    t.includes("assertionerror") ||
    t.includes("failed") ||
    t.includes("fail 1") ||
    t.includes("fail 2") ||
    t.includes("not ok ") ||
    (t.includes("403 forbidden") && !t.includes("200 ok")) ||
    t.includes("500 internal") ||
    t.includes("404 not found")
  ) return false;
  if (family === "test") {
    return /\b\d+\s+passed\b/.test(t) || t.includes("✔") || t.includes("ℹ pass") || /\bpass\b/.test(t) || t.includes("passed in");
  }
  if (family === "build") return t.includes("build succeeded") || t.includes("build success") || !t.includes("error ts");
  if (family === "runtime") {
    return t.includes("200 ok") || t.includes("http/1.1 200") || t.includes("http/1.0 200") || t.includes('"status":"ok"') || t.includes('"status": "ok"') || /\b200\b/.test(t);
  }
  return false;
}

/**
 * Record one shell result. Returns steer text once, then null until reset.
 * @param {ReturnType<typeof createState>} state
 */
export function observeShell(state, command, text, repeatThreshold) {
  const check = classifyCheck(command);
  if (!check) return null;
  if (!looksPassed(text, check.family)) return null;
  state.passedFamilies.add(check.family);
  const currentCount = (state.fingerprintCounts.get(check.fingerprint) || 0) + 1;
  state.fingerprintCounts.set(check.fingerprint, currentCount);
  if (state.lastPassedFingerprint === check.fingerprint) state.consecutivePassCount += 1;
  else {
    state.consecutivePassCount = 1;
    state.lastPassedFingerprint = check.fingerprint;
  }
  if (state.steered) return null;
  if (state.passedFamilies.size >= 2) {
    state.steered = true;
    return STRONG_STEER;
  }
  if (currentCount >= repeatThreshold || state.consecutivePassCount >= repeatThreshold) {
    state.steered = true;
    return SOFT_STEER;
  }
  return null;
}
