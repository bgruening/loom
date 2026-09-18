/**
 * The editor's stylesheet, as text, injected once when the editor attaches.
 *
 * It wants to be `editor/editor.css` next to a `<link>` in `index.html` beside
 * the existing `dashboard/dashboard.css`, and that is what the report asks for.
 * Both of those files belong to the dashboard foundation, and a wave of workers
 * is building on the same base, so shipping the rules with the module that owns
 * them keeps the editor to files nobody else is editing. The page's CSP allows
 * `style-src 'self' 'unsafe-inline'`, and the element is idempotent, so a second
 * attach does not add a second copy.
 *
 * Every custom property used here is defined in `styles.css` already, except
 * `--dash-text-meta`, which `dashboard.css` defines only inside `.dash-panel`
 * -- the toolbar is outside that, so the same value is repeated for it.
 */

export const EDITOR_STYLE_ELEMENT_ID = "dash-editor-styles";

export const EDITOR_STYLES = `
.dash-toolbar.dash-editor {
  --dash-text-meta: rgba(248, 250, 252, 0.72);
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
}

:root[data-theme="light"] .dash-toolbar.dash-editor {
  --dash-text-meta: rgba(31, 41, 55, 0.72);
}

.dash-editor [hidden] {
  display: none !important;
}

.dash-editor-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.dash-editor-spacer {
  flex: 1;
  min-width: 4px;
}

.dash-editor-select {
  appearance: auto;
  flex: 1 1 140px;
  min-width: 0;
  max-width: 260px;
  padding: 4px 6px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--bg-subtle);
  color: var(--text);
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 600;
}

.dash-editor-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--bg-subtle);
  color: var(--text);
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  padding: 5px 9px;
  cursor: pointer;
  white-space: nowrap;
}

.dash-editor-btn:hover:not(:disabled) {
  background: var(--bg-subtle-hover);
  border-color: var(--accent);
  color: var(--accent);
}

.dash-editor-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.dash-editor-btn[aria-pressed="true"] {
  background: var(--accent-bg);
  border-color: var(--accent);
  color: var(--text-bright);
}

.dash-editor-btn-primary {
  border-color: var(--accent);
  background: var(--accent-bg);
  color: var(--text-bright);
}

.dash-editor-btn-quiet {
  border-color: transparent;
  background: transparent;
  color: var(--dash-text-meta);
}

.dash-editor-hint {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  padding: 7px 10px;
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: var(--accent-bg);
  font-size: 11.5px;
  color: var(--text);
}

.dash-editor-hint kbd {
  font-family: var(--font);
  font-size: 10.5px;
  background: var(--bg-deep);
  border: 1px solid var(--border-strong);
  border-bottom-width: 2px;
  border-radius: 3px;
  padding: 0 4px;
  color: var(--text);
}

/* The last thing that happened, in words, next to the control that reverses it. */
.dash-editor-note {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--border-strong);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius);
  background: var(--bg-deep);
  font-size: 11.5px;
  color: var(--text);
}

.dash-editor-note-text {
  flex: 1;
  min-width: 0;
}

/* Inline, in the flow, rather than an overlay: the pane is 280-400px wide and
   a sheet positioned against a scrolling container either scrolls away or
   covers the toolbar that opened it. */
.dash-editor-sheet {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--bg-surface);
}

.dash-editor-sheet-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-bright);
}

.dash-editor-sheet-head-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dash-editor-sheet-detail {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--dash-text-meta);
}

.dash-editor-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.dash-editor-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px;
  max-height: 260px;
  overflow-y: auto;
}

.dash-editor-gallery-card {
  appearance: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
  text-align: left;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-deep);
  color: var(--text);
  font-family: var(--font-sans);
  cursor: pointer;
}

.dash-editor-gallery-card:hover {
  border-color: var(--accent);
  background: var(--bg-hover);
}

.dash-editor-gallery-card b {
  font-size: 12px;
  color: var(--text-bright);
}

.dash-editor-gallery-card small {
  font-size: 11px;
  line-height: 1.4;
  color: var(--dash-text-meta);
}

.dash-editor-gallery-card em {
  font-style: normal;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--success);
}

.dash-editor-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11.5px;
  color: var(--dash-text-meta);
}

.dash-editor-field-row {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.dash-editor-field input[type="text"],
.dash-editor-field input[type="number"],
.dash-editor-field textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 5px 7px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--bg-deep);
  color: var(--text);
  font-family: var(--font-sans);
  font-size: 12px;
}

.dash-editor-field textarea {
  font-family: var(--font);
  font-size: 11px;
  min-height: 84px;
  resize: vertical;
}

.dash-editor-field-label {
  flex: 1;
  min-width: 0;
  color: var(--text);
}

.dash-editor-stepper {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.dash-editor-stepper output {
  min-width: 56px;
  text-align: center;
  font-family: var(--font);
  font-size: 11px;
  color: var(--text);
}

.dash-editor-error {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--text);
  border-left: 3px solid var(--error);
  background: var(--error-bg);
  padding: 5px 8px;
  border-radius: 3px;
}

.dash-editor-live {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

/* ── Panel chrome while editing ──────────────────────────────────────────── */

/* The editor's per-panel buttons exist all the time so that entering edit mode
   does not have to re-render, which would re-mount every widget. */
.dash-root:not(.dash-editing) .dash-panel-tools {
  display: none;
}

/* In edit mode the panel is the thing being operated on, not the widget, and
   the header has room for one set of controls, not two. */
.dash-root.dash-editing .dash-panel-actions {
  display: none;
}

.dash-root.dash-editing .dash-panel {
  border-style: dashed;
  border-color: var(--border-strong);
}

.dash-root.dash-editing .dash-panel:focus-within {
  border-style: solid;
  border-color: var(--accent);
}

.dash-root.dash-editing .dash-panel:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.dash-editor-tool {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--dash-text-meta);
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
}

.dash-editor-tool:hover:not(:disabled) {
  background: var(--bg-subtle-hover);
  color: var(--accent);
}

.dash-editor-tool:disabled {
  opacity: 0.3;
  cursor: default;
}
`;
