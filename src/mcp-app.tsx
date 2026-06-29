/**
 * @file Memora flip-card MCP App UI.
 *
 * Review: flip + grade (persists FSRS via grade_card). Browse: list of cards.
 * Tree: deck names use "::" as a category tree; tap a category to study its whole
 * subtree (study tool) or a deck to review it. Each card carries its source deck,
 * so grade/edit/delete route correctly even in a merged multi-deck session.
 */
import type { App, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import styles from "./mcp-app.module.css";

type Card = { front: string; back: string; deck: string };
/** true = correct, false = missed, undefined = not graded yet. */
type Grade = boolean | undefined;

interface DeckData {
  deck: string;
  cards: Card[];
  availableDecks: string[];
  dueCount: number;
  newCount: number;
}

const EMPTY: DeckData = { deck: "", cards: [], availableDecks: [], dueCount: 0, newCount: 0 };

/** Pull the session out of a tool result, with a text fallback. */
function extractDeck(result: CallToolResult): DeckData {
  const sc = (
    result as {
      structuredContent?: {
        deck?: string;
        cards?: Card[];
        availableDecks?: string[];
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
  return { deck, cards, availableDecks, dueCount: 0, newCount: 0 };
}

// --- deck tree -----------------------------------------------------------

type TreeNode = { name: string; path: string; children: TreeNode[]; isDeck: boolean };

/** Build a tree from "::"-separated deck names. */
function buildTree(names: string[]): TreeNode[] {
  const roots: TreeNode[] = [];
  for (const full of names) {
    const segs = full.split("::").map((s) => s.trim()).filter(Boolean);
    let level = roots;
    let prefix = "";
    segs.forEach((seg, i) => {
      prefix = prefix ? prefix + "::" + seg : seg;
      let node = level.find((n) => n.name === seg);
      if (!node) {
        node = { name: seg, path: prefix, children: [], isDeck: false };
        level.push(node);
      }
      if (i === segs.length - 1) node.isDeck = true;
      level = node.children;
    });
  }
  return roots;
}

function TreeView({
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

function MemoraApp() {
  const [result, setResult] = useState<CallToolResult | null>(null);
  const [hostContext, setHostContext] = useState<McpUiHostContext | undefined>();

  const { app, error } = useApp({
    appInfo: { name: "Memora Flip Cards", version: "0.1.0" },
    capabilities: {},
    onAppCreated: (app) => {
      app.ontoolresult = async (r) => setResult(r);
      app.onhostcontextchanged = (params) =>
        setHostContext((prev) => ({ ...prev, ...params }));
      app.onerror = console.error;
      app.onteardown = async () => ({});
    },
  });

  useEffect(() => {
    if (app) setHostContext(app.getHostContext());
  }, [app]);

  if (error) return <div><strong>ERROR:</strong> {error.message}</div>;
  if (!app) return <div>Connecting...</div>;

  return <Deck app={app} result={result} setResult={setResult} hostContext={hostContext} />;
}

function Deck({
  app,
  result,
  setResult,
  hostContext,
}: {
  app: App;
  result: CallToolResult | null;
  setResult: (r: CallToolResult) => void;
  hostContext?: McpUiHostContext;
}) {
  const meta = useMemo(() => (result ? extractDeck(result) : EMPTY), [result]);
  const { deck, availableDecks, dueCount, newCount } = meta;

  const [cards, setCards] = useState<Card[]>(meta.cards);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editFront, setEditFront] = useState("");
  const [editBack, setEditBack] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [view, setView] = useState<"review" | "list" | "tree">("review");
  const [confirmRow, setConfirmRow] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    setCards(meta.cards);
    setIndex(0);
    setFlipped(false);
    setGrades(meta.cards.map(() => undefined));
    setDone(false);
    setEditing(false);
    setConfirmingDelete(false);
    setView("review");
    setConfirmRow(null);
  }, [result]);

  const pad = {
    paddingTop: hostContext?.safeAreaInsets?.top,
    paddingRight: hostContext?.safeAreaInsets?.right,
    paddingBottom: hostContext?.safeAreaInsets?.bottom,
    paddingLeft: hostContext?.safeAreaInsets?.left,
  };

  const tree = useMemo(() => buildTree(availableDecks), [availableDecks]);

  const callAndShow = async (name: string, args: Record<string, unknown>) => {
    setBusy(true);
    try {
      const r = await app.callServerTool({ name, arguments: args });
      setResult(r as CallToolResult);
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  const switchDeck = (name: string) => callAndShow("review_deck", { deck_name: name });
  const onPick = (node: TreeNode) =>
    node.children.length > 0
      ? callAndShow("study", { path: node.path })
      : callAndShow("review_deck", { deck_name: node.path });

  const toggleNode = (p: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  const deckSwitcher =
    availableDecks.length > 1 ? (
      <div className={styles.deckSwitcher}>
        <select
          className={styles.deckSelect}
          value={availableDecks.includes(deck) ? deck : ""}
          onChange={(e) => switchDeck(e.target.value)}
          disabled={busy}
        >
          {!availableDecks.includes(deck) && (
            <option value="" disabled>
              Studying: {deck}
            </option>
          )}
          {availableDecks.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <button className={styles.treeBtn} onClick={() => setView("tree")} title="Browse the deck tree">
          Tree
        </button>
      </div>
    ) : null;

  // --- Tree view ---
  if (view === "tree") {
    return (
      <main className={styles.main} style={pad}>
        <h3 className={styles.deckTitle}>Decks</h3>
        <p className={styles.hint}>Tap a category to study its subtree, or a deck to review it.</p>
        <div className={styles.tree}>
          <TreeView nodes={tree} depth={0} expanded={expanded} onToggle={toggleNode} onPick={onPick} busy={busy} />
        </div>
        <div className={styles.controls}>
          <button className={styles.accentBtn} onClick={() => setView("review")}>Back to review</button>
        </div>
      </main>
    );
  }

  if (cards.length === 0) {
    return (
      <main className={styles.main} style={pad}>
        <p className={styles.hint}>
          Waiting for a deck. Ask Claude to call <code>review_deck</code> or <code>study</code>.
        </p>
        {deckSwitcher}
      </main>
    );
  }

  /** YAML-fronted markdown of live progress, for updateModelContext. */
  const contextMarkdown = (gs: Grade[]) => {
    const correct = gs.filter((g) => g === true).length;
    const graded = gs.filter((g) => g !== undefined).length;
    const rows = cards
      .map((c, i) => {
        const mark = gs[i] === true ? "correct" : gs[i] === false ? "missed" : "pending";
        return `- [${mark}] ${c.front} -> ${c.back}`;
      })
      .join("\n");
    return `---\nsession: ${deck}\ngraded: ${graded}\ntotal: ${cards.length}\ncorrect: ${correct}\n---\n\nFlashcard review (live state):\n${rows}`;
  };

  const reset = () => {
    setIndex(0);
    setFlipped(false);
    setGrades(cards.map(() => undefined));
    setDone(false);
    setEditing(false);
  };

  const goTo = (i: number) => {
    setIndex(Math.min(cards.length - 1, Math.max(0, i)));
    setFlipped(false);
    setEditing(false);
    setConfirmingDelete(false);
  };

  /** Remove card i locally (stay in place) and persist via delete_card on its deck. */
  const removeCardAt = (i: number) => {
    if (cards.length <= 1) return;
    const c = cards[i];
    setCards((cs) => cs.filter((_, j) => j !== i));
    setGrades((gs) => gs.filter((_, j) => j !== i));
    setIndex((idx) => Math.min(idx, cards.length - 2));
    setFlipped(false);
    app.callServerTool({ name: "delete_card", arguments: { deck_name: c.deck, front: c.front } }).catch(() => {});
  };

  const grade = (correct: boolean) => {
    const card = cards[index];

    const base = grades.length === cards.length ? grades : cards.map(() => undefined);
    const next = base.slice();
    next[index] = correct;
    setGrades(next);
    setFlipped(false);

    app
      .callServerTool({ name: "grade_card", arguments: { deck_name: card.deck, front: card.front, correct } })
      .catch(() => {});
    app.updateModelContext({ content: [{ type: "text", text: contextMarkdown(next) }] }).catch(() => {});

    const gradedCount = next.filter((g) => g !== undefined).length;
    if (gradedCount === cards.length) {
      setDone(true);
      const correctCount = next.filter((g) => g === true).length;
      const missed = cards.filter((_, i) => next[i] === false).map((c) => `"${c.front}" (${c.back})`);
      const summary = missed.length
        ? `I finished reviewing "${deck}": ${correctCount} of ${cards.length} correct. I missed: ${missed.join(", ")}. Can you help me drill the ones I missed?`
        : `I finished reviewing "${deck}" with a perfect score: ${correctCount} of ${cards.length}.`;
      app.sendMessage({ role: "user", content: [{ type: "text", text: summary }] }).catch(() => {});
    } else {
      setIndex((i) => Math.min(cards.length - 1, i + 1));
    }
  };

  const startEdit = () => {
    setEditFront(cards[index].front);
    setEditBack(cards[index].back);
    setFlipped(false);
    setConfirmingDelete(false);
    setEditing(true);
  };

  const cancelEdit = () => setEditing(false);

  const saveEdit = () => {
    const nf = editFront.trim();
    const nb = editBack.trim();
    if (!nf || !nb) return;
    const orig = cards[index];
    const newCards = cards.slice();
    newCards[index] = { front: nf, back: nb, deck: orig.deck };
    setCards(newCards);
    setEditing(false);
    app
      .callServerTool({
        name: "edit_card",
        arguments: { deck_name: orig.deck, front: orig.front, new_front: nf, new_back: nb },
      })
      .catch(() => {});
  };

  // --- Browse / list view ---
  if (view === "list") {
    return (
      <main className={styles.main} style={pad}>
        <h3 className={styles.deckTitle}>{deck}</h3>
        <p className={styles.counter}>{cards.length} cards</p>
        <ul className={styles.cardList}>
          {cards.map((c, i) => (
            <li key={i} className={styles.cardRow}>
              <button
                className={styles.cardRowMain}
                onClick={() => {
                  setIndex(i);
                  setFlipped(false);
                  setView("review");
                }}
              >
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
                        removeCardAt(i);
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
        <div className={styles.controls}>
          <button className={styles.accentBtn} onClick={() => setView("review")}>Back to review</button>
        </div>
        {deckSwitcher}
      </main>
    );
  }

  if (done) {
    const correct = grades.filter((g) => g === true).length;
    const missed = cards.filter((_, i) => grades[i] === false);
    return (
      <main className={styles.main} style={pad}>
        <h3 className={styles.deckTitle}>{deck}</h3>
        <p className={styles.resultScore}>{correct} / {cards.length} correct</p>
        {missed.length > 0 ? (
          <div className={styles.missedBlock}>
            <p className={styles.hint}>Missed cards:</p>
            <ul className={styles.missedList}>
              {missed.map((c, i) => (
                <li key={i}>{c.front} -&gt; {c.back}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className={styles.hint}>Perfect score.</p>
        )}
        <p className={styles.shared}>Results shared with Claude. Schedules updated.</p>
        <div className={styles.controls}>
          <button className={styles.accentBtn} onClick={reset}>Review again</button>
        </div>
        {deckSwitcher}
      </main>
    );
  }

  const card = cards[index];

  return (
    <main className={styles.main} style={pad}>
      <h3 className={styles.deckTitle}>{deck}</h3>
      <div className={styles.navRow}>
        <button
          className={styles.navArrow}
          onClick={() => goTo(index - 1)}
          disabled={index === 0}
          aria-label="Previous card"
        >
          &#8249;
        </button>
        <button className={styles.counterButton} onClick={() => setView("list")} title="Browse all cards">
          Card {index + 1} of {cards.length}
        </button>
        <button
          className={styles.navArrow}
          onClick={() => goTo(index + 1)}
          disabled={index === cards.length - 1}
          aria-label="Next card"
        >
          &#8250;
        </button>
      </div>
      {(dueCount > 0 || newCount > 0) && (
        <p className={styles.schedInfo}>{dueCount} due &middot; {newCount} new</p>
      )}

      {editing ? (
        <div className={styles.editForm}>
          <label className={styles.editLabel}>Front</label>
          <textarea
            className={styles.editInput}
            rows={2}
            value={editFront}
            onChange={(e) => setEditFront(e.target.value)}
          />
          <label className={styles.editLabel}>Back</label>
          <textarea
            className={styles.editInput}
            rows={2}
            value={editBack}
            onChange={(e) => setEditBack(e.target.value)}
          />
          <div className={styles.editActions}>
            <button className={styles.cancelBtn} onClick={cancelEdit}>Cancel</button>
            <button
              className={styles.saveBtn}
              onClick={saveEdit}
              disabled={!editFront.trim() || !editBack.trim()}
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <>
          <div
            className={styles.scene}
            onClick={() => setFlipped((f) => !f)}
            role="button"
            tabIndex={0}
            aria-label="Flashcard, click to flip"
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setFlipped((f) => !f);
              }
            }}
          >
            <div className={`${styles.card} ${flipped ? styles.cardFlipped : ""}`}>
              <div className={styles.face}>
                <span className={styles.faceLabel}>Front</span>
                {card.front}
              </div>
              <div className={`${styles.face} ${styles.faceBack}`}>
                <span className={styles.faceLabel}>Back</span>
                {card.back}
              </div>
            </div>
          </div>

          {flipped ? (
            <div className={styles.controls}>
              <button className={styles.gradeWrong} onClick={() => grade(false)}>Missed it</button>
              <button className={styles.gradeRight} onClick={() => grade(true)}>Got it</button>
            </div>
          ) : (
            <p className={styles.hint}>Click the card to reveal the answer</p>
          )}

          {confirmingDelete ? (
            <div className={styles.editActions}>
              <button className={styles.cancelBtn} onClick={() => setConfirmingDelete(false)}>Cancel</button>
              <button
                className={styles.dangerBtn}
                onClick={() => {
                  removeCardAt(index);
                  setConfirmingDelete(false);
                }}
              >
                Delete card
              </button>
            </div>
          ) : (
            <div className={styles.cardActions}>
              <button className={styles.editTrigger} onClick={startEdit}>Edit card</button>
              {cards.length > 1 && (
                <button className={styles.editTrigger} onClick={() => setConfirmingDelete(true)}>Delete card</button>
              )}
            </div>
          )}
        </>
      )}

      {deckSwitcher}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MemoraApp />
  </StrictMode>,
);
