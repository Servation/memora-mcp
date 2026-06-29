/**
 * @file Memora flip-card MCP App UI.
 *
 * Review mode: flip a card, grade it (persists a spaced-repetition schedule via
 * grade_card, updates model context); finishing sends a summary so Claude reacts.
 * Browse mode: a scrollable list of all cards; click to jump, delete inline.
 * Cards can be edited/deleted inline; a dropdown switches decks.
 */
import type { App, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import styles from "./mcp-app.module.css";

type Card = { front: string; back: string };
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

/** Pull the deck out of a tool result, with a text fallback. */
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
  const cards: Card[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*\d+\.\s*(.+?)\s*->\s*(.+?)\s*$/);
    if (m) cards.push({ front: m[1], back: m[2] });
  }
  const deck = text.match(/^Deck:\s*(.+?)\s*\(/m)?.[1] ?? "Deck";
  const availableDecks = (text.match(/^Available decks:\s*(.+)$/m)?.[1] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { deck, cards, availableDecks, dueCount: 0, newCount: 0 };
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
  const [view, setView] = useState<"review" | "list">("review");
  const [confirmRow, setConfirmRow] = useState<number | null>(null);

  // Reset whenever a new deck arrives.
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

  const switchDeck = async (name: string) => {
    if (name === deck || busy) return;
    setBusy(true);
    try {
      const r = await app.callServerTool({ name: "review_deck", arguments: { deck_name: name } });
      setResult(r as CallToolResult);
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  const deckSwitcher =
    availableDecks.length > 1 ? (
      <div className={styles.deckSwitcher}>
        <label className={styles.deckSwitcherLabel} htmlFor="deck-select">Deck</label>
        <select
          id="deck-select"
          className={styles.deckSelect}
          value={deck}
          onChange={(e) => switchDeck(e.target.value)}
          disabled={busy}
        >
          {availableDecks.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
      </div>
    ) : null;

  if (cards.length === 0) {
    return (
      <main className={styles.main} style={pad}>
        <p className={styles.hint}>
          Waiting for a deck. Ask Claude to call <code>review_deck</code>.
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
    return `---\ndeck: ${deck}\ngraded: ${graded}\ntotal: ${cards.length}\ncorrect: ${correct}\n---\n\nFlashcard review (live state):\n${rows}`;
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

  /** Remove the card at i locally (stay in place) and persist via delete_card. */
  const removeCardAt = (i: number) => {
    if (cards.length <= 1) return;
    const f = cards[i].front;
    setCards((cs) => cs.filter((_, j) => j !== i));
    setGrades((gs) => gs.filter((_, j) => j !== i));
    setIndex((idx) => Math.min(idx, cards.length - 2));
    setFlipped(false);
    app.callServerTool({ name: "delete_card", arguments: { deck_name: deck, front: f } }).catch(() => {});
  };

  const grade = (correct: boolean) => {
    const card = cards[index];

    const base = grades.length === cards.length ? grades : cards.map(() => undefined);
    const next = base.slice();
    next[index] = correct;
    setGrades(next);
    setFlipped(false);

    app
      .callServerTool({ name: "grade_card", arguments: { deck_name: deck, front: card.front, correct } })
      .catch(() => {});
    app.updateModelContext({ content: [{ type: "text", text: contextMarkdown(next) }] }).catch(() => {});

    const gradedCount = next.filter((g) => g !== undefined).length;
    if (gradedCount === cards.length) {
      setDone(true);
      const correctCount = next.filter((g) => g === true).length;
      const missed = cards.filter((_, i) => next[i] === false).map((c) => `"${c.front}" (${c.back})`);
      const summary = missed.length
        ? `I finished reviewing my "${deck}" deck: ${correctCount} of ${cards.length} correct. I missed: ${missed.join(", ")}. Can you help me drill the ones I missed?`
        : `I finished reviewing my "${deck}" deck with a perfect score: ${correctCount} of ${cards.length}.`;
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
    const original = cards[index].front;
    const newCards = cards.slice();
    newCards[index] = { front: nf, back: nb };
    setCards(newCards);
    setEditing(false);
    app
      .callServerTool({
        name: "edit_card",
        arguments: { deck_name: deck, front: original, new_front: nf, new_back: nb },
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
                  <button
                    className={styles.rowDeleteIcon}
                    onClick={() => setConfirmRow(i)}
                    aria-label="Delete card"
                  >
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
        <button
          className={styles.counterButton}
          onClick={() => setView("list")}
          title="Browse all cards"
        >
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
