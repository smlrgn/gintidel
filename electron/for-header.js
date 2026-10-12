"use strict";

const { selectionOffsets } = require("./local-block");

const PAREN_FOR_EXTS = new Set([
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
  ".php",
  ".kt",
  ".kts",
  ".dart",
  ".scala",
]);

const BLOCK_FOR_EXTS = new Set([".go", ".rs", ".swift"]);
const COLON_FOR_EXTS = new Set([".py", ".pyw"]);
const JS_EXTS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"]);

function isWordChar(ch) {
  return !!ch && /[A-Za-z0-9_$]/.test(ch);
}

function isKeywordAt(text, index, word) {
  if (!text.startsWith(word, index)) return false;
  const before = index > 0 ? text[index - 1] : "";
  const after = text[index + word.length] || "";
  return !isWordChar(before) && !isWordChar(after);
}

function lexOptions(ext) {
  if (COLON_FOR_EXTS.has(ext) || ext === ".rb" || ext === ".sh" || ext === ".bash") {
    return { hashComment: true, slashComment: false };
  }
  if (ext === ".lua") {
    return { hashComment: false, slashComment: false, luaComment: true };
  }
  return {
    hashComment: false,
    slashComment: true,
    allowAwait: JS_EXTS.has(ext),
    scalaBrace: ext === ".scala",
    foreach: ext === ".php",
  };
}

function forHeaderStyle(ext) {
  if (PAREN_FOR_EXTS.has(ext)) return "paren";
  if (BLOCK_FOR_EXTS.has(ext)) return "block";
  if (COLON_FOR_EXTS.has(ext)) return "colon";
  if (ext === ".lua") return "lua";
  if (ext === ".rb") return "ruby";
  if (ext === ".sh" || ext === ".bash") return "bash";
  return "";
}

// Walk characters from `start`, skipping comments.
// `visit(index)` returns true to stop. Returns that index, or -1.
function scanFrom(text, start, options, visit) {
  const modes = ["code"];
  let i = start;

  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    const mode = modes[modes.length - 1];

    if (mode === "code") {
      if (options.slashComment !== false && c === "/" && next === "/") {
        modes.push("line");
        i += 2;
        continue;
      }
      if (options.slashComment !== false && c === "/" && next === "*") {
        modes.push("block");
        i += 2;
        continue;
      }
      if (options.hashComment && c === "#") {
        modes.push("line");
        i += 1;
        continue;
      }
      if (options.luaComment && c === "-" && next === "-") {
        if (text[i + 2] === "[" && text[i + 3] === "[") {
          modes.push("lua-long");
          i += 4;
          continue;
        }
        modes.push("line");
        i += 2;
        continue;
      }
      if (visit(i)) return i;
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
    if (mode === "lua-long") {
      if (c === "]" && next === "]") {
        modes.pop();
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return -1;
}

function skipTrivia(text, start, options) {
  let found = -1;
  scanFrom(text, start, options, (index) => {
    if (/\s/.test(text[index])) return false;
    found = index;
    return true;
  });
  return found < 0 ? text.length : found;
}

function matchDelimiter(text, openIndex, openChar, closeChar, options) {
  let depth = 0;
  return scanFrom(text, openIndex, options, (index) => {
    const c = text[index];
    if (c === openChar) depth += 1;
    else if (c === closeChar) {
      depth -= 1;
      if (depth === 0) return true;
    }
    return false;
  });
}

function findHeaderEnd(text, start, options, pred) {
  const depth = { paren: 0, bracket: 0, brace: 0 };
  return scanFrom(text, start, options, (index) => {
    const c = text[index];
    if (pred(c, depth, index)) return true;
    if (c === "(") depth.paren += 1;
    else if (c === ")" && depth.paren) depth.paren -= 1;
    else if (c === "[") depth.bracket += 1;
    else if (c === "]" && depth.bracket) depth.bracket -= 1;
    else if (c === "{") depth.brace += 1;
    else if (c === "}" && depth.brace) depth.brace -= 1;
    return false;
  });
}

function headerSpan(text, keywordEnd, style, options) {
  let i = skipTrivia(text, keywordEnd, options);
  if (options.allowAwait && isKeywordAt(text, i, "await")) {
    i = skipTrivia(text, i + "await".length, options);
  }
  if (text[i] === "(") {
    const close = matchDelimiter(text, i, "(", ")", options);
    if (close < 0) return null;
    return { start: i + 1, end: close };
  }
  if (style === "paren" && options.scalaBrace && text[i] === "{") {
    const close = matchDelimiter(text, i, "{", "}", options);
    if (close < 0) return null;
    return { start: i + 1, end: close };
  }
  if (style === "paren") return null;

  if (style === "colon") {
    const end = findHeaderEnd(
      text,
      i,
      options,
      (c, depth) => c === ":" && !depth.paren && !depth.bracket && !depth.brace
    );
    if (end < 0) return null;
    return { start: keywordEnd, end };
  }
  if (style === "block") {
    const end = findHeaderEnd(
      text,
      i,
      options,
      (c, depth) => c === "{" && !depth.paren && !depth.bracket && !depth.brace
    );
    if (end < 0) return null;
    return { start: keywordEnd, end };
  }
  const end = findHeaderEnd(text, i, options, (c, depth, index) => {
    if (depth.paren || depth.bracket || depth.brace) return false;
    if (isKeywordAt(text, index, "do")) return true;
    if ((style === "ruby" || style === "bash") && c === "\n") return true;
    if (style === "bash" && c === ";") return true;
    return false;
  });
  if (end < 0) return null;
  return { start: keywordEnd, end };
}

function forHeaderSpans(text, ext) {
  const normalized = String(ext || "").toLowerCase();
  const style = forHeaderStyle(normalized);
  if (!style) return [];
  const options = lexOptions(normalized);
  const spans = [];
  scanFrom(text, 0, options, (index) => {
    const keyword = isKeywordAt(text, index, "for")
      ? "for"
      : options.foreach && isKeywordAt(text, index, "foreach")
        ? "foreach"
        : "";
    if (!keyword) return false;
    const span = headerSpan(text, index + keyword.length, style, options);
    if (span && span.end > span.start) spans.push(span);
    return false;
  });
  return spans;
}

function selectionInForHeader(ext, fileText, range, snippet) {
  const text = String(fileText || "");
  if (!text) return false;
  const sel = selectionOffsets(text, range, snippet);
  if (!sel || sel.end <= sel.start) return false;
  const spans = forHeaderSpans(text, ext);
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    if (sel.start >= span.start && sel.end <= span.end) return true;
  }
  return false;
}

module.exports = {
  forHeaderSpans,
  selectionInForHeader,
};
