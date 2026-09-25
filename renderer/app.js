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
    state.editor.onDidScrollChange(() => updateSelDeleteBtn());
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

function renderTimeline(events) {
  const rows = (events || []).filter((ev) =>
    ["Prompt", "Create", "Edit", "Delete"].includes(ev.operation)
  );
  if (!rows.length) {
    el.timelineHost.innerHTML = `<div class="empty">No create, edit, or delete operations in this session.</div>`;
    return;
  }
  const MAX_DIFF = 48;
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
        const extra = ev.lines.length > MAX_DIFF ? ev.lines.length - MAX_DIFF : 0;
        const shown = ev.lines.slice(0, MAX_DIFF);
        const rows = shown
          .map((line) => {
            const cls = line.type === "add" ? "add" : line.type === "del" ? "del" : "";
            const mark = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
            return `<div class="diff-line ${cls}">${mark} ${escapeHtml(line.text)}</div>`;
          })
          .join("");
        body += `<div class="event-diff">${rows}${
          extra ? `<div class="diff-more">${extra} more lines</div>` : ""
        }</div>`;
      }
      return `<div class="event-row kind-${escapeHtml(ev.kind || "other")}">
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
  if (!el.findBar.classList.contains("hidden") && el.findInput.value) {
    runFind(false);
  }
  el.timelineHost.onscroll = () => updateSelDeleteBtn();
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
  const lineHeight = state.editor.getOption(monaco.editor.EditorOption.lineHeight);
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

function updateSelDeleteBtn() {
  hideSelDelete();
  if (state.selDeleteTimer) {
    clearTimeout(state.selDeleteTimer);
    state.selDeleteTimer = null;
  }
  if (el.welcome && !el.welcome.classList.contains("hidden")) return;
  if (el.monacoHost.classList.contains("idle")) return;
  const top = monacoSelDeleteTop();
  const text = selectedEditorText();
  const ext = state.activeTab ? api.extname(state.activeTab) : "";
  if (top == null || !text.trim()) return;
  const seq = ++state.selDeleteSeq;
  state.selDeleteTimer = setTimeout(async () => {
    try {
      const result = await api.validateHighlight({ ext, text });
      if (seq !== state.selDeleteSeq) return;
      if (!result || !result.ok) return;
      const topNow = monacoSelDeleteTop();
      if (topNow != null) placeSelDelete(topNow);
    } catch {
      /* keep hidden */
    }
  }, 280);
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

  el.changesBody.innerHTML = "";
  for (const edit of filtered) {
    const card = document.createElement("div");
    card.className = "change-card";
    const line =
      edit.oldLine || edit.newLine
        ? `line ${edit.oldLine || edit.newLine}`
        : "no line number";
    card.innerHTML = `
      <header>
        <span>${escapeHtml(edit.relPath || edit.path)} <span class="line-tag">${line}</span></span>
        <span class="muted">${escapeHtml(edit.tool)} · ${edit.provider}</span>
      </header>
      <pre>${renderDiff(edit.oldText, edit.newText)}</pre>
    `;
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

function renderDiff(oldText, newText) {
  if (!oldText && newText) {
    return `<span class="add">${escapeHtml(newText)}</span>`;
  }
  const oldLines = String(oldText || "").split("\n");
  const newLines = String(newText || "").split("\n");
  const max = Math.max(oldLines.length, newLines.length);
  if (oldLines.join("\n") === newLines.join("\n")) {
    return `<span class="muted">(no textual change)</span>`;
  }
  if (max > 80) {
    const shownOld = oldLines.slice(0, 12).map((l) => `<span class="del">- ${escapeHtml(l)}</span>`).join("\n");
    const shownNew = newLines.slice(0, 12).map((l) => `<span class="add">+ ${escapeHtml(l)}</span>`).join("\n");
    return `${shownOld}\n${shownNew}\n<span class="muted">… truncated</span>`;
  }
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const parts = [];
  for (const line of oldLines) {
    if (!newSet.has(line)) parts.push(`<span class="del">- ${escapeHtml(line)}</span>`);
  }
  for (const line of newLines) {
    if (!oldSet.has(line)) parts.push(`<span class="add">+ ${escapeHtml(line)}</span>`);
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

el.selDeleteBtn.addEventListener("mousedown", (e) => {
  e.preventDefault();
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
initMonaco();
