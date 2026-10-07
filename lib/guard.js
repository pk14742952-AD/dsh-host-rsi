// DSH host RSI — L3 delivery guard.
//
// Ported from the five-state classifier in D:\ninfer\04-卡死与循环的防治.md
// and D:\ninfer\05-防止雷霆大思考实施方案.md. It runs on the host side after
// an assistant turn and detects EMPTY / TRUNCATED / FIXED_POINT / SAME_PLAN /
// SHELL_LOOP so the plugin can correct the model before the bad answer is used.

export const OK = "OK";
export const GUARD_STATES = ["EMPTY", "TRUNCATED", "FIXED_POINT", "SAME_PLAN", "SHELL_LOOP"];

export function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

export function isFileTurn(task, re) {
  if (!re) return false;
  try {
    return new RegExp(re, "i").test(String(task || ""));
  } catch {
    return false;
  }
}

export function extractPlanLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => /^\s*(OPT:|NEXT:|下一步[:：]|STATUS:)/i.test(line))
    .map((line) => line.trim().toLowerCase());
}

export function codeFenceCount(text) {
  const matches = String(text || "").match(/```/g);
  return matches ? matches.length : 0;
}

export function svgUnclosed(text) {
  const t = String(text || "");
  const open = (t.match(/<svg\b/gi) || []).length;
  const close = (t.match(/<\/svg>/gi) || []).length;
  return open > close;
}

/**
 * Five-state delivery classification. Returns { state, reason }.
 * @param {object} p
 * @param {string} [p.answerText]
 * @param {string} [p.prevAnswerText]
 * @param {Array}  [p.toolCalls]
 * @param {string} [p.finishReason]
 * @param {boolean} [p.fileTurn]
 * @param {number} [p.thresholdEmpty]
 * @param {number} [p.thresholdFile]
 * @param {number} [p.sameToolStreak]
 */
export function classifyLoop(p = {}) {
  const text = String(p.answerText || "").trim();
  const normalized = normalizeText(text);
  const prev = normalizeText(p.prevAnswerText);
  const thresholdEmpty = p.thresholdEmpty ?? 400;
  const thresholdFile = p.thresholdFile ?? 2000;
  const sameToolStreak = p.sameToolStreak ?? 3;
  const names = (Array.isArray(p.toolCalls) ? p.toolCalls : [])
    .map((t) => (typeof t === "string" ? t : String(t?.name || t?.toolName || "")))
    .filter(Boolean)
    .map((n) => n.toLowerCase());
  // Tool-backed turns often deliver to disk and finish with a short summary, so the
  // text-length gates only apply when the model was expected to write the deliverable
  // inline (no tools ran). Empty / truncated / repeated outputs still always fail.
  const ranTools = p.ranTools ?? names.length > 0;

  if (!text && names.length >= sameToolStreak) {
    const last = names.slice(-sameToolStreak);
    if (last.every((n) => n === last[0])) {
      return { state: "SHELL_LOOP", reason: `assistant made only tool calls (${last[0]} x${sameToolStreak}) with no text` };
    }
  }
  if (String(p.finishReason || "").toLowerCase() === "length") {
    return { state: "TRUNCATED", reason: "finish_reason=length" };
  }
  if (codeFenceCount(text) % 2 === 1) {
    return { state: "TRUNCATED", reason: "unbalanced code fence" };
  }
  if (svgUnclosed(text)) {
    return { state: "TRUNCATED", reason: "<svg> without </svg>" };
  }
  if (!text) {
    return { state: "EMPTY", reason: "empty answer" };
  }
  if (!ranTools && p.fileTurn && text.length < thresholdFile) {
    return { state: "EMPTY", reason: `file turn delivered ${text.length} chars (< ${thresholdFile})` };
  }
  if (!ranTools && text.length < thresholdEmpty) {
    return { state: "EMPTY", reason: `${text.length} chars (< ${thresholdEmpty})` };
  }
  if (prev && normalized === prev) {
    return { state: "FIXED_POINT", reason: "identical to previous answer" };
  }
  const plan = extractPlanLines(text).join("\n");
  const prevPlan = extractPlanLines(p.prevAnswerText).join("\n");
  if (plan && prevPlan && plan === prevPlan) {
    return { state: "SAME_PLAN", reason: "same plan lines as previous answer" };
  }
  return { state: OK, reason: null };
}

const STATE_LABELS = {
  EMPTY: "没有交付物 / 正文过短",
  TRUNCATED: "产物写了一半，缺少闭合结束标签",
  FIXED_POINT: "与上一轮逐字相同",
  SAME_PLAN: "只给了相同的计划，没有新进展",
  SHELL_LOOP: "只调工具没有给出正文",
};

export function guardCorrectionPrompt(task, state, rejectedAnswer) {
  const label = STATE_LABELS[state] || state;
  return [
    `[rsi-guard] Delivery check did not pass for the current turn: ${state}.`,
    `${label}.`,
    "Now do exactly one thing: immediately output the complete and closed deliverable; if space is limited, make it compact but it must be complete and closed.",
    "Do not only write a plan, do not write \"same as above\", do not repeat the previous wording. If the previous approach is already complete, choose a different concrete point and finish.",
    "",
    "TASK:",
    String(task ?? ""),
    "",
    "REJECTED ANSWER:",
    String(rejectedAnswer ?? ""),
  ].join("\n");
}
