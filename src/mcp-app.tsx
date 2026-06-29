/**
 * @file Memora flip-card MCP App UI.
 *
 * Flip a card, grade it Right/Wrong, and the grade flows back to the model. Each
 * grade calls `updateModelContext` (silent live state, so the model knows what
 * you are doing in the UI); finishing the deck calls `sendMessage` with a summary
 * so Claude reacts in the conversation (e.g. offers to drill the missed cards).
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

/**
 * Pull the deck out of a review_deck/create_deck result: prefer structuredContent,
 * fall back to parsing the "N. front  ->  back" text so the UI works even if a
 * host does not forward structuredContent.
 */
function extractDeck(result: CallToolResult): { deck: string; cards: Card[] } {
  const sc = (result as { structuredContent?: { deck?: string; cards?: Card[] } })
    .structuredContent;
  if (sc?.cards?.length) return { deck: sc.deck ?? "Deck", cards: sc.cards };

  const text =
    (result.content?.find((c) => c.type === "text") as { text?: string } | undefined)?.text ?? "";
  const cards: Card[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*\d+\.\s*(.+?)\s*->\s*(.+?)\s*$/);
    if (m) cards.push({ front: m[1], back: m[2] });
  }
  const deck = text.match(/^Deck:\s*(.+?)\s*\(/m)?.[1] ?? "Deck";
  return { deck, cards };
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

  return <Deck app={app} result={result} hostContext={hostContext} />;
}

function Deck({
  app,
  result,
  hostContext,
}: {
  app: App;
  result: CallToolResult | null;
  hostContext?: McpUiHostContext;
}) {
  // Parse the deck once per tool result, not on every flip/advance re-render.
  const { deck, cards } = useMemo(
    () => (result ? extractDeck(result) : { deck: "", cards: [] }),
    [result],
  );

  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [done, setDone] = useState(false);

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

  if (cards.length === 0) {
    return (
      <main className={styles.main} style={pad}>
        <p className={styles.hint}>
          Waiting for a deck. Ask Claude to call <code>review_deck</code>.
        </p>
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
    const base = grades.length === cards.length ? grades : cards.map(() => undefined);
    const next = base.slice();
    next[index] = correct;
    setGrades(next);
    setFlipped(false);

    // Silent: keep the model aware of what the user is doing in the UI.
    app.updateModelContext({ content: [{ type: "text", text: contextMarkdown(next) }] }).catch(() => {});

    const gradedCount = next.filter((g) => g !== undefined).length;
    if (gradedCount === cards.length) {
      setDone(true);
      const correctCount = next.filter((g) => g === true).length;
      const missed = cards.filter((_, i) => next[i] === false).map((c) => `"${c.front}" (${c.back})`);
      const summary = missed.length
        ? `I finished reviewing my "${deck}" deck: ${correctCount} of ${cards.length} correct. I missed: ${missed.join(", ")}. Can you help me drill the ones I missed?`
        : `I finished reviewing my "${deck}" deck with a perfect score: ${correctCount} of ${cards.length}.`;
      // Visible: prompt Claude to react to the results in the conversation.
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
        <p className={styles.shared}>Results shared with Claude.</p>
        <div className={styles.controls}>
          <button className={styles.accentBtn} onClick={reset}>Review again</button>
        </div>
      </main>
    );
  }

  const card = cards[index];

  return (
    <main className={styles.main} style={pad}>
      <h3 className={styles.deckTitle}>{deck}</h3>
      <p className={styles.counter}>Card {index + 1} of {cards.length}</p>

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
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MemoraApp />
  </StrictMode>,
);
