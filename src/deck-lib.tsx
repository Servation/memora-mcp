/**
 * @file Pure helpers and presentational components shared by the Memora UI:
 * result parsing, the deck tree, the tree view, and the card-list view. The
 * stateful review orchestration stays in mcp-app.tsx.
 */
import { useState } from "react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import styles from "./mcp-app.module.css";

export type Card = { front: string; back: string; deck: string; options?: string[] };

export interface DeckData {
  deck: string;
  cards: Card[];
  availableDecks: string[];
  dueCount: number;
  newCount: number;
}

export const EMPTY: DeckData = { deck: "", cards: [], availableDecks: [], dueCount: 0, newCount: 0 };

/** Pull the session out of a tool result, with a text fallback. */
export function extractDeck(result: CallToolResult): DeckData {
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

export type TreeNode = { name: string; path: string; children: TreeNode[]; isDeck: boolean };

/** Build a tree from "::"-separated deck names. */
export function buildTree(names: string[]): TreeNode[] {
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
