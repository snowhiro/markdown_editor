/*
 * Mermaid図 GUI編集ダイアログ。
 * - フローチャート（spec.md 6.1）: DiagramEditorDialog
 * - シーケンス図（spec.md 6.2）: SequenceEditorDialog
 *
 * - キャンバスは常にMermaidの描画結果を表示し、構造変更のたびに再レンダリングする
 *   （座標の永続化はしない。レイアウトはMermaidの自動レイアウトに準拠）
 * - 内部にグラフ／イベント列のモデルを持ち、Mermaidソースへのシリアライズは自前実装
 * - 既存図の読み込みはmermaidのパーサAPI（getDiagramFromText / flowDb・sequenceDb）を
 *   利用し、GUIの対応範囲外の記法を含む場合は編集不可としてEditモードへ誘導する
 */

import mermaid from "mermaid";

// ---- 形状定義（フローチャート） ----

const SHAPES = {
  rect: { open: "[", close: "]", label: "四角" },
  round: { open: "(", close: ")", label: "角丸" },
  stadium: { open: "([", close: "])", label: "スタジアム" },
  diamond: { open: "{", close: "}", label: "菱形" },
  circle: { open: "((", close: "))", label: "円" },
  cylinder: { open: "[(", close: ")]", label: "円柱" },
};

// mermaid flowDbのvertex.type → モデルのshape
const TYPE_TO_SHAPE = {
  undefined: "rect",
  square: "rect",
  round: "round",
  stadium: "stadium",
  diamond: "diamond",
  circle: "circle",
  cylinder: "cylinder",
};

const STROKES = { normal: "実線", dotted: "点線", thick: "太線" };

// ---- パース（Mermaidソース → モデル：フローチャート） ----

function parseFlowchart(diagram) {
  const db = diagram.db;

  if ((db.getSubGraphs?.() ?? []).length > 0) {
    return { ok: false, reason: "subgraphを含む図はGUI編集に対応していません" };
  }
  const classes = db.getClasses?.() ?? {};
  const classCount =
    classes instanceof Map ? classes.size : Object.keys(classes).length;
  if (classCount > 0) {
    return {
      ok: false,
      reason: "classDef（スタイル指定）を含む図はGUI編集に対応していません",
    };
  }

  let direction = db.getDirection?.() || "TB";
  if (direction === "TD") direction = "TB";
  if (!["TB", "BT", "LR", "RL"].includes(direction)) {
    return { ok: false, reason: `対応していない方向指定です: ${direction}` };
  }

  const model = { direction, nodes: [], edges: [] };

  const verticesRaw = db.getVertices();
  const vertices =
    verticesRaw instanceof Map
      ? [...verticesRaw.values()]
      : Object.values(verticesRaw);
  for (const v of vertices) {
    const shape = TYPE_TO_SHAPE[v.type ?? "undefined"];
    if (!shape) {
      return {
        ok: false,
        reason: `対応していないノード形状（${v.type}）が含まれています`,
      };
    }
    const extraClasses = (v.classes ?? []).filter((c) => c && c !== "default");
    if ((v.styles?.length ?? 0) > 0 || extraClasses.length > 0 || v.link) {
      return {
        ok: false,
        reason: "ノードへのスタイル/リンク指定はGUI編集に対応していません",
      };
    }
    model.nodes.push({ id: v.id, label: v.text || v.id, shape });
  }

  for (const e of db.getEdges()) {
    let arrow;
    if (e.type === "arrow_point") arrow = true;
    else if (e.type === "arrow_open") arrow = false;
    else {
      return {
        ok: false,
        reason: `対応していない接続種別（${e.type}）が含まれています`,
      };
    }
    if (!(e.stroke in STROKES)) {
      return {
        ok: false,
        reason: `対応していない線種（${e.stroke}）が含まれています`,
      };
    }
    model.edges.push({
      from: e.start,
      to: e.end,
      label: e.text ?? "",
      style: e.stroke,
      arrow,
    });
  }

  return { ok: true, model };
}

// ---- シリアライズ（モデル → Mermaidソース：フローチャート） ----

function quoteLabel(label) {
  return `"${String(label).replace(/"/g, "#quot;")}"`;
}

function edgeOperator(edge) {
  if (edge.style === "dotted") return edge.arrow ? "-.->" : "-.-";
  if (edge.style === "thick") return edge.arrow ? "==>" : "===";
  return edge.arrow ? "-->" : "---";
}

function serialize(model) {
  const lines = [`flowchart ${model.direction}`];
  for (const n of model.nodes) {
    const s = SHAPES[n.shape];
    lines.push(`    ${n.id}${s.open}${quoteLabel(n.label)}${s.close}`);
  }
  for (const e of model.edges) {
    const op = edgeOperator(e);
    if (e.label) {
      lines.push(`    ${e.from} ${op}|${quoteLabel(e.label)}| ${e.to}`);
    } else {
      lines.push(`    ${e.from} ${op} ${e.to}`);
    }
  }
  return lines.join("\n");
}

// ---- パース（Mermaidソース → モデル：シーケンス図） ----

const SEQ_STROKES = { normal: "実線", dotted: "破線" };

function parseSequence(diagram) {
  const db = diagram.db;

  if (db.hasAtLeastOneBox?.()) {
    return {
      ok: false,
      reason: "box（参加者のグループ化）を含む図はGUI編集に対応していません",
    };
  }
  const created = db.getCreatedActors?.() ?? {};
  const destroyed = db.getDestroyedActors?.() ?? {};
  if (Object.keys(created).length > 0 || Object.keys(destroyed).length > 0) {
    return {
      ok: false,
      reason: "参加者の動的な作成・破棄（create/destroy）はGUI編集に対応していません",
    };
  }

  const actorsMap = db.getActors();
  const actors = [];
  for (const id of db.getActorKeys()) {
    const a = actorsMap[id];
    if (a.type !== "participant" && a.type !== "actor") {
      return {
        ok: false,
        reason: `対応していない参加者種別（${a.type}）が含まれています`,
      };
    }
    if (
      Object.keys(a.links ?? {}).length > 0 ||
      Object.keys(a.properties ?? {}).length > 0
    ) {
      return {
        ok: false,
        reason: "参加者へのリンク・プロパティ指定はGUI編集に対応していません",
      };
    }
    actors.push({ id, label: a.description || id, type: a.type });
  }

  const { LINETYPE, PLACEMENT } = db;
  const items = [];
  for (const m of db.getMessages()) {
    if (m.type === LINETYPE.NOTE) {
      if (m.placement === PLACEMENT.OVER) {
        // Note over A / Note over A,B（複数参加者にまたがる範囲）
        items.push({
          kind: "note",
          actor: m.from,
          endActor: m.to ?? m.from,
          placement: "over",
          text: m.message ?? "",
        });
        continue;
      }
      if (m.placement !== PLACEMENT.LEFTOF && m.placement !== PLACEMENT.RIGHTOF) {
        return {
          ok: false,
          reason: `対応していないNoteの配置指定（${m.placement}）が含まれています`,
        };
      }
      items.push({
        kind: "note",
        actor: m.from,
        placement: m.placement === PLACEMENT.LEFTOF ? "leftof" : "rightof",
        text: m.message ?? "",
      });
      continue;
    }
    if (m.activate) {
      return {
        ok: false,
        reason: "活性化（activate/deactivate）を含む図はGUI編集に対応していません",
      };
    }
    let style;
    let arrow;
    if (m.type === LINETYPE.SOLID) [style, arrow] = ["normal", true];
    else if (m.type === LINETYPE.DOTTED) [style, arrow] = ["dotted", true];
    else if (m.type === LINETYPE.SOLID_OPEN) [style, arrow] = ["normal", false];
    else if (m.type === LINETYPE.DOTTED_OPEN) [style, arrow] = ["dotted", false];
    else {
      return {
        ok: false,
        reason:
          "対応していないメッセージ種別・制御構造（loop/alt/opt/par/activate等）が含まれています",
      };
    }
    items.push({
      kind: "message",
      from: m.from,
      to: m.to,
      label: m.message ?? "",
      style,
      arrow,
    });
  }

  return { ok: true, model: { actors, items } };
}

// ---- シリアライズ（モデル → Mermaidソース：シーケンス図） ----

function seqMessageOperator(style, arrow) {
  if (style === "dotted") return arrow ? "-->>" : "-->";
  return arrow ? "->>" : "->";
}

function sanitizeLine(text) {
  return String(text ?? "").replace(/\r?\n/g, " ");
}

function serializeSequence(model) {
  const lines = ["sequenceDiagram"];
  for (const a of model.actors) {
    const kw = a.type === "actor" ? "actor" : "participant";
    if (a.label && a.label !== a.id) {
      lines.push(`    ${kw} ${a.id} as ${sanitizeLine(a.label)}`);
    } else {
      lines.push(`    ${kw} ${a.id}`);
    }
  }
  for (const item of model.items) {
    if (item.kind === "message") {
      const op = seqMessageOperator(item.style, item.arrow);
      lines.push(`    ${item.from}${op}${item.to}: ${sanitizeLine(item.label)}`);
    } else if (item.placement === "over") {
      const target =
        item.endActor && item.endActor !== item.actor
          ? `${item.actor},${item.endActor}`
          : item.actor;
      lines.push(`    Note over ${target}: ${sanitizeLine(item.text)}`);
    } else {
      const kw = item.placement === "rightof" ? "right of" : "left of";
      lines.push(`    Note ${kw} ${item.actor}: ${sanitizeLine(item.text)}`);
    }
  }
  return lines.join("\n");
}

// ---- 共通 ----

// Mermaidのシーケンス図は矢印先端のSVG marker要素を固定ID
// （arrowhead等）で定義するため、同一文書内に複数の図があるとIDが衝突する。
// url(#id)参照は文書内で最初の同IDに解決されるので、その図が
// display:noneのペイン内にあると矢印の先端が描画されなくなる。
// レンダーごとの接頭辞を付けてIDを一意化することで回避する。
const SEQ_MARKER_IDS = ["arrowhead", "crosshead", "filled-head", "sequencenumber"];

export function localizeSeqMarkerIds(svg, prefix) {
  for (const id of SEQ_MARKER_IDS) {
    svg = svg
      .replaceAll(`id="${id}"`, `id="${prefix}-${id}"`)
      .replaceAll(`url(#${id})`, `url(#${prefix}-${id})`);
  }
  return svg;
}

let renderCounter = 0;

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.25;

// ---- フローチャート ダイアログ ----

const DEFAULT_HINT =
  "クリックで選択 / ドラッグまたは右クリックで接続 / 右クリックで要素を追加・削除 / Cmd/Ctrl+ホイールでズーム / 配置はMermaidの自動レイアウトに従います";

class DiagramEditorDialog {
  constructor(model, resolve) {
    this.model = model;
    this.resolve = resolve;
    this.undoStack = [];
    this.redoStack = [];
    // selection: { kind: "node", id } | { kind: "edge", index } | null
    this.selection = null;
    this._buildDom();
    this._render();
  }

  // ---- DOM構築 ----

  _buildDom() {
    this.overlay = document.createElement("div");
    this.overlay.className = "de-overlay";
    this.overlay.tabIndex = -1;

    const dialog = document.createElement("div");
    dialog.className = "de-dialog";

    // ツールバー
    const bar = document.createElement("div");
    bar.className = "de-toolbar";

    this.addNodeBtn = this._button(bar, "＋ノード", () => this._addNode());

    const dirLabel = document.createElement("span");
    dirLabel.className = "de-label-text";
    dirLabel.textContent = "方向";
    bar.appendChild(dirLabel);
    this.dirSelect = document.createElement("select");
    for (const d of ["TB", "BT", "LR", "RL"]) {
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = d;
      this.dirSelect.appendChild(opt);
    }
    this.dirSelect.value = this.model.direction;
    this.dirSelect.addEventListener("change", () =>
      this._mutate((m) => {
        m.direction = this.dirSelect.value;
      })
    );
    bar.appendChild(this.dirSelect);

    bar.appendChild(this._sep());

    // 選択対象の編集コントロール
    this.selPane = document.createElement("span");
    this.selPane.className = "de-selection";

    this.selType = document.createElement("span");
    this.selType.className = "de-label-text";
    this.selPane.appendChild(this.selType);

    this.labelInput = document.createElement("input");
    this.labelInput.type = "text";
    this.labelInput.placeholder = "ラベル";
    this.labelInput.addEventListener("change", () => this._applyLabel());
    this.labelInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.labelInput.blur();
      e.stopPropagation();
    });
    this.selPane.appendChild(this.labelInput);

    this.shapeSelect = document.createElement("select");
    for (const [key, s] of Object.entries(SHAPES)) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = s.label;
      this.shapeSelect.appendChild(opt);
    }
    this.shapeSelect.addEventListener("change", () => {
      const sel = this.selection;
      if (sel?.kind !== "node") return;
      this._mutate((m) => {
        const n = m.nodes.find((x) => x.id === sel.id);
        if (n) n.shape = this.shapeSelect.value;
      });
    });
    this.selPane.appendChild(this.shapeSelect);

    this.strokeSelect = document.createElement("select");
    for (const [key, label] of Object.entries(STROKES)) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = label;
      this.strokeSelect.appendChild(opt);
    }
    this.strokeSelect.addEventListener("change", () => {
      const sel = this.selection;
      if (sel?.kind !== "edge") return;
      this._mutate((m) => {
        m.edges[sel.index].style = this.strokeSelect.value;
      });
    });
    this.selPane.appendChild(this.strokeSelect);

    this.arrowLabel = document.createElement("label");
    this.arrowLabel.className = "de-arrow-label";
    this.arrowCheck = document.createElement("input");
    this.arrowCheck.type = "checkbox";
    this.arrowCheck.addEventListener("change", () => {
      const sel = this.selection;
      if (sel?.kind !== "edge") return;
      this._mutate((m) => {
        m.edges[sel.index].arrow = this.arrowCheck.checked;
      });
    });
    this.arrowLabel.appendChild(this.arrowCheck);
    this.arrowLabel.appendChild(document.createTextNode("矢印"));
    this.selPane.appendChild(this.arrowLabel);

    this.deleteBtn = this._button(this.selPane, "削除", () =>
      this._deleteSelection()
    );

    bar.appendChild(this.selPane);

    const spacer = document.createElement("span");
    spacer.className = "de-spacer";
    bar.appendChild(spacer);

    this._button(bar, "−", () => this._setZoom(this.zoom / ZOOM_STEP));
    this.zoomLabel = this._button(bar, "100%", () => this._setZoom(1));
    this.zoomLabel.classList.add("de-zoom-label");
    this.zoomLabel.title = "ズームをリセット (Cmd/Ctrl+0)";
    this._button(bar, "＋", () => this._setZoom(this.zoom * ZOOM_STEP));
    bar.appendChild(this._sep());

    this.undoBtn = this._button(bar, "元に戻す", () => this._undo());
    this.redoBtn = this._button(bar, "やり直す", () => this._redo());
    bar.appendChild(this._sep());
    this._button(bar, "キャンセル", () => this._close(null));
    const saveBtn = this._button(bar, "保存", () =>
      this._close(serialize(this.model))
    );
    saveBtn.classList.add("de-primary");

    dialog.appendChild(bar);

    // キャンバス
    this.canvas = document.createElement("div");
    this.canvas.className = "de-canvas";
    dialog.appendChild(this.canvas);

    this.hint = document.createElement("div");
    this.hint.className = "de-hint";
    this.hint.textContent = DEFAULT_HINT;
    dialog.appendChild(this.hint);

    this.overlay.appendChild(dialog);
    document.body.appendChild(this.overlay);

    this.menuEl = null;
    this.pendingConnectFrom = null;
    this.zoom = 1;
    this.svgEl = null;
    this.zoomHolder = null;
    this.baseWidth = 0;
    this.baseHeight = 0;

    this.overlay.addEventListener("keydown", (e) => this._onKeyDown(e));
    this.canvas.addEventListener("mousedown", (e) => this._onCanvasMouseDown(e));
    this.canvas.addEventListener("dblclick", (e) => this._onCanvasDblClick(e));
    this.canvas.addEventListener("contextmenu", (e) => this._onContextMenu(e));
    // Cmd/Ctrl+ホイール（トラックパッドのピンチ含む）でカーソル位置を基準にズーム
    this.canvas.addEventListener(
      "wheel",
      (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        const pivot = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        this._setZoom(this.zoom * factor, pivot);
      },
      { passive: false }
    );

    this.overlay.focus();
  }

  _button(parent, text, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = text;
    btn.addEventListener("click", onClick);
    parent.appendChild(btn);
    return btn;
  }

  _sep() {
    const sep = document.createElement("span");
    sep.className = "de-sep";
    return sep;
  }

  // ---- モデル操作 ----

  _mutate(fn) {
    this.undoStack.push(JSON.stringify(this.model));
    this.redoStack.length = 0;
    fn(this.model);
    this._render();
  }

  _undo() {
    if (this.undoStack.length === 0) return;
    this.redoStack.push(JSON.stringify(this.model));
    this.model = JSON.parse(this.undoStack.pop());
    this.selection = null;
    this._render();
  }

  _redo() {
    if (this.redoStack.length === 0) return;
    this.undoStack.push(JSON.stringify(this.model));
    this.model = JSON.parse(this.redoStack.pop());
    this.selection = null;
    this._render();
  }

  _genId() {
    let i = 1;
    while (this.model.nodes.some((n) => n.id === `n${i}`)) i++;
    return `n${i}`;
  }

  _addNode(shape = "rect") {
    const id = this._genId();
    // 追加時にノードが選択中であれば、そのノードから新規ノードへ
    // 実線の矢印を自動的に追加する（未選択またはエッジ選択中は何もしない）
    const connectFrom =
      this.selection?.kind === "node" ? this.selection.id : null;
    this._mutate((m) => {
      m.nodes.push({ id, label: "新規ノード", shape });
      if (connectFrom) {
        m.edges.push({
          from: connectFrom,
          to: id,
          label: "",
          style: "normal",
          arrow: true,
        });
      }
    });
    this.selection = { kind: "node", id };
    this._applySelection();
  }

  _deleteSelection() {
    const sel = this.selection;
    if (!sel) return;
    this.selection = null;
    if (sel.kind === "node") {
      this._mutate((m) => {
        m.nodes = m.nodes.filter((n) => n.id !== sel.id);
        m.edges = m.edges.filter(
          (e) => e.from !== sel.id && e.to !== sel.id
        );
      });
    } else {
      this._mutate((m) => {
        m.edges.splice(sel.index, 1);
      });
    }
  }

  _applyLabel() {
    const sel = this.selection;
    if (!sel) return;
    const value = this.labelInput.value;
    this._mutate((m) => {
      if (sel.kind === "node") {
        const n = m.nodes.find((x) => x.id === sel.id);
        if (n) n.label = value || n.id;
      } else {
        m.edges[sel.index].label = value;
      }
    });
  }

  // ---- コンテキストメニュー ----

  _onContextMenu(e) {
    e.preventDefault();
    this._closeContextMenu();
    this._endConnectMode();

    const nodeId = this._nodeIdFromElement(e.target);
    const edgeIndex =
      nodeId == null ? this._edgeIndexFromElement(e.target) : null;

    const items = [];
    if (nodeId != null) {
      this.selection = { kind: "node", id: nodeId };
      this._applySelection();
      items.push({
        label: "ここから接続を作成",
        action: () => this._beginConnectMode(nodeId),
      });
      items.push({ label: "ノードを削除", action: () => this._deleteSelection() });
    } else if (edgeIndex != null) {
      this.selection = { kind: "edge", index: edgeIndex };
      this._applySelection();
      items.push({ label: "接続を削除", action: () => this._deleteSelection() });
    } else {
      for (const [key, s] of Object.entries(SHAPES)) {
        items.push({
          label: `${s.label}ノードを追加`,
          action: () => this._addNode(key),
        });
      }
    }
    this._showContextMenu(items, e.clientX, e.clientY);
  }

  _showContextMenu(items, x, y) {
    const menu = document.createElement("div");
    menu.className = "de-context-menu";
    for (const item of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = item.label;
      btn.addEventListener("click", () => {
        this._closeContextMenu();
        item.action();
      });
      menu.appendChild(btn);
    }
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    this.overlay.appendChild(menu);
    this.menuEl = menu;
    // 画面外にはみ出す場合は位置を補正する
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${x - rect.width}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${y - rect.height}px`;

    this._menuCloser = (ev) => {
      if (!menu.contains(ev.target)) this._closeContextMenu();
    };
    document.addEventListener("mousedown", this._menuCloser, true);
  }

  _closeContextMenu() {
    if (!this.menuEl) return;
    this.menuEl.remove();
    this.menuEl = null;
    document.removeEventListener("mousedown", this._menuCloser, true);
  }

  // ---- 接続モード（右クリックメニューから開始） ----

  _beginConnectMode(fromId) {
    this.pendingConnectFrom = fromId;
    this.hint.textContent = "接続先のノードをクリックしてください（Escで中止）";
    this.canvas.classList.add("de-connecting");
  }

  _endConnectMode() {
    if (this.pendingConnectFrom == null) return;
    this.pendingConnectFrom = null;
    this.hint.textContent = DEFAULT_HINT;
    this.canvas.classList.remove("de-connecting");
  }

  // ---- ズーム ----

  _setZoom(newZoom, pivot = null) {
    newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newZoom));
    if (newZoom === this.zoom) return;
    // ピボット（キャンバス内の表示座標。省略時は中央）の内容が
    // ズーム後も同じ位置に見えるようスクロールを補正する
    const c = this.canvas;
    const px = pivot ? pivot.x : c.clientWidth / 2;
    const py = pivot ? pivot.y : c.clientHeight / 2;
    const contentX = (c.scrollLeft + px) / this.zoom;
    const contentY = (c.scrollTop + py) / this.zoom;
    this.zoom = newZoom;
    this._applyZoom();
    c.scrollLeft = contentX * newZoom - px;
    c.scrollTop = contentY * newZoom - py;
  }

  _applyZoom() {
    if (this.svgEl && this.zoomHolder) {
      this.svgEl.style.transform = `scale(${this.zoom})`;
      // ラッパーを拡縮後のサイズに明示的に合わせ、.de-canvasのスクロール領域が
      // 正しく計算されるようにする（transformは自身のレイアウトサイズを変えないため）
      this.zoomHolder.style.width = `${this.baseWidth * this.zoom}px`;
      this.zoomHolder.style.height = `${this.baseHeight * this.zoom}px`;
    }
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
  }

  // ---- キー操作 ----

  _onKeyDown(e) {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === "Escape") {
      if (this.menuEl) {
        this._closeContextMenu();
        return;
      }
      if (this.pendingConnectFrom != null) {
        this._endConnectMode();
        return;
      }
      this._close(null);
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) this._redo();
      else this._undo();
      return;
    }
    if (mod && (e.key === "+" || e.key === "=" || e.key === ";")) {
      e.preventDefault();
      this._setZoom(this.zoom * ZOOM_STEP);
      return;
    }
    if (mod && e.key === "-") {
      e.preventDefault();
      this._setZoom(this.zoom / ZOOM_STEP);
      return;
    }
    if (mod && e.key === "0") {
      e.preventDefault();
      this._setZoom(1);
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && this.selection) {
      e.preventDefault();
      this._deleteSelection();
    }
  }

  // ---- キャンバス操作（選択・ドラッグ接続） ----

  _nodeIdFromElement(el) {
    const g = el.closest("g.node");
    if (!g || !this.canvas.contains(g)) return null;
    // mermaidのノード要素idは flowchart-<nodeId>-<連番> 形式
    const match = /^flowchart-(.+)-\d+$/.exec(g.id);
    return match ? match[1] : null;
  }

  _edgeIndexFromElement(el) {
    const path = el.closest("path.flowchart-link");
    if (!path || !this.canvas.contains(path)) return null;
    const classes = [...path.classList];
    const from = classes.find((c) => c.startsWith("LS-"))?.slice(3);
    const to = classes.find((c) => c.startsWith("LE-"))?.slice(3);
    if (from == null || to == null) return null;
    // 同一ペア間の複数エッジはDOM上の出現順とモデル順が一致する前提で対応付ける
    const samePair = [
      ...this.canvas.querySelectorAll(
        "path.flowchart-link",
      ),
    ].filter(
      (p) => p.classList.contains(`LS-${from}`) && p.classList.contains(`LE-${to}`)
    );
    const occurrence = samePair.indexOf(path);
    let count = -1;
    for (let i = 0; i < this.model.edges.length; i++) {
      const edge = this.model.edges[i];
      if (edge.from === from && edge.to === to) {
        count++;
        if (count === occurrence) return i;
      }
    }
    return null;
  }

  _onCanvasMouseDown(e) {
    if (e.button !== 0) return;
    // 接続モード中: クリックしたノードを接続先として確定する
    if (this.pendingConnectFrom != null) {
      const fromId = this.pendingConnectFrom;
      const targetId = this._nodeIdFromElement(e.target);
      this._endConnectMode();
      if (targetId != null && targetId !== fromId) {
        this._mutate((m) => {
          m.edges.push({
            from: fromId,
            to: targetId,
            label: "",
            style: "normal",
            arrow: true,
          });
        });
        this.selection = { kind: "edge", index: this.model.edges.length - 1 };
        this._applySelection();
      }
      e.preventDefault();
      return;
    }
    const nodeId = this._nodeIdFromElement(e.target);
    if (nodeId != null) {
      e.preventDefault();
      this._beginNodeDrag(nodeId, e);
      return;
    }
    const edgeIndex = this._edgeIndexFromElement(e.target);
    if (edgeIndex != null) {
      this.selection = { kind: "edge", index: edgeIndex };
      this._applySelection();
      return;
    }
    this.selection = null;
    this._applySelection();
  }

  _onCanvasDblClick(e) {
    const nodeId = this._nodeIdFromElement(e.target);
    const edgeIndex = nodeId == null ? this._edgeIndexFromElement(e.target) : null;
    if (nodeId != null) this.selection = { kind: "node", id: nodeId };
    else if (edgeIndex != null) this.selection = { kind: "edge", index: edgeIndex };
    else return;
    this._applySelection();
    this.labelInput.focus();
    this.labelInput.select();
  }

  _beginNodeDrag(nodeId, downEvent) {
    const threshold = 6;
    let dragging = false;
    let line = null;

    const canvasPoint = (ev) => {
      const rect = this.canvas.getBoundingClientRect();
      return {
        x: ev.clientX - rect.left + this.canvas.scrollLeft,
        y: ev.clientY - rect.top + this.canvas.scrollTop,
      };
    };
    const start = canvasPoint(downEvent);

    const onMove = (ev) => {
      const dx = ev.clientX - downEvent.clientX;
      const dy = ev.clientY - downEvent.clientY;
      if (!dragging && Math.hypot(dx, dy) < threshold) return;
      if (!dragging) {
        dragging = true;
        line = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        line.classList.add("de-drag-line");
        line.style.width = `${this.canvas.scrollWidth}px`;
        line.style.height = `${this.canvas.scrollHeight}px`;
        line.innerHTML = `<line x1="${start.x}" y1="${start.y}" x2="${start.x}" y2="${start.y}" />`;
        this.canvas.appendChild(line);
      }
      const p = canvasPoint(ev);
      const seg = line.querySelector("line");
      seg.setAttribute("x2", p.x);
      seg.setAttribute("y2", p.y);
    };

    const onUp = (ev) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (line) line.remove();
      if (!dragging) {
        // クリック: ノードを選択
        this.selection = { kind: "node", id: nodeId };
        this._applySelection();
        return;
      }
      const targetId = this._nodeIdFromElement(ev.target);
      if (targetId != null && targetId !== nodeId) {
        this._mutate((m) => {
          m.edges.push({
            from: nodeId,
            to: targetId,
            label: "",
            style: "normal",
            arrow: true,
          });
        });
        this.selection = { kind: "edge", index: this.model.edges.length - 1 };
        this._applySelection();
      }
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // ---- 描画 ----

  async _render() {
    const source = serialize(this.model);
    const renderId = `de-render-${++renderCounter}`;
    try {
      const { svg } = await mermaid.render(renderId, source);
      // 非標準のCSS zoomプロパティはwidth:100%指定のSVGルート要素の
      // レイアウトサイズに反映されないため、標準のtransform:scaleと
      // サイズ指定ラッパーで拡大縮小を実現する
      this.canvas.innerHTML = `<div class="de-zoom-holder">${svg}</div>`;
      this.zoomHolder = this.canvas.querySelector(".de-zoom-holder");
      this.svgEl = this.zoomHolder.querySelector("svg");
      if (this.svgEl) {
        this.svgEl.style.maxWidth = "none";
        this.svgEl.style.transformOrigin = "0 0";
        // 挿入直後は.de-canvas（flexアイテム）のレイアウトがまだ確定して
        // おらず、その状態でwidth:100%のSVGをgetBoundingClientRect()で
        // 測定すると0になることがある（レイアウトタイミング依存で不安定）。
        // 図の自然な大きさはSVGのviewBoxに直接入っており、コンテナの
        // レイアウト状態に関係なく同期的に取得できるためこちらを使う。
        const viewBox = this.svgEl.viewBox.baseVal;
        const fallback = this.svgEl.getBoundingClientRect();
        this.baseWidth = viewBox.width || fallback.width || 300;
        this.baseHeight = viewBox.height || fallback.height || 150;
        // SVG自身の幅はwidth="100%"属性のままだとホルダー（zoom後のサイズ）の
        // 100%を取ってしまい、続くtransform:scaleと二重に拡縮されてしまう。
        // 自然な大きさに固定し、拡縮は必ずtransformのみで行う。
        this.svgEl.style.width = `${this.baseWidth}px`;
        this.svgEl.style.height = `${this.baseHeight}px`;
        this._applyZoom();
      }
    } catch (err) {
      document.getElementById(renderId)?.remove();
      this.canvas.innerHTML = "";
      this.svgEl = null;
      this.zoomHolder = null;
      const pre = document.createElement("pre");
      pre.className = "mermaid-error";
      pre.textContent = `描画エラー:\n${err?.message ?? err}`;
      this.canvas.appendChild(pre);
    }
    this._applySelection();
  }

  _applySelection() {
    for (const el of this.canvas.querySelectorAll(".de-selected")) {
      el.classList.remove("de-selected");
    }
    let selectedEl = null;
    const sel = this.selection;
    if (sel?.kind === "node") {
      for (const g of this.canvas.querySelectorAll("g.node")) {
        const match = /^flowchart-(.+)-\d+$/.exec(g.id);
        if (match && match[1] === sel.id) {
          g.classList.add("de-selected");
          selectedEl = g;
        }
      }
    } else if (sel?.kind === "edge") {
      const edge = this.model.edges[sel.index];
      if (edge) {
        // モデル上のインデックスをDOM上の同一ペアn番目に対応付ける
        let occurrence = 0;
        for (let i = 0; i < sel.index; i++) {
          if (
            this.model.edges[i].from === edge.from &&
            this.model.edges[i].to === edge.to
          ) {
            occurrence++;
          }
        }
        const paths = [
          ...this.canvas.querySelectorAll("path.flowchart-link"),
        ].filter(
          (p) =>
            p.classList.contains(`LS-${edge.from}`) &&
            p.classList.contains(`LE-${edge.to}`)
        );
        const path = paths[occurrence];
        if (path) {
          path.classList.add("de-selected");
          selectedEl = path;
        }
      }
    }
    // 追加直後のノードが自動レイアウトで画面外（図の末尾）に配置されることが
    // あるため、選択中の要素は常に可視領域へスクロールする
    selectedEl?.scrollIntoView({ block: "nearest", inline: "nearest" });
    this._updateToolbar();
  }

  _updateToolbar() {
    const sel = this.selection;
    this.selPane.style.display = sel ? "inline-flex" : "none";
    this.undoBtn.disabled = this.undoStack.length === 0;
    this.redoBtn.disabled = this.redoStack.length === 0;
    if (!sel) return;
    if (sel.kind === "node") {
      const n = this.model.nodes.find((x) => x.id === sel.id);
      if (!n) return;
      this.selType.textContent = "ノード:";
      this.labelInput.value = n.label;
      this.shapeSelect.value = n.shape;
      this.shapeSelect.style.display = "";
      this.strokeSelect.style.display = "none";
      this.arrowLabel.style.display = "none";
    } else {
      const edge = this.model.edges[sel.index];
      if (!edge) return;
      this.selType.textContent = "接続:";
      this.labelInput.value = edge.label;
      this.shapeSelect.style.display = "none";
      this.strokeSelect.style.display = "";
      this.strokeSelect.value = edge.style;
      this.arrowLabel.style.display = "";
      this.arrowCheck.checked = edge.arrow;
    }
  }

  _close(result) {
    this._closeContextMenu();
    this.overlay.remove();
    this.resolve(result);
  }
}

// ---- シーケンス図 ダイアログ ----

const SEQ_DEFAULT_HINT =
  "クリックで選択 / 参加者を右クリックでメッセージ作成・Note追加 / 空き領域を右クリックで参加者を追加 / サイドリストはドラッグで並べ替え / Cmd/Ctrl+ホイールでズーム";

class SequenceEditorDialog {
  constructor(model, resolve) {
    this.model = model;
    this.resolve = resolve;
    this.undoStack = [];
    this.redoStack = [];
    // selection: { kind: "actor", id } | { kind: "item", index } | null
    this.selection = null;
    this._buildDom();
    this._render();
  }

  // ---- DOM構築 ----

  _buildDom() {
    this.overlay = document.createElement("div");
    this.overlay.className = "de-overlay";
    this.overlay.tabIndex = -1;

    const dialog = document.createElement("div");
    dialog.className = "de-dialog";

    // ツールバー
    const bar = document.createElement("div");
    bar.className = "de-toolbar";

    this._button(bar, "＋参加者", () => this._addActor());
    bar.appendChild(this._sep());

    // 選択対象の編集コントロール
    this.selPane = document.createElement("span");
    this.selPane.className = "de-selection";

    this.selType = document.createElement("span");
    this.selType.className = "de-label-text";
    this.selPane.appendChild(this.selType);

    this.labelInput = document.createElement("input");
    this.labelInput.type = "text";
    this.labelInput.placeholder = "ラベル";
    this.labelInput.addEventListener("change", () => this._applyLabel());
    this.labelInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.labelInput.blur();
      e.stopPropagation();
    });
    this.selPane.appendChild(this.labelInput);

    this.moveLeftBtn = this._button(this.selPane, "←", () => this._moveActor(-1));
    this.moveRightBtn = this._button(this.selPane, "→", () => this._moveActor(1));

    // 参加者の表示種別（participant=四角 / actor=棒人間）
    this.actorTypeSelect = document.createElement("select");
    for (const [key, label] of [
      ["participant", "四角"],
      ["actor", "棒人間"],
    ]) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = label;
      this.actorTypeSelect.appendChild(opt);
    }
    this.actorTypeSelect.addEventListener("change", () => {
      const sel = this.selection;
      if (sel?.kind !== "actor") return;
      this._mutate((m) => {
        const a = m.actors.find((x) => x.id === sel.id);
        if (a) a.type = this.actorTypeSelect.value;
      });
    });
    this.selPane.appendChild(this.actorTypeSelect);

    this.strokeSelect = document.createElement("select");
    for (const [key, label] of Object.entries(SEQ_STROKES)) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = label;
      this.strokeSelect.appendChild(opt);
    }
    this.strokeSelect.addEventListener("change", () => {
      const sel = this.selection;
      if (sel?.kind !== "item") return;
      this._mutate((m) => {
        const item = m.items[sel.index];
        if (item?.kind === "message") item.style = this.strokeSelect.value;
      });
    });
    this.selPane.appendChild(this.strokeSelect);

    this.arrowLabel = document.createElement("label");
    this.arrowLabel.className = "de-arrow-label";
    this.arrowCheck = document.createElement("input");
    this.arrowCheck.type = "checkbox";
    this.arrowCheck.addEventListener("change", () => {
      const sel = this.selection;
      if (sel?.kind !== "item") return;
      this._mutate((m) => {
        const item = m.items[sel.index];
        if (item?.kind === "message") item.arrow = this.arrowCheck.checked;
      });
    });
    this.arrowLabel.appendChild(this.arrowCheck);
    this.arrowLabel.appendChild(document.createTextNode("矢印"));
    this.selPane.appendChild(this.arrowLabel);

    this.placementSelect = document.createElement("select");
    for (const [key, label] of [
      ["leftof", "左に配置"],
      ["rightof", "右に配置"],
      ["over", "上に配置（over）"],
    ]) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = label;
      this.placementSelect.appendChild(opt);
    }
    this.placementSelect.addEventListener("change", () => {
      const sel = this.selection;
      if (sel?.kind !== "item") return;
      this._mutate((m) => {
        const item = m.items[sel.index];
        if (item?.kind !== "note") return;
        item.placement = this.placementSelect.value;
        // overへ切替時は終端を起点と同じ参加者で初期化する
        if (item.placement === "over") {
          if (!item.endActor) item.endActor = item.actor;
        } else {
          delete item.endActor;
        }
      });
    });
    this.selPane.appendChild(this.placementSelect);

    // Note over の範囲の終端参加者（「〜まで」）
    this.noteEndLabel = document.createElement("span");
    this.noteEndLabel.className = "de-label-text";
    this.noteEndLabel.textContent = "〜まで:";
    this.selPane.appendChild(this.noteEndLabel);

    this.noteEndSelect = document.createElement("select");
    this.noteEndSelect.addEventListener("change", () => {
      const sel = this.selection;
      if (sel?.kind !== "item") return;
      this._mutate((m) => {
        const item = m.items[sel.index];
        if (item?.kind === "note" && item.placement === "over") {
          item.endActor = this.noteEndSelect.value;
        }
      });
    });
    this.selPane.appendChild(this.noteEndSelect);

    this.deleteBtn = this._button(this.selPane, "削除", () =>
      this._deleteSelection()
    );

    bar.appendChild(this.selPane);

    const spacer = document.createElement("span");
    spacer.className = "de-spacer";
    bar.appendChild(spacer);

    this._button(bar, "−", () => this._setZoom(this.zoom / ZOOM_STEP));
    this.zoomLabel = this._button(bar, "100%", () => this._setZoom(1));
    this.zoomLabel.classList.add("de-zoom-label");
    this.zoomLabel.title = "ズームをリセット (Cmd/Ctrl+0)";
    this._button(bar, "＋", () => this._setZoom(this.zoom * ZOOM_STEP));
    bar.appendChild(this._sep());

    this.undoBtn = this._button(bar, "元に戻す", () => this._undo());
    this.redoBtn = this._button(bar, "やり直す", () => this._redo());
    bar.appendChild(this._sep());
    this._button(bar, "キャンセル", () => this._close(null));
    const saveBtn = this._button(bar, "保存", () =>
      this._close(serializeSequence(this.model))
    );
    saveBtn.classList.add("de-primary");

    dialog.appendChild(bar);

    // キャンバス + サイドリスト
    const body = document.createElement("div");
    body.className = "de-seq-body";

    this.canvas = document.createElement("div");
    this.canvas.className = "de-canvas";
    body.appendChild(this.canvas);

    this.sideList = document.createElement("div");
    this.sideList.className = "de-seq-list";
    body.appendChild(this.sideList);

    dialog.appendChild(body);

    this.hint = document.createElement("div");
    this.hint.className = "de-hint";
    this.hint.textContent = SEQ_DEFAULT_HINT;
    dialog.appendChild(this.hint);

    this.overlay.appendChild(dialog);
    document.body.appendChild(this.overlay);

    this.menuEl = null;
    this.pendingConnectFrom = null;
    this.pendingConnectAfterSelection = null;
    this.zoom = 1;
    this.svgEl = null;
    this.zoomHolder = null;
    this.baseWidth = 0;
    this.baseHeight = 0;

    this.overlay.addEventListener("keydown", (e) => this._onKeyDown(e));
    this.canvas.addEventListener("mousedown", (e) => this._onCanvasMouseDown(e));
    this.canvas.addEventListener("dblclick", (e) => this._onCanvasDblClick(e));
    this.canvas.addEventListener("contextmenu", (e) => this._onContextMenu(e));
    this.canvas.addEventListener(
      "wheel",
      (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        const pivot = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        this._setZoom(this.zoom * factor, pivot);
      },
      { passive: false }
    );

    this.overlay.focus();
  }

  _button(parent, text, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = text;
    btn.addEventListener("click", onClick);
    parent.appendChild(btn);
    return btn;
  }

  _sep() {
    const sep = document.createElement("span");
    sep.className = "de-sep";
    return sep;
  }

  // ---- モデル操作 ----

  _mutate(fn) {
    this.undoStack.push(JSON.stringify(this.model));
    this.redoStack.length = 0;
    fn(this.model);
    this._render();
  }

  _undo() {
    if (this.undoStack.length === 0) return;
    this.redoStack.push(JSON.stringify(this.model));
    this.model = JSON.parse(this.undoStack.pop());
    this.selection = null;
    this._render();
  }

  _redo() {
    if (this.redoStack.length === 0) return;
    this.undoStack.push(JSON.stringify(this.model));
    this.model = JSON.parse(this.redoStack.pop());
    this.selection = null;
    this._render();
  }

  _genActorId() {
    let i = 1;
    while (this.model.actors.some((a) => a.id === `p${i}`)) i++;
    return `p${i}`;
  }

  _addActor(type = "participant") {
    const id = this._genActorId();
    this._mutate((m) => {
      m.actors.push({ id, label: "参加者", type });
    });
    this.selection = { kind: "actor", id };
    this._applySelection();
  }

  _moveActor(delta) {
    const sel = this.selection;
    if (sel?.kind !== "actor") return;
    this._mutate((m) => {
      const i = m.actors.findIndex((a) => a.id === sel.id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= m.actors.length) return;
      const [a] = m.actors.splice(i, 1);
      m.actors.splice(j, 0, a);
    });
  }

  // 追加時点（＝右クリックでメニューを開いた時点）で何らかのメッセージ/Noteが
  // 選択中であればその直後に挿入し、何も選択されていなければ末尾に追加する。
  // 参加者への右クリックはメニュー表示のために選択状態をその参加者へ変えて
  // しまうため、挿入位置の判定にはメニューを開く前の選択（afterSelection）を使う
  _insertItem(afterSelection, item) {
    let index;
    this._mutate((m) => {
      if (afterSelection?.kind === "item") {
        index = afterSelection.index + 1;
        m.items.splice(index, 0, item);
      } else {
        index = m.items.length;
        m.items.push(item);
      }
    });
    this.selection = { kind: "item", index };
    this._applySelection();
  }

  _deleteSelection() {
    const sel = this.selection;
    if (!sel) return;
    this.selection = null;
    if (sel.kind === "actor") {
      this._deleteActor(sel.id);
    } else {
      this._mutate((m) => {
        m.items.splice(sel.index, 1);
      });
    }
  }

  _deleteActor(id) {
    this._mutate((m) => {
      m.actors = m.actors.filter((a) => a.id !== id);
      m.items = m.items.filter((item) =>
        item.kind === "message" ? item.from !== id && item.to !== id : item.actor !== id
      );
      // Note overの終端だけが削除された場合は起点のみのoverに縮退する
      for (const item of m.items) {
        if (item.kind === "note" && item.endActor === id) {
          item.endActor = item.actor;
        }
      }
    });
  }

  _applyLabel() {
    const sel = this.selection;
    if (!sel) return;
    const value = this.labelInput.value;
    this._mutate((m) => {
      if (sel.kind === "actor") {
        const a = m.actors.find((x) => x.id === sel.id);
        if (a) a.label = value || a.id;
      } else {
        const item = m.items[sel.index];
        if (item.kind === "message") item.label = value;
        else item.text = value;
      }
    });
  }

  _actorLabel(id) {
    return this.model.actors.find((a) => a.id === id)?.label ?? id;
  }

  // ---- コンテキストメニュー ----

  _onContextMenu(e) {
    e.preventDefault();
    this._closeContextMenu();
    this._endConnectMode();

    // メニューを開く前の選択（メッセージ/Noteの挿入位置判定に使う）
    const priorSelection = this.selection;
    const actorId = this._actorIdFromElement(e.target);
    const itemIndex = actorId == null ? this._itemIndexFromElement(e.target) : null;

    const items = [];
    if (actorId != null) {
      this.selection = { kind: "actor", id: actorId };
      this._applySelection();
      items.push({
        label: "ここからメッセージを作成",
        action: () => this._beginConnectMode(actorId, priorSelection),
      });
      items.push({
        label: "Noteを追加",
        action: () =>
          this._insertItem(priorSelection, {
            kind: "note",
            actor: actorId,
            placement: "leftof",
            text: "",
          }),
      });
      items.push({ label: "参加者を削除", action: () => this._deleteActor(actorId) });
    } else if (itemIndex != null) {
      this.selection = { kind: "item", index: itemIndex };
      this._applySelection();
      items.push({ label: "削除", action: () => this._deleteSelection() });
    } else {
      items.push({
        label: "参加者を追加（四角）",
        action: () => this._addActor("participant"),
      });
      items.push({
        label: "参加者を追加（棒人間）",
        action: () => this._addActor("actor"),
      });
    }
    this._showContextMenu(items, e.clientX, e.clientY);
  }

  _showContextMenu(items, x, y) {
    const menu = document.createElement("div");
    menu.className = "de-context-menu";
    for (const item of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = item.label;
      btn.addEventListener("click", () => {
        this._closeContextMenu();
        item.action();
      });
      menu.appendChild(btn);
    }
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    this.overlay.appendChild(menu);
    this.menuEl = menu;
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${x - rect.width}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${y - rect.height}px`;

    this._menuCloser = (ev) => {
      if (!menu.contains(ev.target)) this._closeContextMenu();
    };
    document.addEventListener("mousedown", this._menuCloser, true);
  }

  _closeContextMenu() {
    if (!this.menuEl) return;
    this.menuEl.remove();
    this.menuEl = null;
    document.removeEventListener("mousedown", this._menuCloser, true);
  }

  // ---- 接続モード（メッセージ作成） ----

  _beginConnectMode(fromId, afterSelection) {
    this.pendingConnectFrom = fromId;
    this.pendingConnectAfterSelection = afterSelection;
    this.hint.textContent =
      "宛先の参加者をクリックしてください（同じ参加者なら自己メッセージになります / Escで中止）";
    this.canvas.classList.add("de-connecting");
  }

  _endConnectMode() {
    if (this.pendingConnectFrom == null) return;
    this.pendingConnectFrom = null;
    this.pendingConnectAfterSelection = null;
    this.hint.textContent = SEQ_DEFAULT_HINT;
    this.canvas.classList.remove("de-connecting");
  }

  // ---- ズーム ----

  _setZoom(newZoom, pivot = null) {
    newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newZoom));
    if (newZoom === this.zoom) return;
    const c = this.canvas;
    const px = pivot ? pivot.x : c.clientWidth / 2;
    const py = pivot ? pivot.y : c.clientHeight / 2;
    const contentX = (c.scrollLeft + px) / this.zoom;
    const contentY = (c.scrollTop + py) / this.zoom;
    this.zoom = newZoom;
    this._applyZoom();
    c.scrollLeft = contentX * newZoom - px;
    c.scrollTop = contentY * newZoom - py;
  }

  _applyZoom() {
    if (this.svgEl && this.zoomHolder) {
      this.svgEl.style.transform = `scale(${this.zoom})`;
      this.zoomHolder.style.width = `${this.baseWidth * this.zoom}px`;
      this.zoomHolder.style.height = `${this.baseHeight * this.zoom}px`;
    }
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
  }

  // ---- キー操作 ----

  _onKeyDown(e) {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === "Escape") {
      if (this.menuEl) {
        this._closeContextMenu();
        return;
      }
      if (this.pendingConnectFrom != null) {
        this._endConnectMode();
        return;
      }
      this._close(null);
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) this._redo();
      else this._undo();
      return;
    }
    if (mod && (e.key === "+" || e.key === "=" || e.key === ";")) {
      e.preventDefault();
      this._setZoom(this.zoom * ZOOM_STEP);
      return;
    }
    if (mod && e.key === "-") {
      e.preventDefault();
      this._setZoom(this.zoom / ZOOM_STEP);
      return;
    }
    if (mod && e.key === "0") {
      e.preventDefault();
      this._setZoom(1);
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && this.selection) {
      e.preventDefault();
      this._deleteSelection();
    }
  }

  // ---- キャンバス操作（要素の対応付け・選択） ----

  _actorIdFromElement(el) {
    const rect = el.closest?.("rect.actor");
    if (rect) return rect.getAttribute("name");
    // actor記法（棒人間）はname属性付きの g.actor-man として描画される
    const man = el.closest?.("g.actor-man");
    if (man) return man.getAttribute("name");
    const g = el.closest?.("g");
    const inner = g?.querySelector("rect.actor");
    return inner?.getAttribute("name") ?? null;
  }

  // Mermaidのシーケンス図SVGはメッセージ/Noteの各要素にモデルとの対応付け用
  // 属性を持たないため、要素のy座標（垂直方向＝時系列の位置）でソートして
  // モデルのitems配列の並びと対応付ける
  _visualEvents() {
    const texts = [...this.canvas.querySelectorAll("text.messageText")];
    const lines = [
      ...this.canvas.querySelectorAll(
        "line.messageLine0, line.messageLine1, path.messageLine0, path.messageLine1"
      ),
    ];
    const noteTexts = [...this.canvas.querySelectorAll("text.noteText")];
    const noteRects = [...this.canvas.querySelectorAll("rect.note")];
    const events = [];
    texts.forEach((text, i) => {
      events.push({
        kind: "message",
        text,
        line: lines[i],
        y: parseFloat(text.getAttribute("y") || "0"),
      });
    });
    noteTexts.forEach((text, i) => {
      events.push({
        kind: "note",
        text,
        rect: noteRects[i],
        y: parseFloat(text.getAttribute("y") || "0"),
      });
    });
    events.sort((a, b) => a.y - b.y);
    return events;
  }

  _itemIndexFromElement(el) {
    const matched = el.closest?.(
      "text.messageText, line.messageLine0, line.messageLine1, path.messageLine0, path.messageLine1, rect.note, text.noteText"
    );
    if (!matched) return null;
    const events = this._visualEvents();
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (ev.text === matched || ev.line === matched || ev.rect === matched) {
        return i;
      }
    }
    return null;
  }

  _onCanvasMouseDown(e) {
    if (e.button !== 0) return;
    if (this.pendingConnectFrom != null) {
      const fromId = this.pendingConnectFrom;
      const afterSelection = this.pendingConnectAfterSelection;
      const targetId = this._actorIdFromElement(e.target);
      this._endConnectMode();
      if (targetId != null) {
        this._insertItem(afterSelection, {
          kind: "message",
          from: fromId,
          to: targetId,
          label: "",
          style: "normal",
          arrow: true,
        });
      }
      e.preventDefault();
      return;
    }
    const actorId = this._actorIdFromElement(e.target);
    if (actorId != null) {
      this.selection = { kind: "actor", id: actorId };
      this._applySelection();
      return;
    }
    const itemIndex = this._itemIndexFromElement(e.target);
    if (itemIndex != null) {
      this.selection = { kind: "item", index: itemIndex };
      this._applySelection();
      return;
    }
    this.selection = null;
    this._applySelection();
  }

  _onCanvasDblClick(e) {
    const actorId = this._actorIdFromElement(e.target);
    const itemIndex = actorId == null ? this._itemIndexFromElement(e.target) : null;
    if (actorId != null) this.selection = { kind: "actor", id: actorId };
    else if (itemIndex != null) this.selection = { kind: "item", index: itemIndex };
    else return;
    this._applySelection();
    this.labelInput.focus();
    this.labelInput.select();
  }

  // ---- 描画 ----

  async _render() {
    const source = serializeSequence(this.model);
    const renderId = `de-seq-render-${++renderCounter}`;
    try {
      const { svg } = await mermaid.render(renderId, source);
      this.canvas.innerHTML = `<div class="de-zoom-holder">${localizeSeqMarkerIds(
        svg,
        renderId
      )}</div>`;
      this.zoomHolder = this.canvas.querySelector(".de-zoom-holder");
      this.svgEl = this.zoomHolder.querySelector("svg");
      if (this.svgEl) {
        this.svgEl.style.maxWidth = "none";
        this.svgEl.style.transformOrigin = "0 0";
        const viewBox = this.svgEl.viewBox.baseVal;
        const fallback = this.svgEl.getBoundingClientRect();
        this.baseWidth = viewBox.width || fallback.width || 300;
        this.baseHeight = viewBox.height || fallback.height || 150;
        this.svgEl.style.width = `${this.baseWidth}px`;
        this.svgEl.style.height = `${this.baseHeight}px`;
        this._applyZoom();
      }
    } catch (err) {
      document.getElementById(renderId)?.remove();
      this.canvas.innerHTML = "";
      this.svgEl = null;
      this.zoomHolder = null;
      const pre = document.createElement("pre");
      pre.className = "mermaid-error";
      pre.textContent = `描画エラー:\n${err?.message ?? err}`;
      this.canvas.appendChild(pre);
    }
    this._renderSideList();
    this._applySelection();
  }

  _itemSummary(item) {
    if (item.kind === "message") {
      const op = seqMessageOperator(item.style, item.arrow);
      const label = item.label ? `: ${item.label}` : "";
      return `${this._actorLabel(item.from)} ${op} ${this._actorLabel(item.to)}${label}`;
    }
    if (item.placement === "over") {
      const range =
        item.endActor && item.endActor !== item.actor
          ? `${this._actorLabel(item.actor)}〜${this._actorLabel(item.endActor)}`
          : this._actorLabel(item.actor);
      return `Note（${range}の上）: ${item.text}`;
    }
    const kw = item.placement === "rightof" ? "右" : "左";
    return `Note（${this._actorLabel(item.actor)}の${kw}）: ${item.text}`;
  }

  _renderSideList() {
    this.sideList.innerHTML = "";
    this.model.items.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "de-seq-item";
      row.draggable = true;
      row.textContent = this._itemSummary(item);
      row.addEventListener("click", () => {
        this.selection = { kind: "item", index };
        this._applySelection();
      });
      row.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", String(index));
        e.dataTransfer.effectAllowed = "move";
      });
      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        row.classList.add("de-drag-over");
      });
      row.addEventListener("dragleave", () => row.classList.remove("de-drag-over"));
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        row.classList.remove("de-drag-over");
        const fromIndex = Number(e.dataTransfer.getData("text/plain"));
        if (Number.isNaN(fromIndex) || fromIndex === index) return;
        let insertAt = index;
        this._mutate((m) => {
          const [moved] = m.items.splice(fromIndex, 1);
          if (fromIndex < insertAt) insertAt -= 1;
          m.items.splice(insertAt, 0, moved);
        });
        this.selection = { kind: "item", index: insertAt };
        this._applySelection();
      });
      this.sideList.appendChild(row);
    });
  }

  _applySelection() {
    for (const el of this.canvas.querySelectorAll(".de-selected")) {
      el.classList.remove("de-selected");
    }
    for (const el of this.sideList.querySelectorAll(".de-selected")) {
      el.classList.remove("de-selected");
    }
    let selectedEl = null;
    const sel = this.selection;
    if (sel?.kind === "actor") {
      for (const el of this.canvas.querySelectorAll("rect.actor, g.actor-man")) {
        if (el.getAttribute("name") === sel.id) {
          el.classList.add("de-selected");
          selectedEl = el;
        }
      }
    } else if (sel?.kind === "item") {
      const events = this._visualEvents();
      const ev = events[sel.index];
      if (ev) {
        ev.text.classList.add("de-selected");
        (ev.line ?? ev.rect)?.classList.add("de-selected");
        selectedEl = ev.line ?? ev.rect ?? ev.text;
      }
      const row = this.sideList.children[sel.index];
      row?.classList.add("de-selected");
      row?.scrollIntoView({ block: "nearest" });
    }
    selectedEl?.scrollIntoView({ block: "nearest", inline: "nearest" });
    this._updateToolbar();
  }

  _updateToolbar() {
    const sel = this.selection;
    this.selPane.style.display = sel ? "inline-flex" : "none";
    this.undoBtn.disabled = this.undoStack.length === 0;
    this.redoBtn.disabled = this.redoStack.length === 0;
    this.moveLeftBtn.style.display = "none";
    this.moveRightBtn.style.display = "none";
    this.actorTypeSelect.style.display = "none";
    this.strokeSelect.style.display = "none";
    this.arrowLabel.style.display = "none";
    this.placementSelect.style.display = "none";
    this.noteEndLabel.style.display = "none";
    this.noteEndSelect.style.display = "none";
    if (!sel) return;
    if (sel.kind === "actor") {
      const idx = this.model.actors.findIndex((x) => x.id === sel.id);
      const a = this.model.actors[idx];
      if (!a) return;
      this.selType.textContent = "参加者:";
      this.labelInput.value = a.label;
      this.actorTypeSelect.style.display = "";
      this.actorTypeSelect.value = a.type === "actor" ? "actor" : "participant";
      this.moveLeftBtn.style.display = "";
      this.moveRightBtn.style.display = "";
      this.moveLeftBtn.disabled = idx <= 0;
      this.moveRightBtn.disabled = idx >= this.model.actors.length - 1;
    } else {
      const item = this.model.items[sel.index];
      if (!item) return;
      if (item.kind === "message") {
        this.selType.textContent = "メッセージ:";
        this.labelInput.value = item.label;
        this.strokeSelect.style.display = "";
        this.strokeSelect.value = item.style;
        this.arrowLabel.style.display = "";
        this.arrowCheck.checked = item.arrow;
      } else {
        this.selType.textContent = "Note:";
        this.labelInput.value = item.text;
        this.placementSelect.style.display = "";
        this.placementSelect.value = item.placement;
        if (item.placement === "over") {
          // 終端参加者セレクトを現在の参加者一覧で作り直す
          this.noteEndSelect.innerHTML = "";
          for (const a of this.model.actors) {
            const opt = document.createElement("option");
            opt.value = a.id;
            opt.textContent = a.label;
            this.noteEndSelect.appendChild(opt);
          }
          this.noteEndSelect.value = item.endActor ?? item.actor;
          this.noteEndLabel.style.display = "";
          this.noteEndSelect.style.display = "";
        }
      }
    }
  }

  _close(result) {
    this._closeContextMenu();
    this.overlay.remove();
    this.resolve(result);
  }
}

// ---- 非対応図のメッセージダイアログ ----

function showUnsupportedDialog(reason, resolve) {
  const overlay = document.createElement("div");
  overlay.className = "de-overlay";
  const dialog = document.createElement("div");
  dialog.className = "de-dialog de-message";
  const msg = document.createElement("p");
  msg.textContent = `この図はGUI編集できません。\n${reason}\nEditモードでテキストとして編集してください。`;
  dialog.appendChild(msg);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "閉じる";
  btn.classList.add("de-primary");
  btn.addEventListener("click", () => {
    overlay.remove();
    resolve(null);
  });
  dialog.appendChild(btn);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  btn.focus();
}

// ---- 公開API ----

export function openDiagramEditor(source) {
  return new Promise((resolve) => {
    mermaid.mermaidAPI
      .getDiagramFromText(source)
      .then((diagram) => {
        if (diagram.type === "flowchart-v2" || diagram.type === "flowchart") {
          const result = parseFlowchart(diagram);
          if (!result.ok) {
            showUnsupportedDialog(result.reason, resolve);
            return;
          }
          new DiagramEditorDialog(result.model, resolve);
        } else if (diagram.type === "sequence") {
          const result = parseSequence(diagram);
          if (!result.ok) {
            showUnsupportedDialog(result.reason, resolve);
            return;
          }
          new SequenceEditorDialog(result.model, resolve);
        } else {
          showUnsupportedDialog("この図種はGUI編集に対応していません", resolve);
        }
      })
      .catch((err) => {
        showUnsupportedDialog(
          `構文を解析できません: ${err?.message ?? err}`,
          resolve
        );
      });
  });
}

// デバッグ・検証用
window.DiagramEditor = { open: openDiagramEditor };
