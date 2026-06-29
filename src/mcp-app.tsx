/**
 * @file Memora flip-card MCP App UI.
 *
 * Flip a card, grade it Right/Wrong. Each grade:
 *  - calls `grade_card` to persist a spaced-repetition schedule (server side),
 *  - calls `updateModelContext` so the model knows live progress.
 * Finishing the deck calls `sendMessage` so Claude reacts to the score.
 * A deck-picker switches decks via `review_deck` without leaving the UI.
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

/**
 * Pull the deck out of a review_deck/create_deck result: prefer structuredContent,
 * fall back to parsing the text so the UI works even if a host does not forward it.
 */
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
  const { deck, cards, availableDecks, dueCount, newCount } = useMemo(
    () => (result ? extractDeck(result) : EMPTY),
    [result],
  );

  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  // Reset to a fresh review whenever a new deck arrives.
  useEffect(() => {
    setIndex(0);
    setFlipped(false);
    setGrades(cards.map(() => undefined));
    setDone(false);
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

  const deckBar =
    availableDecks.length > 1 ? (
      <div className={styles.deckBar}>
        {availableDecks.map((d) => (
          <button
            key={d}
            className={`${styles.deckPill} ${d === deck ? styles.deckPillActive : ""}`}
            onClick={() => switchDeck(d)}
            disabled={d === deck || busy}
          >
            {d}
          </button>
        ))}
      </div>
    ) : null;

  if (cards.length === 0) {
    return (
      <main className={styles.main} style={pad}>
        <p className={styles.hint}>
          Waiting for a deck. Ask Claude to call <code>review_deck</code>.
        </p>
        {deckBar}
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
  };

  const grade = (correct: boolean) => {
    const card = cards[index];

    const base = grades.length === cards.length ? grades : cards.map(() => undefined);
    const next = base.slice();
    next[index] = correct;
    setGrades(next);
    setFlipped(false);

    // Persist the spaced-repetition schedule for this card (server side).
    app
      .callServerTool({ name: "grade_card", arguments: { deck_name: deck, front: card.front, correct } })
      .catch(() => {});

    // Keep the model aware of live progress (silent).
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
        {deckBar}
      </main>
    );
  }

  const card = cards[index];

  return (
    <main className={styles.main} style={pad}>
      <h3 className={styles.deckTitle}>{deck}</h3>
      <p className={styles.counter}>Card {index + 1} of {cards.length}</p>
      {(dueCount > 0 || newCount > 0) && (
        <p className={styles.schedInfo}>{dueCount} due · {newCount} new</p>
      )}

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

      {deckBar}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MemoraApp />
  </StrictMode>,
);
