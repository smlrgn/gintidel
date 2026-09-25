const path = require("path");
const TreeSitter = require("web-tree-sitter");
const Parser = TreeSitter.Parser || TreeSitter;

const WASM_DIR = path.join(__dirname, "..", "node_modules", "tree-sitter-wasms", "out");
const PARSER_DIR = path.join(__dirname, "..", "node_modules", "web-tree-sitter");

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
      locateFile: (file) => path.join(PARSER_DIR, file),
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
    const lang = await Lang.load(path.join(WASM_DIR, file));
    languages.set(file, lang);
  }
  return languages.get(file);
}

async function validateHighlight({ ext, text }) {
  const lang = await languageForExt(ext);
  if (!lang) return { ok: false, reason: "unsupported-language" };

  const snippet = String(text || "").trim();
  if (!snippet) return { ok: false, reason: "empty" };

  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(snippet);
  parser.delete();
  const root = tree.rootNode;
  try {
    if (root.hasError) return { ok: false, reason: "parse-error" };
    const types = [];
    for (let i = 0; i < root.namedChildCount; i++) {
      types.push(root.namedChild(i).type);
    }
    if (!types.length) return { ok: false, reason: "no-nodes" };
    return { ok: true, count: types.length, types };
  } finally {
    tree.delete();
  }
}

module.exports = { validateHighlight, wasmForExt };
