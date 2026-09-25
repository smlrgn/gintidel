# AI Session Editor

Electron editor for a project folder plus the most recent **Grok** and **Claude Code** session logs for that folder.

- **Left:** project file tree
- **Center:** Monaco editor
- **Right:** session logs (`updates.jsonl` for Grok, `<session-id>.jsonl` for Claude)
- **Bottom:** parsed AI file edits (path, starting line, old/new text)

## Run

```bash
npm install
npm start
```

Then **Open folder** and choose a repo. The right pane lists session files under:

| Provider | On disk |
|---|---|
| Grok | `~/.grok/sessions/<url-encoded-cwd>/<session-id>/updates.jsonl` |
| Claude Code | `~/.claude/projects/<dashed-cwd>/<session-id>.jsonl` |

Click a row to open that JSONL in the editor. Open a source file to filter the bottom panel to edits that touched that file.

Session JSONL files are read-only so transcripts are not overwritten.

## Laya ONNX

Selecting code in the editor uses **tree-sitter** (`electron/syntax.js`) to check that the highlight is complete statements/declarations in that language. The Delete button appears only if the span parses cleanly.

Laya ONNX remains in `electron/laya.js` but is not used for this check.
