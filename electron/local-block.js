"use strict";

const BRACE_EXTS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
  ".hh",
  ".cs",
  ".go",
  ".rs",
  ".php",
  ".kt",
  ".kts",
  ".scala",
  ".swift",
  ".dart",
  ".css",
]);

const TEMPLATE_EXTS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"]);
const INDENT_EXTS = new Set([".py", ".pyw"]);

function offsetAt(text, line, column) {
  let row = 1;
  let col = 1;
  let i = 0;
  const targetLine = line || 1;
  const targetCol = column || 1;
  while (i < text.length && (row < targetLine || (row === targetLine && col < targetCol))) {
    if (text[i] === "\n") {
      row += 1;
      col = 1;
    } else {
      col += 1;
    }
    i += 1;
  }
  return i;
}

function pointAt(text, index) {
  let row = 0;
  let column = 0;
  const stop = Math.max(0, Math.min(index, text.length));
  for (let i = 0; i < stop; i += 1) {
    if (text[i] === "\n") {
      row += 1;
      column = 0;
    } else {
      column += 1;
    }
  }
  return { row, column };
}

function monacoRangeFromOffsets(text, start, end) {
  const from = pointAt(text, start);
  const to = pointAt(text, end);
  return {
    startLine: from.row + 1,
    startColumn: from.column + 1,
    endLine: to.row + 1,
    endColumn: to.column + 1,
  };
}

function selectionOffsets(text, range, snippet) {
  if (range && range.startLine != null) {
    const start = offsetAt(text, range.startLine, range.startColumn || 1);
    const end = offsetAt(text, range.endLine || range.startLine, range.endColumn || 1);
    if (end >= start) return { start, end };
  }
  const needle = String(snippet || "").trim();
  if (!needle) return null;
  const start = text.indexOf(needle);
  if (start < 0) return null;
  return { start, end: start + needle.length };
}

function stringSpans(text, templates) {
  const spans = [];
  const modes = ["code"];
  const interp = [];
  let openAt = -1;
  let i = 0;

  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    const mode = modes[modes.length - 1];

    if (mode === "code") {
      if (c === "/" && next === "/") {
        modes.push("line");
        i += 2;
        continue;
      }
      if (c === "/" && next === "*") {
        modes.push("block");
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === "`") {
        modes.push(c === "'" ? "sq" : c === '"' ? "dq" : templates ? "tpl" : "raw");
        openAt = i;
        i += 1;
        continue;
      }
      if (c === "}" && interp.length && interp[interp.length - 1] === modes.length) {
        interp.pop();
        modes.pop();
        openAt = i + 1;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    if (mode === "line") {
      if (c === "\n") modes.pop();
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && next === "/") {
        modes.pop();
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (mode === "sq" || mode === "dq" || mode === "raw") {
      if (c === "\\" && mode !== "raw") {
        i += 2;
        continue;
      }
      const end = mode === "sq" ? "'" : mode === "dq" ? '"' : "`";
      if (c === end) {
        spans.push({ start: openAt, end: i + 1 });
        modes.pop();
        openAt = -1;
      }
      i += 1;
      continue;
    }
    if (mode === "tpl") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        spans.push({ start: openAt, end: i + 1 });
        modes.pop();
        openAt = -1;
        i += 1;
        continue;
      }
      if (c === "$" && next === "{") {
        if (i > openAt) spans.push({ start: openAt, end: i });
        modes.push("code");
        interp.push(modes.length);
        openAt = -1;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  if (openAt >= 0) spans.push({ start: openAt, end: text.length });
  return spans;
}

function selectionInString(ext, fileText, range, snippet) {
  const text = String(fileText || "");
  if (!text) return false;
  const sel = selectionOffsets(text, range, snippet);
  if (!sel || sel.end <= sel.start) return false;
  const templates = TEMPLATE_EXTS.has(String(ext || "").toLowerCase());
  const spans = stringSpans(text, templates);
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    if (sel.start >= span.start && sel.end <= span.end) return true;
  }
  return false;
}

function scanBracePairs(text, templates) {
  const pairs = [];
  const braces = [];
  const modes = ["code"];
  let i = 0;

  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    const mode = modes[modes.length - 1];

    if (mode === "code") {
      if (c === "/" && next === "/") {
        modes.push("line");
        i += 2;
        continue;
      }
      if (c === "/" && next === "*") {
        modes.push("block");
        i += 2;
        continue;
      }
      if (c === "'") {
        modes.push("sq");
        i += 1;
        continue;
      }
      if (c === '"') {
        modes.push("dq");
        i += 1;
        continue;
      }
      if (c === "`") {
        modes.push(templates ? "tpl" : "raw");
        i += 1;
        continue;
      }
      if (c === "{") {
        braces.push(i);
        i += 1;
        continue;
      }
      if (c === "}") {
        const top = braces[braces.length - 1];
        if (top && typeof top === "object" && top.interp) {
          braces.pop();
          modes.pop();
        } else if (typeof top === "number") {
          braces.pop();
          pairs.push({ open: top, close: i });
        }
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    if (mode === "line") {
      if (c === "\n") modes.pop();
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && next === "/") {
        modes.pop();
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (mode === "sq" || mode === "dq" || mode === "raw") {
      if (c === "\\" && mode !== "raw") {
        i += 2;
        continue;
      }
      const end = mode === "sq" ? "'" : mode === "dq" ? '"' : "`";
      if (c === end) modes.pop();
      i += 1;
      continue;
    }
    if (mode === "tpl") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        modes.pop();
        i += 1;
        continue;
      }
      if (c === "$" && next === "{") {
        braces.push({ interp: true });
        modes.push("code");
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return pairs;
}

function tightestPair(pairs, sel) {
  let best = null;
  for (const pair of pairs) {
    if (pair.open < sel.start && pair.close >= sel.end - 1) {
      if (!best || pair.close - pair.open < best.close - best.open) best = pair;
    }
  }
  return best;
}

function blockFromOffsets(text, start, end, sel) {
  const slice = text.slice(start, end);
  return {
    text: slice,
    origin: pointAt(text, start),
    localRange: monacoRangeFromOffsets(slice, sel.start - start, sel.end - start),
  };
}

function braceBlock(text, sel, ext) {
  const pairs = scanBracePairs(text, TEMPLATE_EXTS.has(ext));
  const pair = tightestPair(pairs, sel);
  if (!pair) return null;
  return blockFromOffsets(text, pair.open, pair.close + 1, sel);
}

function lineTable(text) {
  const lines = text.split("\n");
  const starts = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return { lines, starts };
}

function lineNoAt(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function indentWidth(line) {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0].length : 0;
}

function isBlank(line) {
  return line.trim() === "";
}

function isComment(line) {
  return /^\s*#/.test(line);
}

function endsWithColon(line) {
  return line.replace(/#.*$/, "").trimEnd().endsWith(":");
}

function headerAbove(lines, fromLine) {
  const width = indentWidth(lines[fromLine]);
  for (let i = fromLine - 1; i >= 0; i -= 1) {
    if (isBlank(lines[i]) || isComment(lines[i])) continue;
    if (indentWidth(lines[i]) < width && endsWithColon(lines[i])) return i;
  }
  return -1;
}

function suiteEnd(lines, header) {
  const width = indentWidth(lines[header]);
  let last = header;
  for (let i = header + 1; i < lines.length; i += 1) {
    if (isBlank(lines[i])) {
      last = i;
      continue;
    }
    if (indentWidth(lines[i]) <= width) break;
    last = i;
  }
  return last;
}

function indentBlock(text, sel) {
  const { lines, starts } = lineTable(text);
  let from = lineNoAt(starts, sel.start);
  const endLine = lineNoAt(starts, Math.max(sel.start, sel.end - 1));
  while (from <= endLine && (isBlank(lines[from]) || isComment(lines[from]))) {
    from += 1;
  }
  if (from >= lines.length) return null;

  while (from > 0) {
    const header = headerAbove(lines, from);
    if (header < 0) return null;
    const last = suiteEnd(lines, header);
    const start = starts[header];
    const end = starts[last] + lines[last].length;
    if (start <= sel.start && end >= sel.end) {
      return blockFromOffsets(text, start, end, sel);
    }
    from = header;
  }
  return null;
}

const NON_FUNCTION_WORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "with",
  "do",
  "try",
  "else",
  "finally",
]);

function readWordEndingAt(text, index) {
  if (index < 0 || !/[A-Za-z0-9_$]/.test(text[index])) return "";
  let start = index;
  while (start > 0 && /[A-Za-z0-9_$]/.test(text[start - 1])) start -= 1;
  return text.slice(start, index + 1);
}

function keywordBeforeBrace(text, openIndex) {
  let i = openIndex - 1;
  while (i >= 0 && /\s/.test(text[i])) i -= 1;
  if (i < 0) return "";
  if (text[i] === ">" && text[i - 1] === "=") return "=>";
  if (text[i] !== ")") return readWordEndingAt(text, i);
  let depth = 1;
  i -= 1;
  while (i >= 0 && depth > 0) {
    if (text[i] === ")") depth += 1;
    else if (text[i] === "(") depth -= 1;
    i -= 1;
  }
  while (i >= 0 && /\s/.test(text[i])) i -= 1;
  return readWordEndingAt(text, i);
}

function isFunctionBrace(text, openIndex) {
  const keyword = keywordBeforeBrace(text, openIndex);
  if (keyword === "=>") return true;
  if (!keyword || NON_FUNCTION_WORDS.has(keyword)) return false;
  return true;
}

function functionScopedBlock(text, sel, ext) {
  const pairs = scanBracePairs(text, TEMPLATE_EXTS.has(ext));
  const enclosing = pairs
    .filter((pair) => pair.open < sel.start && pair.close >= sel.end - 1)
    .sort((a, b) => a.close - a.open - (b.close - b.open));
  for (const pair of enclosing) {
    if (isFunctionBrace(text, pair.open)) {
      return blockFromOffsets(text, pair.open, pair.close + 1, sel);
    }
  }
  return blockFromOffsets(text, 0, text.length, sel);
}

const JS_EXTS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"]);

function isJsVarSnippet(ext, snippet) {
  return (
    JS_EXTS.has(String(ext || "").toLowerCase()) &&
    /^(?:export\s+)?var\b/.test(String(snippet || "").trim())
  );
}

function smallestEnclosingBlock(ext, fileText, range, snippet) {
  const text = String(fileText || "");
  if (!text) return null;
  const sel = selectionOffsets(text, range, snippet);
  if (!sel || sel.end <= sel.start) return null;
  const normalized = String(ext || "").toLowerCase();
  if (isJsVarSnippet(normalized, snippet) && BRACE_EXTS.has(normalized)) {
    return functionScopedBlock(text, sel, normalized);
  }
  if (INDENT_EXTS.has(normalized)) return indentBlock(text, sel);
  if (BRACE_EXTS.has(normalized)) return braceBlock(text, sel, normalized);
  return null;
}


module.exports = {
  smallestEnclosingBlock,
  scanBracePairs,
  selectionOffsets,
  selectionInString,
};
