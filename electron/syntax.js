const fs = require("fs");
const path = require("path");
const TreeSitter = require("web-tree-sitter");
const Parser = TreeSitter.Parser || TreeSitter;
const { highlightLineRuleOk } = require("./line-rule");
const { smallestEnclosingBlock, selectionInString } = require("./local-block");
const { selectionInForHeader } = require("./for-header");
const {
  significantSymbol,
  isVariableDeclaration,
  enclosingCodeblock,
  walkToStatement,
  namedStatements,
  nodeSpan,
} = require("./statement-target");

const WASM_DIR = path.join(__dirname, "..", "node_modules", "tree-sitter-wasms", "out");
const PARSER_DIR = path.join(__dirname, "..", "node_modules", "web-tree-sitter");

function readWasm(filePath) {
  const buf = fs.readFileSync(filePath);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).slice();
}

const EXT_TO_WASM = {
  ".js": "tree-sitter-javascript.wasm",
  ".mjs": "tree-sitter-javascript.wasm",
  ".cjs": "tree-sitter-javascript.wasm",
  ".jsx": "tree-sitter-javascript.wasm",
  ".ts": "tree-sitter-typescript.wasm",
  ".tsx": "tree-sitter-tsx.wasm",
  ".py": "tree-sitter-python.wasm",
  ".pyw": "tree-sitter-python.wasm",
  ".java": "tree-sitter-java.wasm",
  ".c": "tree-sitter-c.wasm",
  ".h": "tree-sitter-c.wasm",
  ".cpp": "tree-sitter-cpp.wasm",
  ".cc": "tree-sitter-cpp.wasm",
  ".cxx": "tree-sitter-cpp.wasm",
  ".hpp": "tree-sitter-cpp.wasm",
  ".hh": "tree-sitter-cpp.wasm",
  ".cs": "tree-sitter-c_sharp.wasm",
  ".go": "tree-sitter-go.wasm",
  ".rs": "tree-sitter-rust.wasm",
  ".php": "tree-sitter-php.wasm",
  ".rb": "tree-sitter-ruby.wasm",
  ".lua": "tree-sitter-lua.wasm",
  ".kt": "tree-sitter-kotlin.wasm",
  ".kts": "tree-sitter-kotlin.wasm",
  ".scala": "tree-sitter-scala.wasm",
  ".swift": "tree-sitter-swift.wasm",
  ".dart": "tree-sitter-dart.wasm",
  ".sh": "tree-sitter-bash.wasm",
  ".bash": "tree-sitter-bash.wasm",
  ".yml": "tree-sitter-yaml.wasm",
  ".yaml": "tree-sitter-yaml.wasm",
  ".json": "tree-sitter-json.wasm",
  ".html": "tree-sitter-html.wasm",
  ".css": "tree-sitter-css.wasm",
};

let initPromise = null;
const languages = new Map();

function wasmForExt(ext) {
  return EXT_TO_WASM[String(ext || "").toLowerCase()] || null;
}

async function ensureInit() {
  if (!initPromise) {
    initPromise = Parser.init({
      wasmBinary: readWasm(path.join(PARSER_DIR, "tree-sitter.wasm")),
      locateFile: (file) => path.join(PARSER_DIR, file),
    }).catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  await initPromise;
}

async function languageForExt(ext) {
  const file = wasmForExt(ext);
  if (!file) return null;
  if (!languages.has(file)) {
    await ensureInit();
    const Lang = Parser.Language || TreeSitter.Language;
    if (!Lang || typeof Lang.load !== "function") {
      throw new Error("tree-sitter Language.load is unavailable");
    }
    const lang = await Lang.load(readWasm(path.join(WASM_DIR, file)));
    languages.set(file, lang);
  }
  return languages.get(file);
}

function nodeHasError(node) {
  if (!node) return true;
  const value = typeof node.hasError === "function" ? node.hasError() : node.hasError;
  return Boolean(value);
}

async function parseSource(ext, source) {
  const lang = await languageForExt(ext);
  if (!lang) return null;
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(String(source || ""));
  return { parser, tree, root: tree.rootNode };
}

function disposeParse(parsed) {
  if (!parsed) return;
  if (parsed.tree) parsed.tree.delete();
  if (parsed.parser) parsed.parser.delete();
}

function monacoRangeToPoints(range) {
  if (!range || range.startLine == null) return null;
  return {
    start: {
      row: Math.max(0, range.startLine - 1),
      column: Math.max(0, (range.startColumn || 1) - 1),
    },
    end: {
      row: Math.max(0, (range.endLine || range.startLine) - 1),
      column: Math.max(0, (range.endColumn || 1) - 1),
    },
  };
}

function shiftPoint(pos, origin) {
  if (!pos || !origin) return pos;
  return {
    row: pos.row + origin.row,
    column: pos.column + (pos.row === 0 ? origin.column : 0),
  };
}

function shiftSpan(span, origin) {
  if (!span || !origin) return span;
  return {
    ...span,
    start: shiftPoint(span.start, origin),
    end: shiftPoint(span.end, origin),
  };
}

function locateInFile(root, range, snippet) {
  if (!root) return null;
  const points = monacoRangeToPoints(range);
  if (points && typeof root.namedDescendantForPosition === "function") {
    const node = root.namedDescendantForPosition(points.start, points.end);
    if (node) return walkToStatement(node);
  }
  const needle = String(snippet || "").trim();
  if (!needle) return null;
  const idx = root.text.indexOf(needle);
  if (idx < 0 || typeof root.namedDescendantForIndex !== "function") return null;
  return walkToStatement(root.namedDescendantForIndex(idx, idx + needle.length));
}

async function validateHighlight({ ext, text, lines, fileText, range }) {
  if (!highlightLineRuleOk(ext, lines)) {
    return { ok: false, reason: "partial-line" };
  }

  const snippet = String(text || "").trim();
  if (!snippet) return { ok: false, reason: "empty" };
  if (fileText && selectionInString(ext, fileText, range, snippet)) {
    return { ok: false, reason: "in-string" };
  }

  const parsed = await parseSource(ext, snippet);
  if (!parsed) return { ok: false, reason: "unsupported-language" };
  try {
    if (nodeHasError(parsed.root)) return { ok: false, reason: "parse-error" };
    const stmts = namedStatements(parsed.root);
    if (!stmts.length) return { ok: false, reason: "no-nodes" };
    if (fileText && selectionInForHeader(ext, fileText, range, snippet)) {
      return { ok: false, reason: "for-header" };
    }
    const types = stmts.map((node) => node.type);
    return { ok: true, count: types.length, types };
  } finally {
    disposeParse(parsed);
  }
}

async function analyzeHighlightedStatement({ ext, text, fileText, range, lines }) {
  if (!highlightLineRuleOk(ext, lines)) {
    return { ok: false, reason: "partial-line" };
  }

  const snippet = String(text || "").trim();
  if (!snippet) return { ok: false, reason: "empty" };
  if (fileText && selectionInString(ext, fileText, range, snippet)) {
    return { ok: false, reason: "in-string" };
  }

  const parsed = await parseSource(ext, snippet);
  if (!parsed) return { ok: false, reason: "unsupported-language" };

  let fileParsed = null;
  try {
    const snippetError = nodeHasError(parsed.root);
    const stmts = snippetError ? [] : namedStatements(parsed.root);
    if (!snippetError && stmts.length !== 1) {
      if (!stmts.length) return { ok: false, reason: "no-nodes" };
      return { ok: true, single: false, count: stmts.length };
    }

    let statement = stmts[0] || null;
    if (!statement) {
          return { ok: false, reason: snippetError ? "parse-error" : "no-nodes" };
    }

    let from = "snippet";
    let statementSpan = nodeSpan(statement);
    let codeblockSpan = nodeSpan(enclosingCodeblock(statement));
    const block =
      fileText && isVariableDeclaration(statement)
        ? smallestEnclosingBlock(ext, fileText, range, snippet)
        : null;
    if (block) {
      return {
        ok: true,
        single: true,
        from,
        statement: statementSpan,
        codeblock: codeblockSpan,
        symbol: significantSymbol(statement),
        block: true
      };
    }

    return {
      ok: true,
      single: true,
      from,
      statement: statementSpan,
      codeblock: codeblockSpan,
      symbol: significantSymbol(statement),
      block: false
    };
  } finally {
    disposeParse(parsed);
    disposeParse(fileParsed);
  }
}

module.exports = {
  validateHighlight,
  analyzeHighlightedStatement,
  wasmForExt,
  highlightLineRuleOk,
};
