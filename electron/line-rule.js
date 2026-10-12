"use strict";

// Languages where a newline can end a statement (ASI / implicit separators).
const NEWLINE_DELIMITER_EXTS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".pyw",
  ".go",
  ".rb",
  ".lua",
  ".kt",
  ".kts",
  ".scala",
  ".swift",
  ".sh",
  ".bash",
]);

function allowsNewlineDelimiter(ext) {
  return NEWLINE_DELIMITER_EXTS.has(String(ext || "").toLowerCase());
}

function lineFragmentOk(full, start, end) {
  const text = String(full || "");
  const from = Math.max(0, Number(start) || 0);
  const to = Math.max(from, Number(end) || 0);
  if (to <= from) return true;
  const sigEnd = text.trimEnd().length;
  if (sigEnd === 0) return true;
  if (to >= sigEnd) return true;
  const selected = text.slice(from, to);
  return /;\s*$/.test(selected);
}

function highlightLineRuleOk(ext, lines) {
  if (!allowsNewlineDelimiter(ext)) return true;
  return Array.isArray(lines) && lines.length > 0 && lines.every((line) => lineFragmentOk(line.full, line.start, line.end));
}

module.exports = {
  NEWLINE_DELIMITER_EXTS,
  allowsNewlineDelimiter,
  lineFragmentOk,
  highlightLineRuleOk,
};
