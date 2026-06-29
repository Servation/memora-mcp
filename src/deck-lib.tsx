/**
 * @file Pure helpers and presentational components shared by the Memora UI:
 * result parsing, the deck tree, the tree/mind-map views, and the card-list
 * view. The stateful review orchestration stays in mcp-app.tsx.
 */
import { useState, useMemo, type KeyboardEvent } from "react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import styles from "./mcp-app.module.css";

export type Card = { front: string; back: string; deck: string; options?: string[] };

export interface DeckData {
  deck: string;
  cards: Card[];
  availableDecks: string[];
  quizDecks: string[]; // deck names that are multiple-choice quizzes (for the tree/map marker)
  dueCount: number;
  newCount: number;
}

export const EMPTY: DeckData = { deck: "", cards: [], availableDecks: [], quizDecks: [], dueCount: 0, newCount: 0 };

/** Pull the session out of a tool result, with a text fallback. */
export function extractDeck(result: CallToolResult): DeckData {
  const sc = (
    result as {
      structuredContent?: {
        deck?: string;
        cards?: Card[];
        availableDecks?: string[];
        quizDecks?: string[];
        dueCount?: number;
        newCount?: number;
      };
    }
  ).structuredContent;
  if (sc?.cards?.length) {
    return {
      deck: sc.deck ?? "Deck",
      cards: sc.cards,
      availableDecks: sc.availableDecks ?? [],
      quizDecks: sc.quizDecks ?? [],
      dueCount: sc.dueCount ?? 0,
      newCount: sc.newCount ?? 0,
    };
  }

  const text =
    (result.content?.find((c) => c.type === "text") as { text?: string } | undefined)?.text ?? "";
  const deck = text.match(/^Deck:\s*(.+?)\s*\(/m)?.[1] ?? "Deck";
  const cards: Card[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*\d+\.\s*(.+?)\s*->\s*(.+?)\s*$/);
    if (m) cards.push({ front: m[1], back: m[2], deck });
  }
  const availableDecks = (text.match(/^Available decks:\s*(.+)$/m)?.[1] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { deck, cards, availableDecks, quizDecks: [], dueCount: 0, newCount: 0 };
}

// --- deck tree -----------------------------------------------------------

export type TreeNode = { name: string; path: string; children: TreeNode[]; isDeck: boolean; isQuiz: boolean };

/** Build a tree from "::"-separated deck names; mark deck nodes whose path is a quiz. */
export function buildTree(names: string[], quizDecks: Set<string> = new Set()): TreeNode[] {
  const roots: TreeNode[] = [];
  for (const full of names) {
    const segs = full.split("::").map((s) => s.trim()).filter(Boolean);
    let level = roots;
    let prefix = "";
    segs.forEach((seg, i) => {
      prefix = prefix ? prefix + "::" + seg : seg;
      let node = level.find((n) => n.name === seg);
      if (!node) {
        node = { name: seg, path: prefix, children: [], isDeck: false, isQuiz: false };
        level.push(node);
      }
      if (i === segs.length - 1) {
        node.isDeck = true;
        node.isQuiz = quizDecks.has(prefix);
      }
      level = node.children;
    });
  }
  return roots;
}

/** Collapsible deck tree: tap a category to study its subtree, a deck to review it. */
export function TreeView({
  nodes,
  depth,
  expanded,
  onToggle,
  onPick,
  busy,
}: {
  nodes: TreeNode[];
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onPick: (node: TreeNode) => void;
  busy: boolean;
}) {
  return (
    <>
      {nodes.map((node) => {
        const hasChildren = node.children.length > 0;
        const open = expanded.has(node.path);
        return (
          <div key={node.path}>
            <div className={styles.treeRow} style={{ paddingLeft: depth * 16 }}>
              <button
                className={styles.treeToggle}
                onClick={() => hasChildren && onToggle(node.path)}
                aria-label={hasChildren ? (open ? "Collapse" : "Expand") : undefined}
                aria-hidden={!hasChildren}
              >
                {hasChildren ? (open ? "▾" : "▸") : ""}
              </button>
              <button className={styles.treeName} onClick={() => onPick(node)} disabled={busy}>
                {node.name}
                {node.isQuiz && (
                  <span className={styles.quizBadge} title="Multiple-choice quiz">?</span>
                )}
              </button>
            </div>
            {hasChildren && open && (
              <TreeView
                nodes={node.children}
                depth={depth + 1}
                expanded={expanded}
                onToggle={onToggle}
                onPick={onPick}
                busy={busy}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

/** Scrollable list of cards: tap to open, inline-confirm delete. */
export function CardList({
  cards,
  onOpen,
  onDelete,
}: {
  cards: Card[];
  onOpen: (i: number) => void;
  onDelete: (i: number) => void;
}) {
  const [confirmRow, setConfirmRow] = useState<number | null>(null);
  return (
    <ul className={styles.cardList}>
      {cards.map((c, i) => (
        <li key={i} className={styles.cardRow}>
          <button className={styles.cardRowMain} onClick={() => onOpen(i)}>
            <span className={styles.cardRowFront}>{c.front}</span>
            <span className={styles.cardRowBack}>{c.back}</span>
          </button>
          {cards.length > 1 &&
            (confirmRow === i ? (
              <span className={styles.rowConfirm}>
                <button className={styles.rowCancel} onClick={() => setConfirmRow(null)}>Cancel</button>
                <button
                  className={styles.rowDelete}
                  onClick={() => {
                    onDelete(i);
                    setConfirmRow(null);
                  }}
                >
                  Delete
                </button>
              </span>
            ) : (
              <button className={styles.rowDeleteIcon} onClick={() => setConfirmRow(i)} aria-label="Delete card">
                &times;
              </button>
            ))}
        </li>
      ))}
    </ul>
  );
}

/** Multiple-choice question: pick an option, then correct/wrong is revealed. */
export function QuizCard({
  card,
  picked,
  onPick,
}: {
  card: Card;
  picked: string | null;
  onPick: (opt: string) => void;
}) {
  const revealed = picked !== null;
  return (
    <div className={styles.quiz}>
      <div className={styles.quizQuestion}>{card.front}</div>
      <div className={styles.quizOptions}>
        {(card.options ?? []).map((opt, i) => {
          const cls = [
            styles.quizOption,
            revealed && opt === card.back ? styles.quizCorrect : "",
            revealed && opt === picked && opt !== card.back ? styles.quizWrong : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button key={i} className={cls} onClick={() => !revealed && onPick(opt)} disabled={revealed}>
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// --- mind map ------------------------------------------------------------

/**
 * Layout constants for the mind map. Tuned so a column is no wider than its
 * widest clamped label and deep chains stay near the ~440px panel width.
 */
const MAP = {
  rowGap: 16, // vertical gap between sibling rows
  colGap: 36, // horizontal gap between depth columns
  padX: 16,
  padY: 16,
  charW: 7.2, // ~avg char advance at the app text size
  labelPadX: 14, // horizontal padding inside a pill
  dotGap: 12, // extra leading room for the deck dot
  minLabelW: 40,
  maxLabelW: 184, // clamp long names so a column can't widen past the panel
  nodeH: 28,
};

/** Synthetic forest-hub sentinel: emitted only when there is more than one root. */
const SYN_ROOT = "__memora_map_root__";

type MapNode = {
  path: string; // stable key; equals SYN_ROOT for the synthetic hub
  name: string; // full name (for <title> / aria-label)
  text: string; // possibly-truncated label actually drawn
  isDeck: boolean; // reviewable deck -> filled pill + dot
  isQuiz: boolean; // multiple-choice quiz deck -> "?" marker instead of the dot
  synthetic: boolean; // the injected "Decks" hub (not clickable)
  ref: TreeNode | null; // original node for onPick (null for the hub)
  depth: number;
  x: number; // left edge of the pill
  y: number; // vertical centre of the pill
  w: number; // pill width
};
type MapEdge = { from: string; to: string; x1: number; y1: number; x2: number; y2: number };
type MapLayout = { nodes: MapNode[]; edges: MapEdge[]; width: number; height: number; nodeH: number };

/** Truncate a name to fit the clamped pill width (char-budget based). Pure. */
function fitLabel(name: string, hasDot: boolean) {
  const extra = hasDot ? MAP.dotGap : 0;
  const maxTextW = MAP.maxLabelW - MAP.labelPadX * 2 - extra;
  const budget = Math.max(3, Math.floor(maxTextW / MAP.charW));
  const text = name.length <= budget ? name : name.slice(0, budget - 1) + "…";
  const raw = MAP.labelPadX * 2 + extra + text.length * MAP.charW;
  const w = Math.max(MAP.minLabelW, Math.min(MAP.maxLabelW, raw));
  return { text, w };
}

/**
 * Horizontal tidy-tree layout for the mind map (markmap style): depth -> x,
 * leaf-order -> y. Deck names are long, and the panel is width-constrained but
 * vertically free (the page scrolls), so mapping depth to x keeps width bounded
 * by tree depth while fan-out spends the scrollable vertical axis. Non-overlap is
 * guaranteed by a leaf-counting first-walk: a monotonic cursor gives each leaf the
 * next row and centres every parent on its children, so two nodes in one column
 * can never share a y. With more than one root, a synthetic non-clickable "Decks"
 * hub is injected so the forest reads as one connected map.
 */
function layoutMindMap(roots: TreeNode[]): MapLayout {
  if (roots.length === 0) {
    return { nodes: [], edges: [], width: MAP.padX * 2, height: MAP.padY * 2, nodeH: MAP.nodeH };
  }

  const multi = roots.length > 1;
  const hub: TreeNode = { name: "Decks", path: SYN_ROOT, children: roots, isDeck: false, isQuiz: false };
  const tops: TreeNode[] = multi ? [hub] : roots;

  type I = { node: TreeNode; syn: boolean; depth: number; w: number; text: string; children: I[]; y: number };
  const build = (n: TreeNode, depth: number): I => {
    const syn = n.path === SYN_ROOT;
    const { text, w } = fitLabel(n.name, n.isDeck);
    return { node: n, syn, depth, w, text, children: n.children.map((c) => build(c, depth + 1)), y: 0 };
  };
  const forest = tops.map((r) => build(r, 0));

  // 1. column x = cumulative max pill width per depth + gaps
  const colMaxW: number[] = [];
  const scan = (n: I) => {
    colMaxW[n.depth] = Math.max(colMaxW[n.depth] ?? 0, n.w);
    n.children.forEach(scan);
  };
  forest.forEach(scan);
  const colX: number[] = [];
  let acc = MAP.padX;
  for (let d = 0; d < colMaxW.length; d++) {
    colX[d] = acc;
    acc += colMaxW[d] + MAP.colGap;
  }

  // 2. leaf-counting first-walk: monotonic cursor => guaranteed non-overlap
  let cursor = MAP.padY + MAP.nodeH / 2;
  const stepY = MAP.nodeH + MAP.rowGap;
  const firstWalk = (n: I): number => {
    if (n.children.length === 0) {
      n.y = cursor;
      cursor += stepY;
      return n.y;
    }
    const ys = n.children.map(firstWalk);
    n.y = (ys[0] + ys[ys.length - 1]) / 2;
    return n.y;
  };
  forest.forEach(firstWalk); // shared cursor => roots stack without overlap

  // 3. emit nodes + edges, measuring the true extent so nothing is clipped
  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  let maxRight = 0;
  let maxBottom = 0;
  const emit = (n: I) => {
    const x = colX[n.depth];
    nodes.push({
      path: n.node.path,
      name: n.node.name,
      text: n.text,
      isDeck: n.node.isDeck,
      isQuiz: n.node.isQuiz,
      synthetic: n.syn,
      ref: n.syn ? null : n.node,
      depth: n.depth,
      x,
      y: n.y,
      w: n.w,
    });
    maxRight = Math.max(maxRight, x + n.w);
    maxBottom = Math.max(maxBottom, n.y + MAP.nodeH / 2);
    for (const c of n.children) {
      edges.push({ from: n.node.path, to: c.node.path, x1: x + n.w, y1: n.y, x2: colX[c.depth], y2: c.y });
      emit(c);
    }
  };
  forest.forEach(emit);

  return { nodes, edges, width: maxRight + MAP.padX, height: maxBottom + MAP.padY, nodeH: MAP.nodeH };
}

/** Smooth cubic-Bezier connector with horizontal control points (markmap S-curve). */
function edgePath(e: MapEdge): string {
  const mx = (e.x1 + e.x2) / 2;
  return `M ${e.x1} ${e.y1} C ${mx} ${e.y1}, ${mx} ${e.y2}, ${e.x2} ${e.y2}`;
}

/**
 * Mind-map view: the deck tree as a horizontal node-link diagram (pure SVG).
 * Sibling toggle to TreeView with the same onPick/busy contract. Each node is a
 * real role="button" (activates on click / Enter / Space); the visual hierarchy
 * a screen reader can't infer from a flat SVG is carried in each button's
 * aria-label. The synthetic "Decks" hub (multi-root only) is decorative and
 * never reaches onPick (its ref is null).
 */
export function MindMap({
  roots,
  onPick,
  busy,
}: {
  roots: TreeNode[];
  onPick: (node: TreeNode) => void;
  busy: boolean;
}) {
  const lay = useMemo(() => layoutMindMap(roots), [roots]);
  if (lay.nodes.length === 0) return <p className={styles.hint}>No decks yet.</p>;

  const h = lay.nodeH;
  const dotR = 3.5;

  const activate = (n: MapNode) => {
    if (busy || !n.ref) return; // synthetic hub has ref=null => not clickable
    onPick(n.ref);
  };
  const onKey = (e: KeyboardEvent<SVGGElement>, n: MapNode) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate(n);
    }
  };

  return (
    <div className={styles.mapScroll}>
      <svg
        className={styles.mapSvg}
        width={lay.width}
        height={lay.height}
        viewBox={`0 0 ${lay.width} ${lay.height}`}
        role="group"
        aria-label="Deck mind map. Each node is a button; activate to study."
        aria-busy={busy || undefined}
      >
        {/* edges first so nodes paint on top */}
        <g className={styles.mapEdges} fill="none" aria-hidden="true">
          {lay.edges.map((e) => (
            <path key={`${e.from}->${e.to}`} d={edgePath(e)} />
          ))}
        </g>
        {lay.nodes.map((n) => {
          const clickable = !n.synthetic && !busy;
          const cls = [
            styles.mapNode,
            n.synthetic ? styles.mapNodeHub : n.isDeck ? styles.mapNodeDeck : styles.mapNodeCat,
            clickable ? styles.mapNodeClickable : "",
          ]
            .filter(Boolean)
            .join(" ");
          const isDeckNode = n.isDeck && !n.synthetic;
          // leading dot on reviewable decks => label shifts right to make room
          const textX = isDeckNode ? 14 + dotR + 6 : n.w / 2;
          const anchor = isDeckNode ? "start" : "middle";
          return (
            <g
              key={n.path}
              className={cls}
              transform={`translate(${n.x}, ${n.y - h / 2})`}
              role={n.synthetic ? "img" : "button"}
              aria-label={
                n.synthetic
                  ? "Decks"
                  : `${n.name}, ${n.isQuiz ? "quiz" : n.isDeck ? "deck" : "category"}, level ${n.depth + 1}`
              }
              aria-disabled={n.synthetic ? undefined : busy || undefined}
              tabIndex={clickable ? 0 : -1}
              onClick={n.synthetic ? undefined : () => activate(n)}
              onKeyDown={n.synthetic ? undefined : (e) => onKey(e, n)}
            >
              {!n.synthetic && <title>{n.name}</title>}
              <rect className={styles.mapPill} x={0} y={0} rx={h / 2} ry={h / 2} width={n.w} height={h} />
              {isDeckNode &&
                (n.isQuiz ? (
                  <text
                    className={styles.mapQuiz}
                    x={14 + dotR}
                    y={h / 2}
                    textAnchor="middle"
                    dominantBaseline="central"
                    aria-hidden="true"
                  >
                    ?
                  </text>
                ) : (
                  <circle className={styles.mapDot} cx={14 + dotR} cy={h / 2} r={dotR} aria-hidden="true" />
                ))}
              <text
                className={styles.mapLabel}
                x={textX}
                y={h / 2}
                textAnchor={anchor}
                dominantBaseline="central"
                aria-hidden="true"
              >
                {n.text}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
