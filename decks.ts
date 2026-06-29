/**
 * Data model, on-disk storage (editable data/decks.json, mtime-cached), and the
 * result builder that turns cards into a flip-card tool result.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { shuffle, todayISO } from "./scheduling.js";

/** Full FSRS card state (ts-fsrs), persisted so reviews can be reconstructed. */
export type FsrsState = {
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  learning_steps: number;
  state: number;
  last_review?: string;
};

export type Card = {
  front: string;
  back: string;
  due?: string; // YYYY-MM-DD next-due date (derived from FSRS), for ordering + due_today
  srs?: FsrsState; // FSRS scheduling state (absent = never reviewed)
};
export type DeckMap = Record<string, Card[]>;
/** A card slimmed for the UI, tagged with its source deck (for grade/edit/delete routing). */
export type SlimCard = { front: string; back: string; deck: string };
/** A card paired with its source deck, for assembling (possibly multi-deck) sessions. */
export type Tagged = { card: Card; deck: string };

// Resolve project paths whether running from source (tsx) or compiled (dist/decks.js).
const fromSource = import.meta.filename.endsWith(".ts");
const PROJECT_ROOT = fromSource ? import.meta.dirname : path.join(import.meta.dirname, "..");
export const DIST_DIR = fromSource ? path.join(import.meta.dirname, "dist") : import.meta.dirname;
const DECKS_PATH = path.join(PROJECT_ROOT, "data", "decks.json");

/** Used only if data/decks.json is missing or invalid. */
const FALLBACK_DECKS: DeckMap = {
  "Countries & Capitals": [
    { front: "Capital of France?", back: "Paris" },
    { front: "Capital of Japan?", back: "Tokyo" },
  ],
};

function toCard(c: unknown): Card | null {
  if (!c || typeof c !== "object") return null;
  const o = c as Record<string, unknown>;
  if (typeof o.front !== "string" || typeof o.back !== "string") return null;
  const card: Card = { front: o.front, back: o.back };
  if (typeof o.due === "string") card.due = o.due;
  if (o.srs && typeof o.srs === "object" && typeof (o.srs as { stability?: unknown }).stability === "number") {
    card.srs = o.srs as FsrsState;
  }
  return card;
}

/** Parse + validate the deck map, dropping malformed decks/cards. */
export function parseDecks(raw: string): DeckMap {
  const data = JSON.parse(raw) as Record<string, unknown[]>;
  const out: DeckMap = {};
  for (const [name, cards] of Object.entries(data)) {
    if (Array.isArray(cards)) {
      const cleaned = cards.map(toCard).filter((c): c is Card => c !== null);
      if (cleaned.length) out[name] = cleaned;
    }
  }
  return Object.keys(out).length ? out : FALLBACK_DECKS;
}

export function loadDecksSync(): DeckMap {
  try {
    return parseDecks(readFileSync(DECKS_PATH, "utf-8"));
  } catch {
    return FALLBACK_DECKS;
  }
}

let decksCache: { mtimeMs: number; decks: DeckMap } | null = null;

export async function loadDecks(): Promise<DeckMap> {
  try {
    const { mtimeMs } = await fs.stat(DECKS_PATH);
    if (decksCache && decksCache.mtimeMs === mtimeMs) return decksCache.decks;
    const decks = parseDecks(await fs.readFile(DECKS_PATH, "utf-8"));
    decksCache = { mtimeMs, decks };
    return decks;
  } catch {
    return FALLBACK_DECKS;
  }
}

/** Write decks atomically (temp + rename) so concurrent reads never see a partial file. */
export async function saveDecks(decks: DeckMap): Promise<void> {
  const tmp = DECKS_PATH + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(decks, null, 2) + "\n", "utf-8");
  await fs.rename(tmp, DECKS_PATH);
  decksCache = null;
}

/** Order due/overdue/new first, shuffle within each due-date tier, slim to {front,back,deck}. */
export function orderAndSlim(tagged: Tagged[]): SlimCard[] {
  const today = todayISO();
  const tiers = new Map<string, Tagged[]>();
  for (const t of tagged) {
    const key = t.card.due ?? today;
    const tier = tiers.get(key);
    if (tier) tier.push(t);
    else tiers.set(key, [t]);
  }
  const ordered: Tagged[] = [];
  for (const key of [...tiers.keys()].sort()) ordered.push(...shuffle(tiers.get(key)!));
  return ordered.map((t) => ({ front: t.card.front, back: t.card.back, deck: t.deck }));
}

/** Slim a single deck's cards (all from one deck), keeping order. */
export function slimOf(cards: Card[], deck: string): SlimCard[] {
  return cards.map((c) => ({ front: c.front, back: c.back, deck }));
}

/** Build the tool result that renders a (possibly multi-deck) session in the flip-card UI. */
export function deckResult(
  title: string,
  slim: SlimCard[],
  names: string[],
  note: string | undefined,
  dueCount: number,
  newCount: number,
): CallToolResult {
  const text =
    (note ? note + "\n\n" : "") +
    `Deck: ${title} (${slim.length} cards; ${dueCount} due, ${newCount} new)\n` +
    slim.map((c, i) => `${i + 1}. ${c.front}  ->  ${c.back}`).join("\n") +
    `\n\nAvailable decks: ${names.join(", ")}`;
  return {
    content: [{ type: "text", text }],
    structuredContent: { deck: title, count: slim.length, cards: slim, availableDecks: names, dueCount, newCount },
  };
}
