const os = require("os");
const path = require("path");

/**
 * Laya ONNX (Jev-compatible System-1 model) via @receptron/laya.
 * Load the model to judge session actions and events.
 * First load downloads ~1.7 GB of weights into the cache directory.
 */

let loadPromise = null;
let instance = null;

async function loadLaya(opts = {}) {
  if (instance) return instance;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const { Laya } = await import("@receptron/laya");
    instance = await Laya.load({
      cacheDir:
        process.env.LAYA_CACHE || path.join(os.homedir(), ".cache", "receptron-laya"),
      executionProviders: ["cpu"],
      ...opts,
    });
    return instance;
  })().catch((err) => {
    loadPromise = null;
    instance = null;
    throw err;
  });
  return loadPromise;
}

module.exports = { loadLaya };
