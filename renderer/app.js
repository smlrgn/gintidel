/* global require, monaco, api */

const state = {
  projectPath: null,
  projectRoot: null,
  sessions: [],
  sessionFilter: "all",
  activeSessionPath: null,
  editsBySession: new Map(),
  tabs: [],
  activeTab: null,
  editor: null,
  monacoReady: false,
  expanded: new Set(),
  findHits: [],
  findIndex: 0,
  selDeleteSeq: 0,
  selDeleteTimer: null,
  revertPairs: new Map(),
  updatePairs: new Map(),
  absentNewIds: new Set(),
  presentOldIds: new Set(),
  revertErrors: new Map(),
  revertBusy: false,
  fileGen: new Map(),
  timelineRender: 0,
};

const el = {
  fileTree: document.getElementById("fileTree"),
  sessionList: document.getElementById("sessionList"),
  editorTabs: document.getElementById("editorTabs"),
  monacoHost: document.getElementById("monacoHost"),
  timelineHost: document.getElementById("timelineHost"),
  welcome: document.getElementById("welcome"),
  projectChip: document.getElementById("projectChip"),
  changesPanel: document.getElementById("changesPanel"),
  changesBody: document.getElementById("changesBody"),
  changesTitle: document.getElementById("changesTitle"),
  changesMeta: document.getElementById("changesMeta"),
  btnSave: document.getElementById("btnSave"),
  workspace: document.querySelector(".workspace"),
  findBar: document.getElementById("findBar"),
  findInput: document.getElementById("findInput"),
  findCount: document.getElementById("findCount"),
  selDeleteBtn: document.getElementById("selDeleteBtn"),
  editorCol: document.querySelector(".editor-col"),
};

function languageFor(filePath) {
  const ext = (api.extname(filePath) || "").toLowerCase();
  const map = {
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".jsx": "javascript",
    ".json": "json",
    ".jsonl": "json",
    ".html": "html",
    ".css": "css",
    ".md": "markdown",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".toml": "ini",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".sh": "shell",
    ".xml": "xml",
  };
  return map[ext] || "plaintext";
}

function initMonaco() {
  require.config({
    paths: { vs: "../node_modules/monaco-editor/min/vs" },
  });
  require(["vs/editor/editor.main"], () => {
    monaco.editor.defineTheme("session-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#0e1014",
        "editorGutter.background": "#0e1014",
      },
    });
    monaco.editor.setTheme("session-dark");
    state.editor = monaco.editor.create(el.monacoHost, {
      value: "",
      language: "plaintext",
      automaticLayout: true,
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: "line",
      readOnly: true,
    });
    state.editor.onDidChangeModelContent(() => {
      const tab = currentTab();
      if (!tab || tab.loading || tab.readOnly) return;
      const value = state.editor.getValue();
      if (value !== tab.saved) {
        tab.dirty = true;
        el.btnSave.disabled = false;
        renderTabs();
      }
    });
    state.editor.onDidChangeCursorSelection(() => updateSelDeleteBtn());
    state.editor.onDidScrollChange(() => repositionSelDelete());
    state.monacoReady = true;
    if (state.activeTab) showTab(state.activeTab);
  });
}

function currentTab() {
  return state.tabs.find((t) => t.path === state.activeTab) || null;
}

function hideWelcome() {
  el.welcome.classList.add("hidden");
  hideSelDelete();
}

function isSessionLog(filePath) {
  return /\.jsonl$/i.test(filePath || "");
}

function showMonaco() {
  closeFind();
  el.monacoHost.classList.remove("idle");
  el.timelineHost.classList.add("hidden");
  el.changesPanel.classList.remove("hidden");
  el.workspace.classList.remove("fill");
}

function showTimeline() {
  el.monacoHost.classList.add("idle");
  el.timelineHost.classList.remove("hidden");
  el.changesPanel.classList.add("hidden");
  el.workspace.classList.add("fill");
}

async function openProject(projectPath) {
  if (!projectPath) return;
  state.projectPath = projectPath;
  state.projectRoot = await api.gitRoot(projectPath);
  el.projectChip.textContent = state.projectRoot;
  state.expanded = new Set([state.projectRoot]);
  await renderFileTree();
  await loadSessions();
}

async function renderFileTree() {
  if (!state.projectRoot) {
    el.fileTree.innerHTML = `<div class="empty">Open a project folder to browse files.</div>`;
    return;
  }
  el.fileTree.innerHTML = "";
  await appendDir(el.fileTree, state.projectRoot, 0);
}

async function appendDir(container, dir, depth) {
  let entries;
  try {
    entries = await api.readDir(dir);
  } catch (err) {
    container.insertAdjacentHTML(
      "beforeend",
      `<div class="empty">${escapeHtml(err.message)}</div>`
    );
    return;
  }
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "tree-item";
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.dataset.path = entry.path;
    row.dataset.type = entry.type;
    const chev = entry.type === "dir" ? (state.expanded.has(entry.path) ? "▾" : "▸") : " ";
    row.innerHTML = `<span class="chev">${chev}</span><span>${escapeHtml(entry.name)}</span>`;
    container.appendChild(row);
    const childBox = document.createElement("div");
    childBox.className = "tree-children";
    container.appendChild(childBox);
    if (entry.type === "dir" && state.expanded.has(entry.path)) {
      childBox.classList.add("open");
      await appendDir(childBox, entry.path, depth + 1);
    }
    row.addEventListener("click", async (evt) => {
      evt.stopPropagation();
      if (entry.type === "dir") {
        if (state.expanded.has(entry.path)) state.expanded.delete(entry.path);
        else state.expanded.add(entry.path);
        await renderFileTree();
      } else {
        await openInEditor(entry.path, { readOnly: false });
      }
    });
  }
}

async function openInEditor(filePath, { readOnly = false, activate = true } = {}) {
  hideWelcome();
  const logFile = isSessionLog(filePath);
  let tab = state.tabs.find((t) => t.path === filePath);
  if (!tab) {
    tab = {
      path: filePath,
      name: api.basename(filePath),
      content: "",
      saved: "",
      dirty: false,
      readOnly: logFile ? true : readOnly,
      loading: false,
      events: null,
    };
    if (logFile) {
      const session = state.sessions.find((s) => s.path === filePath);
      try {
        tab.events = await api.parseEvents(
          filePath,
          session ? session.provider : "grok",
          state.projectRoot
        );
      } catch (err) {
        tab.events = [
          {
            time: "--:--",
            operation: "Could not parse log",
            detail: err.message,
            kind: "error",
            lines: null,
          },
        ];
      }
    } else {
      const result = await api.readFile(filePath);
      if (result.missing) return;
      tab.content = result.content;
      tab.saved = result.content;
    }
    state.tabs.push(tab);
  }
  if (activate) {
    state.activeTab = filePath;
    showTab(filePath);
    highlightTree(filePath);
    if (!isSessionLog(filePath)) await refreshChanges();
  }
  renderTabs();
}

function showTab(filePath) {
  hideSelDelete();
  const tab = state.tabs.find((t) => t.path === filePath);
  if (!tab) return;
  if (isSessionLog(filePath)) {
    tab.readOnly = true;
    el.btnSave.disabled = true;
    renderTimeline(tab.events || []);
    showTimeline();
    renderTabs();
    return;
  }
  if (!state.editor) return;
  showMonaco();
  const uri = monaco.Uri.file(filePath);
  let model = monaco.editor.getModel(uri);
  if (!model) {
    model = monaco.editor.createModel(tab.content, languageFor(filePath), uri);
  }
  state.editor.setModel(model);
  state.editor.updateOptions({ readOnly: tab.readOnly });
  el.btnSave.disabled = tab.readOnly || !tab.dirty;
  renderTabs();
}

const REVERT_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M6.2 4.2 3.4 7l2.8 2.8"/><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M3.8 7H10a2.6 2.6 0 1 1 0 5.2H8"/></svg>';

function revertPairId(item) {
  const path = item.path || "";
  const call = item.toolCallId || "";
  if (call) return `${call}|${path}`;
  return [
    path,
    item.oldLine || item.newLine || "",
    String(item.oldText || "").length,
    String(item.newText || "").length,
    item.timestamp || item.timestampMs || "",
  ].join("|");
}

function rememberUpdatePair(item) {
  if (!item || !item.path || isSessionLog(item.path)) return "";
  if (!item.oldText && !item.newText) return "";
  const id = revertPairId(item);
  state.updatePairs.set(id, {
    id,
    path: item.path,
    oldText: item.oldText || "",
    newText: item.newText || "",
  });
  if (item.oldText) {
    state.revertPairs.set(id, {
      id,
      path: item.path,
      oldText: item.oldText,
      newText: item.newText || "",
    });
  }
  return id;
}

function revertControlVisible(id, mode) {
  const pair = state.updatePairs.get(id);
  if (!pair) return false;
  const newPresent = !!pair.newText && !state.absentNewIds.has(id);
  const oldPresent = !!pair.oldText && state.presentOldIds.has(id);
  if (mode === "new") return !newPresent && oldPresent;
  return newPresent && !!pair.oldText;
}

function revertControlHtml(id, mode) {
  const on = revertControlVisible(id, mode);
  const label = mode === "new" ? "Restore the new text" : "Revert this change";
  return `<span class="revert-control${on ? "" : " is-off"}"><button type="button" class="revert-btn" data-revert-id="${escapeHtml(
    id
  )}" data-revert-mode="${mode}" title="${label}" aria-label="${label}">${REVERT_ICON}</button><span class="revert-error" aria-hidden="true">!</span></span>`;
}

function replaceOnce(fileText, needle, replacement) {
  const file = String(fileText ?? "");
  const from = String(needle ?? "");
  const to = String(replacement ?? "");
  if (!from) return { ok: false, reason: "missing" };
  const at = file.indexOf(from);
  if (at < 0) return { ok: false, reason: "missing" };
  if (file.indexOf(from, at + from.length) >= 0) return { ok: false, reason: "multiple" };
  return { ok: true, content: file.slice(0, at) + to + file.slice(at + from.length) };
}

function paintRevertErrors() {
  document.querySelectorAll(".revert-control").forEach((wrap) => {
    const btn = wrap.querySelector(".revert-btn");
    const mark = wrap.querySelector(".revert-error");
    if (!btn || !mark) return;
    const reason = state.revertErrors.get(btn.dataset.revertId) || "";
    mark.classList.toggle("is-shown", !!reason);
    mark.title = reason;
  });
}

function showRevertError(id, reason) {
  state.revertErrors.set(id, reason);
  paintRevertErrors();
}

function paintAbsentNewText() {
  document.querySelectorAll("[data-new-id]").forEach((node) => {
    node.classList.toggle("new-absent", state.absentNewIds.has(node.dataset.newId));
  });
}

function paintRevertButtons() {
  document.querySelectorAll(".revert-control").forEach((wrap) => {
    const btn = wrap.querySelector(".revert-btn");
    if (!btn) return;
    const on = revertControlVisible(btn.dataset.revertId, btn.dataset.revertMode || "old");
    wrap.classList.toggle("is-off", !on);
  });
}

function applyAbsent(updates) {
  for (const update of updates) {
    if (update.absent) state.absentNewIds.add(update.id);
    else state.absentNewIds.delete(update.id);
    if (update.oldPresent) state.presentOldIds.add(update.id);
    else state.presentOldIds.delete(update.id);
  }
  paintAbsentNewText();
  paintRevertButtons();
}

async function findAbsentIds(pairs, known) {
  const list = [];
  const seen = new Set();
  for (const pair of pairs) {
    if (!pair || !pair.id || seen.has(pair.id)) continue;
    if (!pair.newText && !pair.oldText) continue;
    seen.add(pair.id);
    list.push(pair);
  }
  const byPath = new Map();
  for (const pair of list) {
    if (!byPath.has(pair.path)) byPath.set(pair.path, []);
    byPath.get(pair.path).push(pair);
  }
  const started = new Map();
  for (const path of byPath.keys()) started.set(path, state.fileGen.get(path) || 0);

  const texts = new Map();
  await Promise.all(
    [...byPath.keys()].map(async (path) => {
      if (known && known.has(path)) {
        texts.set(path, known.get(path));
        return;
      }
      const live = editorText(path);
      if (live != null) {
        texts.set(path, live);
        return;
      }
      try {
        const file = await api.readFile(path);
        texts.set(path, file.truncated ? null : file.content);
      } catch {
        texts.set(path, null);
      }
    })
  );

  const updates = [];
  for (const pair of list) {
    if ((state.fileGen.get(pair.path) || 0) !== started.get(pair.path)) continue;
    const text = texts.get(pair.path);
    if (text == null) continue;
    const newAbsent = pair.newText ? text.indexOf(pair.newText) < 0 : true;
    const oldPresent = pair.oldText ? text.indexOf(pair.oldText) >= 0 : false;
    updates.push({ id: pair.id, absent: newAbsent, oldPresent });
  }
  return updates;
}

function editorText(filePath) {
  if (!(state.monacoReady && window.monaco)) return null;
  const model = monaco.editor.getModel(monaco.Uri.file(filePath));
  if (!model) return null;
  return model.getValue();
}

function syncRevertedFile(filePath, content) {
  const tab = state.tabs.find((t) => pathsEqual(t.path, filePath));
  if (tab) tab.loading = true;
  if (state.monacoReady && window.monaco) {
    const model = monaco.editor.getModel(monaco.Uri.file(filePath));
    if (model && model.getValue() !== content) model.setValue(content);
  }
  if (!tab) return;
  tab.content = content;
  tab.saved = content;
  tab.dirty = false;
  tab.loading = false;
  if (currentTab() === tab) {
    el.btnSave.disabled = true;
    renderTabs();
  }
}

async function revertPair(id, mode) {
  if (state.revertBusy) return;
  const pair = state.revertPairs.get(id);
  if (!pair || isSessionLog(pair.path)) return;
  const restoreNew = mode === "new";
  state.revertBusy = true;
  try {
    let content = editorText(pair.path);
    let truncated = false;
    if (content == null) {
      const file = await api.readFile(pair.path);
      content = file.content;
      truncated = !!file.truncated;
    }
    if (truncated) {
      showRevertError(id, "File is too large to revert safely");
      return;
    }
    const plan = restoreNew
      ? replaceOnce(content, pair.oldText, pair.newText)
      : replaceOnce(content, pair.newText, pair.oldText);
    if (!plan.ok) {
      const which = restoreNew ? "Old text" : "New text";
      showRevertError(
        id,
        plan.reason === "multiple" ? `${which} appears more than once` : `${which} is not in the file`
      );
      return;
    }
    state.fileGen.set(pair.path, (state.fileGen.get(pair.path) || 0) + 1);
    await api.writeFile(pair.path, plan.content);
    syncRevertedFile(pair.path, plan.content);
    state.revertErrors.delete(id);
    paintRevertErrors();
    const sameFile = [...state.updatePairs.values()].filter((item) =>
      pathsEqual(item.path, pair.path)
    );
    applyAbsent(await findAbsentIds(sameFile, new Map([[pair.path, plan.content]])));
  } catch (err) {
    showRevertError(id, err.message || "Could not revert this change");
  } finally {
    state.revertBusy = false;
  }
}

function onRevertClick(e) {
  const btn = e.target.closest && e.target.closest(".revert-btn");
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  revertPair(btn.dataset.revertId, btn.dataset.revertMode);
}

function onRevertMouseDown(e) {
  if (e.target.closest && e.target.closest(".revert-btn")) e.preventDefault();
}

function diffLineHtml(line, control, newId) {
  const cls = line.type === "add" ? "add" : line.type === "del" ? "del" : "";
  const absent = cls === "add" && newId && state.absentNewIds.has(newId) ? " new-absent" : "";
  const attr = cls === "add" && newId ? ` data-new-id="${escapeHtml(newId)}"` : "";
  const mark = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
  return `<div class="diff-line ${cls}${absent}"${attr}>${control || ""}${mark} ${escapeHtml(line.text)}</div>`;
}

async function renderTimeline(events) {
  const rows = (events || []).filter((ev) =>
    ["Prompt", "Create", "Edit", "Delete"].includes(ev.operation)
  );
  if (!rows.length) {
    el.timelineHost.innerHTML = `<div class="empty">No create, edit, or delete operations in this session.</div>`;
    return;
  }
  const token = ++state.timelineRender;
  const pairs = [];
  for (const ev of rows) {
    const id = rememberUpdatePair(ev);
    if (id) pairs.push(state.updatePairs.get(id));
  }
  const absent = await findAbsentIds(pairs);
  if (token !== state.timelineRender) return;
  applyAbsent(absent);
  if (token !== state.timelineRender) return;

  const MAX_DIFF = 48;
  const hiddenDiffLines = [];
  el.timelineHost.innerHTML = rows
    .map((ev) => {
      let body = "";
      if (ev.kind === "prompt") {
        body += `<div class="prompt-box" title="Double-click to expand"><div class="prompt-clip">${escapeHtml(
          ev.fullText || ev.detail || ""
        )}</div></div>`;
      } else {
        body += `<div class="event-op">${escapeHtml(ev.operation)}</div>`;
        if (ev.detail) {
          body += `<div class="event-detail">${escapeHtml(ev.detail)}</div>`;
        }
      }
      if (Array.isArray(ev.lines) && ev.lines.length) {
        const shown = ev.lines.slice(0, MAX_DIFF);
        const rest = ev.lines.slice(MAX_DIFF);
        let more = "";
        const pairId = rememberUpdatePair(ev);
        const newId = pairId && ev.newText ? pairId : "";
        const revertId = pairId && ev.oldText ? pairId : "";
        if (rest.length) {
          const id = hiddenDiffLines.length;
          hiddenDiffLines.push({ lines: rest, newId });
          more = `<div class="diff-more" data-more="${id}">${rest.length} more lines</div>`;
        }
        let placedOld = false;
        let placedNew = false;
        const shownHtml = shown
          .map((line) => {
            let control = "";
            if (revertId && !placedOld && line.type === "del") {
              control = revertControlHtml(revertId, "old");
              placedOld = true;
            } else if (revertId && newId && !placedNew && line.type === "add") {
              control = revertControlHtml(newId, "new");
              placedNew = true;
            }
            return diffLineHtml(line, control, newId);
          })
          .join("");
        const lead = [
          revertId && !placedOld ? revertControlHtml(revertId, "old") : "",
          revertId && newId && !placedNew ? revertControlHtml(newId, "new") : "",
        ].join("");
        body += `<div class="event-diff">${lead}${shownHtml}${more}</div>`;
      }
      return `<div class="event-row kind-${escapeHtml(ev.kind || "other")}" data-path="${escapeHtml(
        ev.path || ""
      )}">
        <div class="event-time">${escapeHtml(ev.time)}</div>
        <div class="event-main">${body}</div>
      </div>`;
    })
    .join("");
  el.timelineHost.querySelectorAll(".prompt-box").forEach((box) => {
    box.addEventListener("dblclick", (e) => {
      e.preventDefault();
      box.classList.toggle("expanded");
      box.title = box.classList.contains("expanded")
        ? "Double-click to collapse"
        : "Double-click to expand";
    });
  });
  el.timelineHost.querySelectorAll(".diff-more").forEach((more) => {
    more.addEventListener("click", () => {
      const item = hiddenDiffLines[Number(more.dataset.more)] || { lines: [] };
      const rest = item.lines || [];
      more.insertAdjacentHTML(
        "beforebegin",
        rest.map((line) => diffLineHtml(line, "", item.newId)).join("")
      );
      more.remove();
      if (!el.findBar.classList.contains("hidden") && el.findInput.value) {
        runFind(false);
      }
    });
  });
  if (!el.findBar.classList.contains("hidden") && el.findInput.value) {
    runFind(false);
  }
  paintRevertErrors();
  el.timelineHost.onscroll = () => repositionSelDelete();
}

function hideSelDelete() {
  el.selDeleteBtn.classList.add("hidden");
}

function placeSelDelete(top) {
  const btn = el.selDeleteBtn;
  btn.classList.remove("hidden");
  const col = el.editorCol.getBoundingClientRect();
  const h = btn.offsetHeight || 22;
  const max = col.height - h - 4;
  btn.style.top = `${Math.max(4, Math.min(top, max))}px`;
}

function monacoSelDeleteTop() {
  if (!state.editor || el.monacoHost.classList.contains("idle")) return null;
  const sel = state.editor.getSelection();
  if (!sel || sel.isEmpty()) return null;
  const line = sel.selectionStartLineNumber;
  let lineHeight = 19;
  try {
    const opt = monaco.editor.EditorOption;
    if (opt && opt.lineHeight != null) {
      lineHeight = state.editor.getOption(opt.lineHeight) || lineHeight;
    }
  } catch {
    /* keep default */
  }
  const yInEditor = state.editor.getTopForLineNumber(line) - state.editor.getScrollTop();
  if (yInEditor + lineHeight < 0 || yInEditor > el.monacoHost.clientHeight) return null;
  const host = el.monacoHost.getBoundingClientRect();
  const col = el.editorCol.getBoundingClientRect();
  return host.top - col.top + yInEditor + (lineHeight - 22) / 2;
}

function timelineSelDeleteTop() {
  if (el.timelineHost.classList.contains("hidden")) return null;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.anchorNode) return null;
  if (!el.timelineHost.contains(sel.anchorNode)) return null;
  if (el.findBar.contains(sel.anchorNode)) return null;
  const range = document.createRange();
  range.setStart(sel.anchorNode, sel.anchorOffset);
  range.collapse(true);
  let rect = range.getBoundingClientRect();
  if (!rect.height && sel.rangeCount) {
    const full = sel.getRangeAt(0);
    const rects = full.getClientRects();
    if (rects.length) rect = rects[0];
  }
  if (!rect || (rect.width === 0 && rect.height === 0)) return null;
  const col = el.editorCol.getBoundingClientRect();
  const host = el.timelineHost.getBoundingClientRect();
  if (rect.top < host.top - 8 || rect.top > host.bottom) return null;
  return rect.top - col.top;
}

function selectedEditorText() {
  if (!state.editor || el.monacoHost.classList.contains("idle")) return "";
  const sel = state.editor.getSelection();
  const model = state.editor.getModel();
  if (!sel || !model || sel.isEmpty()) return "";
  return model.getValueInRange(sel);
}

function selectedEditorLines() {
  if (!state.editor || el.monacoHost.classList.contains("idle")) return [];
  const sel = state.editor.getSelection();
  const model = state.editor.getModel();
  if (!sel || !model || sel.isEmpty()) return [];
  const lines = [];
  for (let n = sel.startLineNumber; n <= sel.endLineNumber; n++) {
    const full = model.getLineContent(n);
    const start = n === sel.startLineNumber ? sel.startColumn - 1 : 0;
    const end = n === sel.endLineNumber ? sel.endColumn - 1 : full.length;
    lines.push({ full, start, end });
  }
  return lines;
}

function selectionAnchorElement() {
  const sel = window.getSelection();
  if (!sel || !sel.anchorNode) return null;
  return sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
}

function stripDiffPrefixes(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[+\- ] /, ""))
    .join("\n");
}

function selectedTimelineText() {
  if (el.timelineHost.classList.contains("hidden")) return "";
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.anchorNode) return "";
  if (!el.timelineHost.contains(sel.anchorNode)) return "";
  if (el.findBar.contains(sel.anchorNode)) return "";
  let text = sel.toString();
  const node = selectionAnchorElement();
  if (node && node.closest && node.closest(".event-diff")) {
    text = stripDiffPrefixes(text);
  }
  return text;
}

function rangeOffsetsInElement(el, range) {
  if (!el || !range) return null;
  try {
    if (!range.intersectsNode(el)) return null;
  } catch {
    return null;
  }
  const contents = document.createRange();
  contents.selectNodeContents(el);
  const clipped = range.cloneRange();
  if (clipped.compareBoundaryPoints(Range.START_TO_START, contents) < 0) {
    clipped.setStart(contents.startContainer, contents.startOffset);
  }
  if (clipped.compareBoundaryPoints(Range.END_TO_END, contents) > 0) {
    clipped.setEnd(contents.endContainer, contents.endOffset);
  }
  if (clipped.collapsed) {
    return { full: el.textContent || "", start: 0, end: 0 };
  }
  const before = document.createRange();
  before.selectNodeContents(el);
  before.setEnd(clipped.startContainer, clipped.startOffset);
  const start = before.toString().length;
  return {
    full: el.textContent || "",
    start,
    end: start + clipped.toString().length,
  };
}

function stripDiffLineSpan(span) {
  const full = String(span.full || "");
  const match = full.match(/^[+\- ] /);
  const prefix = match ? match[0].length : 0;
  return {
    full: full.slice(prefix),
    start: Math.max(0, span.start - prefix),
    end: Math.max(0, span.end - prefix),
  };
}

function selectedTimelineLines() {
  if (el.timelineHost.classList.contains("hidden")) return [];
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.anchorNode || !sel.rangeCount) return [];
  if (!el.timelineHost.contains(sel.anchorNode)) return [];
  if (el.findBar.contains(sel.anchorNode)) return [];
  const node = selectionAnchorElement();
  if (!node || !node.closest) return [];
  const row = node.closest(".event-row");
  if (!row) return [];
  const range = sel.getRangeAt(0);
  const lines = [];
  row.querySelectorAll(".diff-line").forEach((lineEl) => {
    const span = rangeOffsetsInElement(lineEl, range);
    if (!span || span.end <= span.start) return;
    lines.push(stripDiffLineSpan(span));
  });
  return lines;
}

function selectedTimelineExt() {
  const node = selectionAnchorElement();
  if (!node || !node.closest) return "";
  const row = node.closest(".event-row");
  const p = row && row.dataset.path;
  if (p) return api.extname(p);
  return ".js";
}

function selDeleteContext() {
  if (el.welcome && !el.welcome.classList.contains("hidden")) return null;
  if (!el.monacoHost.classList.contains("idle")) {
    let top = null;
    try {
      top = monacoSelDeleteTop();
    } catch {
      return null;
    }
    const text = selectedEditorText();
    if (top == null || !String(text).trim()) return null;
    const ext = state.activeTab ? api.extname(state.activeTab) : "";
    const sel = state.editor && state.editor.getSelection();
    const range =
      sel && !sel.isEmpty()
        ? {
            startLine: sel.startLineNumber,
            startColumn: sel.startColumn,
            endLine: sel.endLineNumber,
            endColumn: sel.endColumn,
          }
        : null;
    return { top, text, ext, lines: selectedEditorLines(), range };
  }
  if (timelineOpen()) {
    const top = timelineSelDeleteTop();
    const text = selectedTimelineText();
    if (top == null || !String(text).trim()) return null;
    const node = selectionAnchorElement();
    const row = node && node.closest && node.closest(".event-row");
    const filePath = (row && row.dataset.path) || "";
    return { top, text, ext: selectedTimelineExt(), lines: selectedTimelineLines(), filePath };
  }
  return null;
}

async function fileTextForSelection(ctx) {
  if (!ctx) return "";
  if (ctx.range && state.editor && !el.monacoHost.classList.contains("idle")) {
    const model = state.editor.getModel();
    return model ? model.getValue() : "";
  }
  if (ctx.filePath) {
    try {
      const result = await api.readFile(ctx.filePath);
      return (result && result.content) || "";
    } catch {
      return "";
    }
  }
  return "";
}

function repositionSelDelete() {
  if (el.selDeleteBtn.classList.contains("hidden")) return;
  const ctx = selDeleteContext();
  if (!ctx) hideSelDelete();
  else placeSelDelete(ctx.top);
}

function updateSelDeleteBtn() {
  const ctx = selDeleteContext();
  if (state.selDeleteTimer) {
    clearTimeout(state.selDeleteTimer);
    state.selDeleteTimer = null;
  }
  if (!ctx) {
    state.selDeleteSeq += 1;
    hideSelDelete();
    return;
  }
  if (!api.highlightLineRuleOk(ctx.ext, ctx.lines)) {
    state.selDeleteSeq += 1;
    hideSelDelete();
    return;
  }
  const seq = ++state.selDeleteSeq;
  const { text, ext, lines } = ctx;
  state.selDeleteTimer = setTimeout(async () => {
    try {
      const fileText = await fileTextForSelection(ctx);
      const result = await api.validateHighlight({
        ext,
        text,
        lines,
        fileText,
        range: ctx.range,
      });
      if (seq !== state.selDeleteSeq) return;
      if (!result || !result.ok) {
        hideSelDelete();
        return;
      }
      const now = selDeleteContext();
      if (now) placeSelDelete(now.top);
      else hideSelDelete();
    } catch {
      if (seq !== state.selDeleteSeq) return;
      hideSelDelete();
    }
  }, 120);
}

function timelineOpen() {
  return (
    state.activeTab &&
    isSessionLog(state.activeTab) &&
    !el.timelineHost.classList.contains("hidden")
  );
}

function clearFindMarks() {
  el.timelineHost.querySelectorAll("mark.find-hit").forEach((mark) => {
    const text = document.createTextNode(mark.textContent);
    const parent = mark.parentNode;
    parent.replaceChild(text, mark);
    parent.normalize();
  });
  state.findHits = [];
}

function collectTextNodes(root) {
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      if (node.parentElement && node.parentElement.closest("mark.find-hit")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

function wrapQueryInNode(textNode, query) {
  const text = textNode.nodeValue;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  if (!q || lower.indexOf(q) === -1) return [];
  const frag = document.createDocumentFragment();
  const marks = [];
  let last = 0;
  let idx = lower.indexOf(q, last);
  while (idx !== -1) {
    if (idx > last) {
      frag.appendChild(document.createTextNode(text.slice(last, idx)));
    }
    const mark = document.createElement("mark");
    mark.className = "find-hit";
    mark.textContent = text.slice(idx, idx + query.length);
    frag.appendChild(mark);
    marks.push(mark);
    last = idx + query.length;
    idx = lower.indexOf(q, last);
  }
  if (last < text.length) {
    frag.appendChild(document.createTextNode(text.slice(last)));
  }
  textNode.parentNode.replaceChild(frag, textNode);
  return marks;
}

function runFind(keepIndex) {
  clearFindMarks();
  const query = el.findInput.value;
  if (!query || !timelineOpen()) {
    state.findIndex = 0;
    el.findCount.textContent = "(0/0)";
    return;
  }
  const hits = [];
  el.timelineHost.querySelectorAll(".event-row").forEach((row) => {
    collectTextNodes(row).forEach((node) => {
      hits.push(...wrapQueryInNode(node, query));
    });
  });
  state.findHits = hits;
  if (!hits.length) {
    state.findIndex = 0;
    el.findCount.textContent = "(0/0)";
    return;
  }
  if (!keepIndex || state.findIndex >= hits.length) {
    state.findIndex = 0;
  }
  revealFindHit(state.findIndex);
}

function revealFindHit(index) {
  const hits = state.findHits;
  if (!hits.length) {
    el.findCount.textContent = "(0/0)";
    return;
  }
  const i = ((index % hits.length) + hits.length) % hits.length;
  state.findIndex = i;
  hits.forEach((m) => m.classList.remove("current"));
  const mark = hits[i];
  mark.classList.add("current");
  const prompt = mark.closest(".prompt-box");
  if (prompt) prompt.classList.add("expanded");
  mark.scrollIntoView({ block: "center", inline: "nearest" });
  el.findCount.textContent = `(${i}/${hits.length})`;
}

function positionFindBar() {
  const col = document.querySelector(".editor-col");
  if (!col) return;
  const rect = col.getBoundingClientRect();
  const scroller = el.timelineHost;
  const track =
    scroller && !scroller.classList.contains("hidden")
      ? Math.max(0, scroller.offsetWidth - scroller.clientWidth)
      : 0;
  const gutter = track > 0 ? track : 14;
  el.findBar.style.right = `${Math.max(0, window.innerWidth - rect.right + gutter)}px`;
}

function openFind() {
  if (!timelineOpen()) return;
  el.findBar.classList.remove("hidden");
  positionFindBar();
  el.findInput.focus();
  el.findInput.select();
  if (el.findInput.value) runFind(true);
}

function closeFind() {
  el.findBar.classList.add("hidden");
  clearFindMarks();
  state.findIndex = 0;
  el.findCount.textContent = "(0/0)";
}

function renderTabs() {
  el.editorTabs.innerHTML = "";
  for (const tab of state.tabs) {
    const node = document.createElement("div");
    node.className = "tab" + (tab.path === state.activeTab ? " active" : "") + (tab.dirty ? " dirty" : "");
    node.innerHTML = `<span class="dot"></span><span>${escapeHtml(tab.name)}</span><span class="x">×</span>`;
    node.addEventListener("click", (e) => {
      if (e.target.classList.contains("x")) {
        closeTab(tab.path);
        return;
      }
      state.activeTab = tab.path;
      showTab(tab.path);
      refreshChanges();
    });
    el.editorTabs.appendChild(node);
  }
}

function closeTab(filePath) {
  const idx = state.tabs.findIndex((t) => t.path === filePath);
  if (idx < 0) return;
  const tab = state.tabs[idx];
  if (tab.dirty && !confirm(`Discard unsaved changes to ${tab.name}?`)) return;
  const model = monaco.editor.getModel(monaco.Uri.file(filePath));
  if (model) model.dispose();
  state.tabs.splice(idx, 1);
  if (state.activeTab === filePath) {
    const next = state.tabs[idx] || state.tabs[idx - 1];
    state.activeTab = next ? next.path : null;
    if (next) showTab(next.path);
    else {
      if (state.editor) state.editor.setModel(null);
      el.timelineHost.classList.add("hidden");
      el.monacoHost.classList.add("idle");
      el.changesPanel.classList.add("hidden");
      el.workspace.classList.add("fill");
      el.welcome.classList.remove("hidden");
    }
  }
  renderTabs();
  refreshChanges();
}

function highlightTree(filePath) {
  el.fileTree.querySelectorAll(".tree-item").forEach((n) => {
    n.classList.toggle("active", n.dataset.path === filePath);
  });
}

async function loadSessions() {
  if (!state.projectRoot) return;
  el.sessionList.innerHTML = `<div class="empty">Loading sessions…</div>`;
  try {
    const result = await api.listSessions(state.projectRoot);
    state.projectRoot = result.projectRoot || state.projectRoot;
    state.sessions = result.sessions || [];
    renderSessions();
    const newest = state.sessions[0];
    if (newest) {
      await openSession(newest);
    } else {
      await refreshChanges();
    }
  } catch (err) {
    el.sessionList.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
  }
}

function renderSessions() {
  const rows = state.sessions.filter(
    (s) => state.sessionFilter === "all" || s.provider === state.sessionFilter
  );
  if (!rows.length) {
    el.sessionList.innerHTML = `<div class="empty">No Grok <code>updates.jsonl</code> or Claude session logs found for this folder.<br><br>Grok looks in <code>~/.grok/sessions</code>. Claude looks in <code>~/.claude/projects</code>.</div>`;
    return;
  }
  el.sessionList.innerHTML = "";
  for (const session of rows) {
    const node = document.createElement("div");
    node.className =
      "session-row" + (session.path === state.activeSessionPath ? " active" : "");
    node.innerHTML = `
      <div class="row1">
        <span>${escapeHtml(session.title)}</span>
        <span class="badge ${session.provider}">${session.provider}</span>
      </div>
      <div class="row2">${escapeHtml(session.updatedLabel)} · ${formatSize(session.size)} · ${escapeHtml(api.basename(api.dirname(session.path)))}</div>
    `;
    node.addEventListener("click", () => openSession(session));
    el.sessionList.appendChild(node);
  }
}

async function openSession(session) {
  state.activeSessionPath = session.path;
  renderSessions();
  await openInEditor(session.path, { readOnly: true });
}

async function ensureEdits(session) {
  if (state.editsBySession.has(session.path)) {
    return state.editsBySession.get(session.path);
  }
  const edits = await api.parseEdits(session.path, session.provider, state.projectRoot);
  state.editsBySession.set(session.path, edits);
  return edits;
}

async function refreshChanges() {
  const tab = currentTab();
  if (tab && isSessionLog(tab.path)) {
    el.changesPanel.classList.add("hidden");
    el.workspace.classList.add("fill");
    return;
  }
  const session =
    state.sessions.find((s) => s.path === state.activeSessionPath) || state.sessions[0];
  if (!session) {
    el.changesBody.innerHTML = `<div class="empty">Open a project to load session logs.</div>`;
    el.changesMeta.textContent = "";
    return;
  }
  let edits;
  try {
    edits = await ensureEdits(session);
  } catch (err) {
    el.changesBody.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
    return;
  }

  const isSessionFile = tab && /\.jsonl$/i.test(tab.path);
  const currentFile = tab && !isSessionFile ? tab.path : null;
  const filtered = currentFile
    ? edits.filter((e) => pathsEqual(e.path, currentFile) || pathsEqual(e.relPath, relToProject(currentFile)))
    : edits;

  el.changesTitle.textContent = currentFile
    ? `AI changes · ${api.basename(currentFile)}`
    : `AI changes · ${session.provider} session`;
  el.changesMeta.textContent = `${filtered.length} edit${filtered.length === 1 ? "" : "s"} · ${session.title}`;

  if (!filtered.length) {
    el.changesBody.innerHTML = `<div class="empty">${
      currentFile
        ? "No model edits for this file in the selected session."
        : "This session has no file edits (search_replace / Edit / Write)."
    }</div>`;
    return;
  }

  const pairs = [];
  for (const edit of filtered) {
    const id = rememberUpdatePair(edit);
    if (id) pairs.push(state.updatePairs.get(id));
  }
  applyAbsent(await findAbsentIds(pairs));

  el.changesBody.innerHTML = "";
  for (const edit of filtered) {
    const card = document.createElement("div");
    card.className = "change-card";
    const line =
      edit.oldLine || edit.newLine
        ? `line ${edit.oldLine || edit.newLine}`
        : "no line number";
    const pairId = rememberUpdatePair(edit);
    const newId = pairId && edit.newText ? pairId : "";
    card.innerHTML = `
      <header>
        <span>${escapeHtml(edit.relPath || edit.path)} <span class="line-tag">${line}</span></span>
        <span class="muted">${escapeHtml(edit.tool)} · ${edit.provider}</span>
      </header>
      <pre>${renderDiff(edit.oldText, edit.newText, newId)}</pre>
    `;
    const revertId = pairId && edit.oldText ? pairId : "";
    if (revertId) {
      const del = card.querySelector("pre .del");
      if (del) del.insertAdjacentHTML("afterbegin", revertControlHtml(revertId, "old"));
      else {
        const pre = card.querySelector("pre");
        if (pre) pre.insertAdjacentHTML("afterbegin", revertControlHtml(revertId, "old"));
      }
      const add = card.querySelector("pre .add");
      if (add && newId) add.insertAdjacentHTML("afterbegin", revertControlHtml(newId, "new"));
    }
    card.querySelector("header").addEventListener("click", async () => {
      if (edit.path) {
        try {
          await openInEditor(edit.path, { readOnly: false });
          if (state.editor && edit.oldLine) {
            state.editor.revealLineInCenter(edit.oldLine);
            state.editor.setPosition({ lineNumber: edit.oldLine, column: 1 });
          }
        } catch {
          /* file may have moved */
        }
      }
    });
    el.changesBody.appendChild(card);
  }
  paintRevertErrors();
}

function relToProject(abs) {
  const root = (state.projectRoot || "").replace(/\\/g, "/");
  const n = abs.replace(/\\/g, "/");
  if (n.startsWith(root + "/")) return n.slice(root.length + 1);
  return n;
}

function pathsEqual(a, b) {
  if (!a || !b) return false;
  return a.replace(/\\/g, "/") === b.replace(/\\/g, "/");
}

function renderDiff(oldText, newText, newId) {
  const add = (html) => {
    const absent = newId && state.absentNewIds.has(newId) ? " new-absent" : "";
    const attr = newId ? ` data-new-id="${escapeHtml(newId)}"` : "";
    return `<span class="add${absent}"${attr}>${html}</span>`;
  };
  if (!oldText && newText) {
    return add(escapeHtml(newText));
  }
  const oldLines = String(oldText || "").split("\n");
  const newLines = String(newText || "").split("\n");
  const max = Math.max(oldLines.length, newLines.length);
  if (oldLines.join("\n") === newLines.join("\n")) {
    return `<span class="muted">(no textual change)</span>`;
  }
  if (max > 80) {
    const shownOld = oldLines.slice(0, 12).map((l) => `<span class="del">- ${escapeHtml(l)}</span>`).join("\n");
    const shownNew = newLines.slice(0, 12).map((l) => add(`+ ${escapeHtml(l)}`)).join("\n");
    return `${shownOld}\n${shownNew}\n<span class="muted">… truncated</span>`;
  }
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const parts = [];
  for (const line of oldLines) {
    if (!newSet.has(line)) parts.push(`<span class="del">- ${escapeHtml(line)}</span>`);
  }
  for (const line of newLines) {
    if (!oldSet.has(line)) parts.push(add(`+ ${escapeHtml(line)}`));
  }
  return parts.join("\n") || `<span class="muted">(whitespace-only)</span>`;
}

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function saveActive() {
  const tab = currentTab();
  if (!tab || tab.readOnly || !state.editor) return;
  const value = state.editor.getValue();
  await api.writeFile(tab.path, value);
  tab.content = value;
  tab.saved = value;
  tab.dirty = false;
  el.btnSave.disabled = true;
  renderTabs();
}

function bindSplits() {
  document.querySelectorAll(".split-handle").forEach((handle) => {
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const which = handle.dataset.split;
      const pane =
        which === "files"
          ? document.getElementById("filesPane")
          : document.getElementById("sessionsPane");
      const startX = e.clientX;
      const startW = pane.getBoundingClientRect().width;
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const next =
          which === "files" ? startW + dx : startW - dx;
        pane.style.width = `${Math.max(180, Math.min(480, next))}px`;
        positionFindBar();
       };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        positionFindBar();
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
  });
  window.addEventListener("resize", positionFindBar);
  const col = document.querySelector(".editor-col");
  if (typeof ResizeObserver !== "undefined" && col) {
    new ResizeObserver(positionFindBar).observe(col);
  }
}

document.getElementById("btnOpenFolder").addEventListener("click", () => api.openFolder());
document.getElementById("btnWelcomeOpen").addEventListener("click", () => api.openFolder());
document.getElementById("btnOpenFile").addEventListener("click", () => api.openFileDialog());
document.getElementById("btnSave").addEventListener("click", saveActive);
document.getElementById("btnReloadSessions").addEventListener("click", loadSessions);

async function analyzeDeletePayload() {
  const ctx = selDeleteContext();
  if (!ctx) return null;
  const payload = { ext: ctx.ext, text: ctx.text, lines: ctx.lines };
  const fileText = await fileTextForSelection(ctx);
  if (fileText) payload.fileText = fileText;
  if (ctx.range) payload.range = ctx.range;
  return payload;
}

el.selDeleteBtn.addEventListener("mousedown", (e) => {
  e.preventDefault();
});
el.selDeleteBtn.addEventListener("click", async () => {
  const payload = await analyzeDeletePayload();
  if (!payload) return;
  try {
    const result = await api.analyzeHighlightedStatement(payload);
    console.log("analyzeHighlightedStatement", result);
  } catch (err) {
    console.error("analyzeHighlightedStatement failed", err);
  }
});
document.addEventListener("selectionchange", () => {
  if (timelineOpen()) updateSelDeleteBtn();
});

document.querySelectorAll(".session-tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".session-tabs button").forEach((b) => b.classList.remove("on"));
    btn.classList.add("on");
    state.sessionFilter = btn.dataset.filter;
    renderSessions();
  });
});

el.findInput.addEventListener("input", () => runFind(false));
el.findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    if (!state.findHits.length) return;
    revealFindHit(state.findIndex + (e.shiftKey ? -1 : 1));
  }
  if (e.key === "Escape") {
    e.preventDefault();
    closeFind();
  }
});
document.getElementById("findPrev").addEventListener("click", () => {
  if (state.findHits.length) revealFindHit(state.findIndex - 1);
});
document.getElementById("findNext").addEventListener("click", () => {
  if (state.findHits.length) revealFindHit(state.findIndex + 1);
});
document.getElementById("findClose").addEventListener("click", closeFind);

window.addEventListener(
  "keydown",
  (e) => {
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === "f") {
      if (!timelineOpen()) return;
      e.preventDefault();
      e.stopPropagation();
      openFind();
    }
    if (e.key === "Escape" && !el.findBar.classList.contains("hidden")) {
      e.preventDefault();
      closeFind();
    }
    if (e.key === "F3" && !el.findBar.classList.contains("hidden")) {
      e.preventDefault();
      if (state.findHits.length) {
        revealFindHit(state.findIndex + (e.shiftKey ? -1 : 1));
      }
    }
  },
  true
);

api.onProjectOpened((data) => openProject(data.path));
api.onOpenExternalFile((filePath) => openInEditor(filePath, { readOnly: /\.jsonl$/i.test(filePath) }));
api.onSave(saveActive);
api.onReloadSessions(loadSessions);

bindSplits();
document.addEventListener("click", onRevertClick);
document.addEventListener("mousedown", onRevertMouseDown);
initMonaco();
