const fs = require("fs");
const os = require("os");
const path = require("path");

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  ".next",
  ".cache",
  "coverage",
]);

function grokHome() {
  return process.env.GROK_HOME || path.join(os.homedir(), ".grok");
}

function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function encodeGrokCwd(cwd) {
  return encodeURIComponent(path.resolve(cwd));
}

function claudeProjectName(cwd) {
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

function ancestorPaths(start) {
  const out = [];
  let cur = path.resolve(start);
  while (true) {
    out.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return out;
}

function gitRoot(start) {
  for (const dir of ancestorPaths(start)) {
    try {
      if (fs.existsSync(path.join(dir, ".git"))) return dir;
    } catch {
      /* ignore */
    }
  }
  return path.resolve(start);
}

function safeStat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function relativeTime(ms) {
  if (!ms) return "";
  const delta = Date.now() - ms;
  const sec = Math.round(delta / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 14) return `${day}d ago`;
  return new Date(ms).toLocaleString();
}

function decodeGrokGroupName(name) {
  try {
    return decodeURIComponent(name);
  } catch {
    return null;
  }
}

function candidateCwds(projectPath) {
  const root = gitRoot(projectPath);
  const wanted = new Set();
  for (const dir of ancestorPaths(projectPath)) {
    wanted.add(path.resolve(dir));
    if (path.resolve(dir) === path.resolve(root)) break;
  }
  wanted.add(path.resolve(projectPath));
  wanted.add(path.resolve(root));
  return wanted;
}

function grokGroupDirsFor(projectPath) {
  const root = path.join(grokHome(), "sessions");
  const matches = [];
  if (!fs.existsSync(root)) return matches;

  const wanted = candidateCwds(projectPath);
  let groups;
  try {
    groups = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return matches;
  }

  for (const ent of groups) {
    if (!ent.isDirectory()) continue;
    const groupDir = path.join(root, ent.name);
    const cwdFile = path.join(groupDir, ".cwd");
    let cwd = decodeGrokGroupName(ent.name);
    if (fs.existsSync(cwdFile)) {
      try {
        cwd = fs.readFileSync(cwdFile, "utf8").trim() || cwd;
      } catch {
        /* keep decoded name */
      }
    }
    if (cwd && wanted.has(path.resolve(cwd))) {
      matches.push({ groupDir, cwd });
    }
  }

  const encoded = encodeGrokCwd(projectPath);
  const exact = path.join(root, encoded);
  if (fs.existsSync(exact) && !matches.some((m) => m.groupDir === exact)) {
    matches.push({ groupDir: exact, cwd: projectPath });
  }
  return matches;
}

function listGrokSessions(projectPath) {
  const sessions = [];
  for (const { groupDir, cwd } of grokGroupDirsFor(projectPath)) {
    let ids;
    try {
      ids = fs.readdirSync(groupDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ids) {
      if (!ent.isDirectory()) continue;
      const dir = path.join(groupDir, ent.name);
      const jsonl = path.join(dir, "updates.jsonl");
      const st = safeStat(jsonl);
      if (!st || !st.isFile()) continue;
      const summary = readJson(path.join(dir, "summary.json")) || {};
      const updatedAt =
        Date.parse(summary.updated_at || summary.last_active_at || "") ||
        st.mtimeMs;
      sessions.push({
        provider: "grok",
        id: ent.name,
        title:
          summary.generated_title ||
          summary.session_summary ||
          summary.last_turn_summary ||
          "Untitled session",
        model: summary.current_model_id || "",
        path: jsonl,
        cwd,
        updatedAt,
        updatedLabel: relativeTime(updatedAt),
        size: st.size,
        createdAt: Date.parse(summary.created_at || "") || st.birthtimeMs,
      });
    }
  }
  return sessions;
}

function listClaudeSessions(projectPath) {
  const sessions = [];
  const projectsRoot = path.join(claudeHome(), "projects");
  if (!fs.existsSync(projectsRoot)) return sessions;

  const candidateNames = new Set(
    [...candidateCwds(projectPath)].map((p) => claudeProjectName(p))
  );

  let dirs;
  try {
    dirs = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return sessions;
  }

  for (const ent of dirs) {
    if (!ent.isDirectory()) continue;
    if (!candidateNames.has(ent.name)) continue;
    const dir = path.join(projectsRoot, ent.name);
    let files;
    try {
      files = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      if (file.name.includes(".orphaned") || file.name.includes(".superseded")) {
        continue;
      }
      const jsonl = path.join(dir, file.name);
      const st = safeStat(jsonl);
      if (!st) continue;
      const id = file.name.replace(/\.jsonl$/, "");
      const title = firstClaudeUserText(jsonl) || id.slice(0, 8);
      sessions.push({
        provider: "claude",
        id,
        title: clip(title, 80),
        model: "",
        path: jsonl,
        cwd: projectPath,
        updatedAt: st.mtimeMs,
        updatedLabel: relativeTime(st.mtimeMs),
        size: st.size,
        createdAt: st.birthtimeMs || st.mtimeMs,
      });
    }
  }
  return sessions;
}

function clip(text, n) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  return t.slice(0, n - 1) + "…";
}

function firstClaudeUserText(jsonlPath) {
  try {
    const fd = fs.openSync(jsonlPath, "r");
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const chunk = buf.slice(0, n).toString("utf8");
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.type !== "user") continue;
      const text = extractText(obj.message || obj);
      if (text && !text.startsWith("<")) return text;
    }
  } catch {
    /* ignore */
  }
  return "";
}

function extractText(message) {
  if (!message) return "";
  if (typeof message === "string") return message;
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && block.text) return block.text;
        if (block && block.content) return extractText(block);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function listSessions(projectPath) {
  const root = gitRoot(projectPath);
  const all = [...listGrokSessions(root), ...listClaudeSessions(root)];
  if (path.resolve(projectPath) !== path.resolve(root)) {
    all.push(...listGrokSessions(projectPath), ...listClaudeSessions(projectPath));
  }
  const seen = new Set();
  const unique = [];
  for (const s of all) {
    if (seen.has(s.path)) continue;
    seen.add(s.path);
    unique.push(s);
  }
  unique.sort((a, b) => b.updatedAt - a.updatedAt);
  return { projectRoot: root, sessions: unique };
}

function parseJsonl(filePath, onLine, { maxBytes = 80 * 1024 * 1024 } = {}) {
  const st = safeStat(filePath);
  if (!st) throw new Error("File not found");
  if (st.size > maxBytes) {
    throw new Error(`File too large to parse (${Math.round(st.size / 1e6)} MB)`);
  }
  const stream = fs.readFileSync(filePath, "utf8");
  const lines = stream.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    onLine(obj, i);
  }
}

function normalizePath(p, projectRoot) {
  if (!p) return "";
  let n = String(p).replace(/\\/g, "/");
  if (projectRoot) {
    const root = path.resolve(projectRoot).replace(/\\/g, "/");
    if (n === root) return path.basename(n);
    if (n.startsWith(root + "/")) return n.slice(root.length + 1);
  }
  return n;
}

function scoreEdit(edit) {
  return (edit.oldLine ? 4 : 0) + (edit.oldText ? 2 : 0) + (edit.newText ? 1 : 0);
}

function rememberEdit(map, edit) {
  const key = edit.toolCallId || `${edit.path}:${edit.oldLine}:${edit.newText.length}`;
  const prev = map.get(key);
  if (!prev || scoreEdit(edit) >= scoreEdit(prev)) map.set(key, edit);
}

function parseGrokEdits(jsonlPath, projectRoot) {
  const byCall = new Map();
  const calls = new Map();

  parseJsonl(jsonlPath, (obj) => {
    const params = obj.params || {};
    const update = params.update || params.sessionUpdate || {};
    if (!update || typeof update !== "object") return;
    const kind = update.sessionUpdate;
    const toolMeta = (update._meta && update._meta["x.ai/tool"]) || {};
    const toolName = toolMeta.name || update.title || "";
    const toolCallId = update.toolCallId;
    const ts = params._meta && params._meta.agentTimestampMs;

    if (kind === "tool_call" && update.rawInput) {
      calls.set(toolCallId, { tool: toolName, rawInput: update.rawInput, ts });
    }
    if (kind !== "tool_call_update") return;

    const items = Array.isArray(update.content) ? update.content : [];
    const diffs = items.filter((c) => c && c.type === "diff");
    if (diffs.length) {
      for (const diff of diffs) {
        const details = (diff._meta && diff._meta.details) || [];
        const detail = details[0] || {};
        const meta = diff._meta || {};
        const filePath =
          diff.path ||
          (update.locations && update.locations[0] && update.locations[0].path) ||
          "";
        rememberEdit(byCall, {
          provider: "grok",
          tool: toolName || "search_replace",
          path: filePath,
          relPath: normalizePath(filePath, projectRoot),
          oldText: diff.oldText || detail.old_string || "",
          newText: diff.newText || detail.new_string || "",
          oldLine: meta.old_line || detail.old_line || null,
          newLine: meta.new_line || detail.new_line || null,
          toolCallId,
          timestamp: ts || null,
        });
      }
      return;
    }

    const input = update.rawInput || (calls.get(toolCallId) || {}).rawInput;
    if (input && (input.old_string || input.new_string || input.file_path)) {
      rememberEdit(byCall, {
        provider: "grok",
        tool: toolName || "search_replace",
        path: input.file_path || "",
        relPath: normalizePath(input.file_path, projectRoot),
        oldText: input.old_string || "",
        newText: input.new_string || "",
        oldLine: null,
        newLine: null,
        toolCallId,
        timestamp: ts || null,
      });
    }
  });

  return [...byCall.values()];
}

function parseClaudeEdits(jsonlPath, projectRoot) {
  const edits = [];
  parseJsonl(jsonlPath, (obj, lineNo) => {
    const message = obj.message || obj;
    const content = (message && message.content) || obj.content;
    const blocks = Array.isArray(content) ? content : [];
    for (const block of blocks) {
      if (!block || block.type !== "tool_use") continue;
      const name = block.name || "";
      const input = block.input || {};
      const filePath = input.file_path || input.path || input.target_file || "";
      if (!filePath) continue;
      const isEdit =
        /edit|write|replace|notebook/i.test(name) ||
        input.old_string != null ||
        input.new_string != null ||
        input.contents != null ||
        input.content != null;
      if (!isEdit) continue;
      const oldText = input.old_string || input.old_str || "";
      const newText =
        input.new_string ||
        input.new_str ||
        input.contents ||
        (typeof input.content === "string" ? input.content : "") ||
        "";
      edits.push({
        provider: "claude",
        tool: name,
        path: filePath,
        relPath: normalizePath(filePath, projectRoot),
        oldText,
        newText,
        oldLine: input.old_start || null,
        newLine: input.new_start || null,
        contextBefore: input.context_before || "",
        contextAfter: input.context_after || "",
        toolCallId: block.id || `line-${lineNo}`,
        timestamp: Date.parse(obj.timestamp || "") || null,
      });
    }
  });
  return dedupeEdits(edits);
}

function dedupeEdits(edits) {
  const seen = new Set();
  const out = [];
  for (const e of edits) {
    const key = `${e.toolCallId}|${e.path}|${e.oldLine}|${e.oldText.length}|${e.newText.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function parseSessionEdits(sessionPath, provider, projectRoot) {
  if (provider === "claude" || sessionPath.includes(`${path.sep}projects${path.sep}`)) {
    return parseClaudeEdits(sessionPath, projectRoot);
  }
  return parseGrokEdits(sessionPath, projectRoot);
}

function listTree(dir, { depth = 2, maxEntries = 400 } = {}) {
  const result = [];
  function walk(current, rel, remaining) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const ent of entries) {
      if (result.length >= maxEntries) return;
      if (ent.name.startsWith(".") && ent.name !== ".grok" && ent.name !== ".claude") {
        continue;
      }
      if (ent.isDirectory() && SKIP_DIR_NAMES.has(ent.name)) continue;
      const abs = path.join(current, ent.name);
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      const node = {
        name: ent.name,
        path: abs,
        rel: childRel,
        type: ent.isDirectory() ? "dir" : "file",
        children: undefined,
      };
      if (ent.isDirectory() && remaining > 0) {
        node.children = [];
        const before = result.length;
        walk(abs, childRel, remaining - 1);
        // walk pushes flat; for lazy tree we only want one level from renderer
        void before;
      }
      result.push(node);
    }
  }
  walk(dir, "", depth);
  return result;
}

function readDir(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(err.message);
  }
  return entries
    .filter((ent) => {
      if (ent.name === "." || ent.name === "..") return false;
      if (SKIP_DIR_NAMES.has(ent.name)) return false;
      return true;
    })
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((ent) => ({
      name: ent.name,
      path: path.join(dir, ent.name),
      type: ent.isDirectory() ? "dir" : "file",
    }));
}

function readTextFile(filePath, { maxBytes = 8 * 1024 * 1024 } = {}) {
  const st = safeStat(filePath);
  // Edit paths from a session are probed on folder open. A removed file is a result.
  if (!st || st.isDirectory()) {
    return { content: "", truncated: false, size: 0, missing: true };
  }
  if (st.size > maxBytes) {
    const buf = Buffer.alloc(maxBytes);
    const fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buf, 0, maxBytes, 0);
    fs.closeSync(fd);
    return {
      content: buf.toString("utf8") + `\n\n… truncated (${st.size} bytes total)`,
      truncated: true,
      size: st.size,
    };
  }
  return {
    content: fs.readFileSync(filePath, "utf8"),
    truncated: false,
    size: st.size,
  };
}

function writeTextFile(filePath, content) {
  fs.writeFileSync(filePath, content, "utf8");
  return { ok: true, size: Buffer.byteLength(content, "utf8") };
}

function toMs(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;
  const n = Number(value);
  if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatHm(ms) {
  if (!ms) return "--:--";
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function clipText(text, n = 400) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  return t.slice(0, n - 1) + "…";
}

function toolLabel(name, title) {
  const raw = (name || title || "Tool").replace(/[_:]/g, " ").trim();
  const key = raw.toLowerCase();
  const map = {
    search_replace: "Edit",
    "search replace": "Edit",
    edit: "Edit",
    write_file: "Write file",
    write: "Write file",
    read_file: "Read",
    read: "Read",
    list_dir: "List",
    glob: "Glob",
    grep: "Search",
    run_terminal_command: "Run command",
    bash: "Run command",
    web_search: "Web search",
    "web search": "Web search",
    spawn_subagent: "Spawn subagent",
    todo_write: "Update todos",
    apply_patch: "Apply patch",
    create_file: "Create file",
    delete_file: "Delete file",
  };
  if (map[key]) return map[key];
  if (/^edit\b/i.test(raw)) return "Edit";
  if (/^web search/i.test(raw)) return "Web search";
  if (/^execute\b/i.test(raw) || /^run\b/i.test(raw)) return "Run command";
  if (/^read\b/i.test(raw)) return "Read";
  if (/^list\b/i.test(raw)) return "List";
  return raw.replace(/\b\w/g, (c) => c.toUpperCase());
}

function inputQuery(input) {
  if (!input || typeof input !== "object") return "";
  return (
    input.query ||
    input.pattern ||
    input.command ||
    input.description ||
    input.prompt ||
    input.target_file ||
    input.file_path ||
    input.path ||
    input.target_directory ||
    ""
  );
}

function diffLines(oldText, newText) {
  const a = String(oldText || "").split("\n");
  const b = String(newText || "").split("\n");
  if (!oldText && newText != null) return b.map((text) => ({ type: "add", text }));
  if (!newText && oldText != null) return a.map((text) => ({ type: "del", text }));
  if (a.length * b.length > 25000) {
    const bSet = new Set(b);
    const aSet = new Set(a);
    return [
      ...a.filter((line) => !bSet.has(line)).map((text) => ({ type: "del", text })),
      ...b.filter((line) => !aSet.has(line)).map((text) => ({ type: "add", text })),
    ];
  }
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i++] });
    } else {
      out.push({ type: "add", text: b[j++] });
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}

function classifyMutation(toolName, title, oldText, newText) {
  const key = `${toolName || ""} ${title || ""}`.toLowerCase();
  if (/delete_file|delete file|\bdelete\b/.test(key)) return "Delete";
  const hasOld = String(oldText || "").length > 0;
  const hasNew = String(newText || "").length > 0;
  if (!hasOld && hasNew) return "Create";
  if (hasOld && !hasNew) return "Delete";
  if (/create_file|write_file|\bwrite\b|\bcreate\b/.test(key) && !hasOld) return "Create";
  if (/search_replace|apply_patch|\bedit\b|str_replace|write_file|create_file/.test(key)) {
    return "Edit";
  }
  if (hasOld || hasNew) return "Edit";
  return null;
}

function mutationKind(operation) {
  if (operation === "Create") return "create";
  if (operation === "Delete") return "delete";
  return "diff";
}

function mergeTimeline(markers, mutations) {
  const rank = { prompt: 0, create: 1, diff: 1, delete: 1 };
  const all = [...markers, ...mutations];
  all.sort((a, b) => {
    const ta = a.timestampMs || 0;
    const tb = b.timestampMs || 0;
    if (ta !== tb) return ta - tb;
    return (rank[a.kind] || 1) - (rank[b.kind] || 1);
  });
  return all;
}

function parseGrokEvents(jsonlPath, projectRoot) {
  const byCall = new Map();
  const markers = [];
  let openStart = null;

  parseJsonl(jsonlPath, (obj) => {
    const params = obj.params || {};
    const update = params.update || params.sessionUpdate || {};
    if (!update || typeof update !== "object") return;
    const meta = params._meta || {};
    const updateMeta = update._meta || {};
    const ts =
      toMs(meta.agentTimestampMs) ||
      toMs(obj.timestamp) ||
      toMs(update.timestamp);
    const kind = update.sessionUpdate;
    const toolMeta = (update._meta && update._meta["x.ai/tool"]) || {};
    const toolName = toolMeta.name || "";
    const title = update.title || "";
    const input = update.rawInput || toolMeta.input || {};
    const id = update.toolCallId;

    if (kind === "user_message_chunk") {
      const text =
        (update.content && update.content.text) ||
        extractText(update.content) ||
        "";
      const promptKey =
        meta.promptId ||
        (updateMeta.promptIndex != null ? `p${updateMeta.promptIndex}` : null);
      if (openStart && promptKey && openStart.promptKey === promptKey) {
        if (text) {
          openStart.fullText = `${openStart.fullText || ""} ${text}`.trim();
          openStart.detail = clipText(openStart.fullText, 800);
        }
        return;
      }
      openStart = {
        time: formatHm(ts),
        timestampMs: ts,
        operation: "Prompt",
        detail: clipText(text, 800),
        fullText: text,
        kind: "prompt",
        promptKey,
      };
      markers.push(openStart);
      return;
    }

    if (kind === "turn_completed") {
      openStart = null;
      return;
    }

    if (kind === "tool_call") {
      const op = classifyMutation(
        toolName,
        title,
        input.old_string,
        input.new_string || input.contents
      );
      if (!op || !id) return;
      const filePath =
        input.file_path || input.target_file || input.path || "";
      byCall.set(id, {
        time: formatHm(ts),
        timestampMs: ts,
        operation: op,
        detail: normalizePath(filePath, projectRoot) || filePath || clipText(title, 240),
        kind: mutationKind(op),
        toolCallId: id,
        path: filePath,
        lines: null,
        oldLine: null,
      });
      return;
    }

    if (kind !== "tool_call_update") return;

    const items = Array.isArray(update.content) ? update.content : [];
    const diffs = items.filter((c) => c && c.type === "diff");
    if (diffs.length) {
      const diff = diffs[0];
      const details = (diff._meta && diff._meta.details) || [];
      const detail = details[0] || {};
      const metaDiff = diff._meta || {};
      const filePath =
        diff.path ||
        (update.locations && update.locations[0] && update.locations[0].path) ||
        "";
      const oldText = diff.oldText || detail.old_string || "";
      const newText = diff.newText || detail.new_string || "";
      const oldLine = metaDiff.old_line || detail.old_line || null;
      const op =
        classifyMutation(toolName, title, oldText, newText) || "Edit";
      const event = {
        time: formatHm(ts),
        timestampMs: ts,
        operation: op,
        detail:
          (normalizePath(filePath, projectRoot) || filePath) +
          (oldLine ? ` · line ${oldLine}` : ""),
        kind: mutationKind(op),
        path: filePath,
        oldLine,
        oldText,
        newText,
        lines: diffLines(oldText, newText),
        toolCallId: id,
      };
      const prev = id && byCall.get(id);
      if (prev) Object.assign(prev, event);
      else if (id) byCall.set(id, event);
      return;
    }

    const prev = id && byCall.get(id);
    if (!prev) return;
    if (update.status && /fail|error|denied/i.test(String(update.status))) {
      prev.detail = `${prev.detail} · ${update.status}`;
    }
  });

  const mutations = [...byCall.values()].filter((e) =>
    ["Create", "Edit", "Delete"].includes(e.operation)
  );
  return mergeTimeline(markers, mutations);
}

function parseClaudeEvents(jsonlPath, projectRoot) {
  const mutations = [];
  const markers = [];
  let lastTs = null;
  parseJsonl(jsonlPath, (obj) => {
    const ts = toMs(obj.timestamp) || lastTs;
    lastTs = ts;
    const type = obj.type;
    const message = obj.message || obj;
    if (type === "user") {
      const text = extractText(message);
      if (!text || text.startsWith("<")) return;
      markers.push({
        time: formatHm(ts),
        timestampMs: ts,
        operation: "Prompt",
        detail: clipText(text, 800),
        kind: "prompt",
      });
      return;
    }
    if (type === "result") return;
    if (type !== "assistant") return;
    const blocks = Array.isArray(message.content) ? message.content : [];
    for (const block of blocks) {
      if (!block || block.type !== "tool_use") continue;
      const input = block.input || {};
      const filePath = input.file_path || input.path || "";
      const oldText = input.old_string || "";
      const newText =
        input.new_string ||
        input.contents ||
        (typeof input.content === "string" ? input.content : "") ||
        "";
      const op = classifyMutation(block.name, block.name, oldText, newText);
      if (!op) continue;
      mutations.push({
        time: formatHm(ts),
        timestampMs: ts,
        operation: op,
        detail:
          (normalizePath(filePath, projectRoot) || filePath || block.name) +
          (input.old_start ? ` · line ${input.old_start}` : ""),
        kind: mutationKind(op),
        path: filePath,
        oldLine: input.old_start || null,
        oldText,
        newText,
        toolCallId: block.id || "",
        lines: oldText || newText ? diffLines(oldText, newText) : null,
      });
    }
  });
  return mergeTimeline(markers, mutations);
}

function parseSessionEvents(sessionPath, provider, projectRoot) {
  const isClaude =
    provider === "claude" ||
    String(sessionPath).includes(`${path.sep}projects${path.sep}`);
  return isClaude
    ? parseClaudeEvents(sessionPath, projectRoot)
    : parseGrokEvents(sessionPath, projectRoot);
}

module.exports = {
  gitRoot,
  listSessions,
  parseSessionEdits,
  parseSessionEvents,
  listTree,
  readDir,
  readTextFile,
  writeTextFile,
  grokHome,
  claudeHome,
};
