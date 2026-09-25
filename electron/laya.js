const os = require("os");
const path = require("path");

/**
 * Laya ONNX (Jev-compatible System-1 model) via @receptron/laya.
 * Used to decide whether a code selection is valid statements.
 * First load downloads ~1.7 GB of weights into the cache directory.
 */

let loadPromise = null;
let instance = null;
let lastError = null;

function cacheDir() {
  return (
    process.env.LAYA_CACHE || path.join(os.homedir(), ".cache", "receptron-laya")
  );
}

function status() {
  return {
    available: true,
    loaded: Boolean(instance),
    loading: Boolean(loadPromise) && !instance,
    error: lastError ? String(lastError.message || lastError) : null,
    cacheDir: cacheDir(),
    executionProviders: ["cpu"],
  };
}

async function loadLaya(opts = {}) {
  if (instance) return instance;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    lastError = null;
    const { Laya } = await import("@receptron/laya");
    instance = await Laya.load({
      cacheDir: cacheDir(),
      executionProviders: ["cpu"],
      ...opts,
    });
    return instance;
  })().catch((err) => {
    lastError = err;
    loadPromise = null;
    instance = null;
    throw err;
  });
  return loadPromise;
}

async function closeLaya() {
  if (instance && typeof instance.close === "function") {
    await instance.close();
  }
  instance = null;
  loadPromise = null;
}

const NOUL_THRESHOLD = 0.6;
const STMT_CHARS = 400;

async function validateHighlight(ext, text) {
  const stmt = String(text || "").trim();
  if (!stmt) return { ok: false, reason: "empty" };
  const language = String(ext || "code").replace(/^\./, "") || "code";
  const laya = await loadLaya();
  const questions = {
    s0: {
      type: "noul",
      instructions: `Is this syntactically correct ${language} code? Answer true only if a parser would accept it as complete, not a fragment. Code:\n${stmt.slice(0, STMT_CHARS)}`,
    },
  };
  const result = await laya.systemOne({ language }, questions);
  const ans = result.answers && result.answers.s0;
  const p =
    typeof ans === "number"
      ? ans
      : ans && typeof ans.noul === "number"
        ? ans.noul
        : 0;
  if (!(p >= NOUL_THRESHOLD)) {
    return { ok: false, reason: "invalid-statement", language, probability: p };
  }
  return { ok: true, language, count: 1 };
}

module.exports = {
  status,
  loadLaya,
  closeLaya,
  cacheDir,
  validateHighlight,
};
