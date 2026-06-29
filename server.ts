/**
 * Memora MCP server.
 *
 * Decks live in editable data/decks.json, read live (mtime-cached) on every call.
 * - review_deck: show a deck as an interactive flip-card review (due cards first).
 * - create_deck: Claude generates cards from the request/conversation; persist + render.
 * - grade_card: the UI records a spaced-repetition result for one card (SM-2-lite),
 *   persisting due/interval/ease/reps back to decks.json.
 * All review/create results link the same flip-card ui:// view.
 */
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fsrs, generatorParameters, createEmptyCard, Rating, type Card as FsrsCard } from "ts-fsrs";

/** A flashcard. The optional fields hold spaced-repetition state (absent = new card). */
/** Full FSRS card state (ts-fsrs), persisted so reviews can be reconstructed. */
type FsrsState = {
  due: string; // ISO datetime
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  learning_steps: number;
  state: number; // ts-fsrs State (0 New, 1 Learning, 2 Review, 3 Relearning)
  last_review?: string; // ISO datetime
};

type Card = {
  front: string;
  back: string;
  due?: string; // YYYY-MM-DD next-due date (derived from FSRS), for ordering + due_today
  srs?: FsrsState; // FSRS scheduling state (absent = never reviewed)
};
type DeckMap = Record<string, Card[]>;

/** The flip-card UI resource. Built by `npm run build:ui` into dist/mcp-app.html. */
const RESOURCE_URI = "ui://memora/review-deck.html";

/** Hard cap so a single create_deck call can never write a pathological file. */
const MAX_CARDS = 1000;

// Resolve project paths whether running from source (tsx) or compiled (dist/server.js).
const fromSource = import.meta.filename.endsWith(".ts");
const PROJECT_ROOT = fromSource ? import.meta.dirname : path.join(import.meta.dirname, "..");
const DIST_DIR = fromSource ? path.join(import.meta.dirname, "dist") : import.meta.dirname;
const DECKS_PATH = path.join(PROJECT_ROOT, "data", "decks.json");

/** Used only if data/decks.json is missing or invalid. */
const FALLBACK_DECKS: DeckMap = {
  "Countries & Capitals": [
    { front: "Capital of France?", back: "Paris" },
    { front: "Capital of Japan?", back: "Tokyo" },
  ],
};

/** Shared structured-output shape for review_deck / create_deck. */
const DECK_OUTPUT = {
  deck: z.string(),
  count: z.number(),
  cards: z.array(z.object({ front: z.string(), back: z.string() })),
  availableDecks: z.array(z.string()),
  dueCount: z.number(),
  newCount: z.number(),
};

// --- spaced repetition (FSRS via ts-fsrs) --------------------------------

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// Day-scale scheduling for a once-a-day study loop: no short same-day learning steps.
const scheduler = fsrs(
  generatorParameters({ enable_fuzz: false, learning_steps: [], relearning_steps: [] }),
);

/** Reconstruct a ts-fsrs Card from stored state, or a fresh one. */
function toFsrsCard(card: Card, now: Date): FsrsCard {
  const s = card.srs;
  if (!s) return createEmptyCard(now);
  return {
    due: new Date(s.due),
    stability: s.stability,
    difficulty: s.difficulty,
    elapsed_days: s.elapsed_days,
    scheduled_days: s.scheduled_days,
    reps: s.reps,
    lapses: s.lapses,
    learning_steps: s.learning_steps,
    state: s.state,
    last_review: s.last_review ? new Date(s.last_review) : undefined,
  } as FsrsCard;
}

/** Apply one review result with FSRS, returning a NEW card with updated schedule. */
function schedule(card: Card, correct: boolean): Card {
  const now = new Date();
  const { card: next } = scheduler.next(
    toFsrsCard(card, now),
    now,
    correct ? Rating.Good : Rating.Again,
  );
  const srs: FsrsState = {
    due: next.due.toISOString(),
    stability: Math.round(next.stability * 1000) / 1000,
    difficulty: Math.round(next.difficulty * 1000) / 1000,
    elapsed_days: next.elapsed_days,
    scheduled_days: next.scheduled_days,
    reps: next.reps,
    lapses: next.lapses,
    learning_steps: next.learning_steps,
    state: next.state,
    last_review: next.last_review ? next.last_review.toISOString() : now.toISOString(),
  };
  return { front: card.front, back: card.back, due: next.due.toISOString().slice(0, 10), srs };
}

// --- deck storage --------------------------------------------------------

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
function parseDecks(raw: string): DeckMap {
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

function loadDecksSync(): DeckMap {
  try {
    return parseDecks(readFileSync(DECKS_PATH, "utf-8"));
  } catch {
    return FALLBACK_DECKS;
  }
}

// In-process cache, invalidated by file mtime so live edits are still picked up
// without re-reading + re-parsing the file on every single tool call.
let decksCache: { mtimeMs: number; decks: DeckMap } | null = null;

async function loadDecks(): Promise<DeckMap> {
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
async function saveDecks(decks: DeckMap): Promise<void> {
  const tmp = DECKS_PATH + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(decks, null, 2) + "\n", "utf-8");
  await fs.rename(tmp, DECKS_PATH);
  decksCache = null; // force a fresh read on next load
}

/** Build the tool result that renders a deck in the flip-card UI. */
function deckResult(
  deck: string,
  cards: Card[],
  names: string[],
  note: string | undefined,
  dueCount: number,
  newCount: number,
): CallToolResult {
  const slim = cards.map((c) => ({ front: c.front, back: c.back }));
  const text =
    (note ? note + "\n\n" : "") +
    `Deck: ${deck} (${slim.length} cards; ${dueCount} due, ${newCount} new)\n` +
    slim.map((c, i) => `${i + 1}. ${c.front}  ->  ${c.back}`).join("\n") +
    `\n\nAvailable decks: ${names.join(", ")}`;
  return {
    content: [{ type: "text", text }],
    structuredContent: { deck, count: slim.length, cards: slim, availableDecks: names, dueCount, newCount },
  };
}

/**
 * Creates the Memora MCP server with review_deck + create_deck + grade_card and the flip-card UI.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: "Memora MCP", version: "0.1.0" });

  const startupDecks = Object.keys(loadDecksSync());

  // review_deck: show an existing deck, due cards first.
  registerAppTool(
    server,
    "review_deck",
    {
      title: "Review Deck",
      description:
        "Return the flashcards of a Memora deck and display them as an interactive " +
        "flip-card review, with due cards first. Available decks: " +
        startupDecks.map((d) => `"${d}"`).join(", ") +
        ". Decks are read live from data/decks.json.",
      inputSchema: {
        deck_name: z
          .string()
          .optional()
          .describe("Deck to review. Omit or pass an unknown name to get the first available deck."),
      },
      outputSchema: DECK_OUTPUT,
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ deck_name }): Promise<CallToolResult> => {
      const decks = await loadDecks();
      const names = Object.keys(decks);
      const name = deck_name && decks[deck_name] ? deck_name : names[0];
      const all = decks[name];
      const today = todayISO();
      const dueCount = all.filter((c) => c.due && c.due <= today).length;
      const newCount = all.filter((c) => !c.due).length;
      // Due / overdue / new first (new cards have no due date, sorted as "today").
      const ordered = [...all].sort((a, b) => {
        const ad = a.due ?? today;
        const bd = b.due ?? today;
        return ad < bd ? -1 : ad > bd ? 1 : 0;
      });
      return deckResult(name, ordered, names, undefined, dueCount, newCount);
    },
  );

  // create_deck: Claude generates cards from the request/conversation; persist + render them.
  registerAppTool(
    server,
    "create_deck",
    {
      title: "Create Deck",
      description:
        "Create (or extend) a flashcard deck from cards you generate based on the user's " +
        "request or the current conversation, then display it for review. The deck persists " +
        "to data/decks.json and can be reopened later with review_deck.\n\n" +
        "Follow Memora's card-quality rules (based on Wozniak's '20 Rules of Formulating " +
        "Knowledge'). The front is the prompt/question, the back is the answer:\n" +
        "1. Minimum information (atomic): each card tests exactly one fact or concept. Split " +
        "complex material into several simple cards; never ask for lists or paragraph answers.\n" +
        "2. Concise answers: the back is ideally 1-5 words (a name, date, term, or single " +
        "concept), never a sentence or paragraph.\n" +
        "3. Active recall: make the front a specific question (not 'Explain X'), or a cloze " +
        "deletion with the hidden term in [brackets] on the front and that term as the back.\n" +
        "4. Unambiguous: each front must point to exactly one correct answer.",
      inputSchema: {
        deck_name: z.string().describe("Name for the deck to create or add to."),
        cards: z
          .array(z.object({ front: z.string(), back: z.string() }))
          .describe("Flashcards generated from the user's request or the conversation."),
        append: z
          .boolean()
          .optional()
          .describe("If true and the deck already exists, append to it; otherwise replace/create."),
      },
      outputSchema: DECK_OUTPUT,
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ deck_name, cards, append }): Promise<CallToolResult> => {
      const clean: Card[] = (cards ?? [])
        .filter((c) => c && typeof c.front === "string" && typeof c.back === "string")
        .map((c) => ({ front: c.front.trim(), back: c.back.trim() }))
        .filter((c) => c.front && c.back)
        .slice(0, MAX_CARDS);

      if (!deck_name?.trim() || clean.length === 0) {
        return {
          isError: true,
          content: [
            { type: "text", text: "Provide a deck_name and at least one {front, back} card." },
          ],
        };
      }

      const decks = await loadDecks();
      const existing = decks[deck_name] ?? [];
      const merged = (append ? [...existing, ...clean] : clean).slice(0, MAX_CARDS);
      await saveDecks({ ...decks, [deck_name]: merged });

      const names = Object.keys({ ...decks, [deck_name]: merged });
      const today = todayISO();
      const dueCount = merged.filter((c) => c.due && c.due <= today).length;
      const newCount = merged.filter((c) => !c.due).length;
      const note = `Saved deck "${deck_name}" with ${merged.length} card(s).`;
      return deckResult(deck_name, merged, names, note, dueCount, newCount);
    },
  );

  // grade_card: app-only. The flip-card UI calls this to persist a spaced-repetition result.
  registerAppTool(
    server,
    "grade_card",
    {
      title: "Grade Card",
      description:
        "Record a spaced-repetition review result for a single card and update its schedule " +
        "in data/decks.json. Called by the flip-card UI; not intended for direct model use.",
      inputSchema: {
        deck_name: z.string().describe("Deck the card belongs to."),
        front: z.string().describe("The card's front text (identifies the card)."),
        correct: z.boolean().describe("Whether the user got the card right."),
      },
      _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ["app"] } },
    },
    async ({ deck_name, front, correct }): Promise<CallToolResult> => {
      const decks = await loadDecks();
      const cards = decks[deck_name];
      if (!cards) {
        return { isError: true, content: [{ type: "text", text: `Deck "${deck_name}" not found.` }] };
      }
      const idx = cards.findIndex((c) => c.front === front);
      if (idx < 0) {
        return { isError: true, content: [{ type: "text", text: `Card not found in "${deck_name}".` }] };
      }
      const updated = schedule(cards[idx], correct);
      const newCards = cards.slice();
      newCards[idx] = updated;
      await saveDecks({ ...decks, [deck_name]: newCards });
      return {
        content: [
          {
            type: "text",
            text: `Scheduled "${front}" -> due ${updated.due} (reps ${updated.srs?.reps ?? 0}, ${updated.srs?.scheduled_days ?? 0}d).`,
          },
        ],
      };
    },
  );

  // edit_card: change a card's front and/or back (identified by its current front).
  registerAppTool(
    server,
    "edit_card",
    {
      title: "Edit Card",
      description:
        "Edit a card's front and/or back in a deck, identified by its current front text, " +
        "then re-render the deck. Use this to fix wording or correct an answer. Keep edits " +
        "within Memora's card-quality rules (atomic, concise 1-5 word answers, unambiguous).",
      inputSchema: {
        deck_name: z.string().describe("Deck the card belongs to."),
        front: z.string().describe("The card's CURRENT front text (identifies the card to edit)."),
        new_front: z.string().optional().describe("New front text. Omit to keep the current front."),
        new_back: z.string().optional().describe("New back text. Omit to keep the current back."),
      },
      outputSchema: DECK_OUTPUT,
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ deck_name, front, new_front, new_back }): Promise<CallToolResult> => {
      const decks = await loadDecks();
      const cards = decks[deck_name];
      if (!cards) {
        return { isError: true, content: [{ type: "text", text: `Deck "${deck_name}" not found.` }] };
      }
      const idx = cards.findIndex((c) => c.front === front);
      if (idx < 0) {
        return { isError: true, content: [{ type: "text", text: `Card not found in "${deck_name}".` }] };
      }
      const nf = new_front?.trim();
      const nb = new_back?.trim();
      if (!nf && !nb) {
        return { isError: true, content: [{ type: "text", text: "Provide new_front and/or new_back." }] };
      }
      const updated: Card = { ...cards[idx], ...(nf ? { front: nf } : {}), ...(nb ? { back: nb } : {}) };
      const newCards = cards.slice();
      newCards[idx] = updated;
      await saveDecks({ ...decks, [deck_name]: newCards });

      const names = Object.keys({ ...decks, [deck_name]: newCards });
      const today = todayISO();
      const dueCount = newCards.filter((c) => c.due && c.due <= today).length;
      const newCount = newCards.filter((c) => !c.due).length;
      return deckResult(deck_name, newCards, names, `Updated a card in "${deck_name}".`, dueCount, newCount);
    },
  );

  // rename_deck: rename a deck, preserving card order and schedules.
  registerAppTool(
    server,
    "rename_deck",
    {
      title: "Rename Deck",
      description: "Rename a deck. Fails if a deck with the new name already exists.",
      inputSchema: {
        deck_name: z.string().describe("Current deck name."),
        new_name: z.string().describe("New deck name."),
      },
      outputSchema: DECK_OUTPUT,
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ deck_name, new_name }): Promise<CallToolResult> => {
      const decks = await loadDecks();
      if (!decks[deck_name]) {
        return { isError: true, content: [{ type: "text", text: `Deck "${deck_name}" not found.` }] };
      }
      const newName = new_name.trim();
      if (!newName) {
        return { isError: true, content: [{ type: "text", text: "Provide a non-empty new_name." }] };
      }
      if (newName !== deck_name && decks[newName]) {
        return { isError: true, content: [{ type: "text", text: `A deck named "${newName}" already exists.` }] };
      }
      // Rebuild preserving key order, renaming in place.
      const renamed: DeckMap = {};
      for (const [k, v] of Object.entries(decks)) renamed[k === deck_name ? newName : k] = v;
      await saveDecks(renamed);

      const names = Object.keys(renamed);
      const cards = renamed[newName];
      const today = todayISO();
      const dueCount = cards.filter((c) => c.due && c.due <= today).length;
      const newCount = cards.filter((c) => !c.due).length;
      return deckResult(newName, cards, names, `Renamed "${deck_name}" to "${newName}".`, dueCount, newCount);
    },
  );

  // delete_card: remove a single card (identified by front). Refuses to empty a deck.
  registerAppTool(
    server,
    "delete_card",
    {
      title: "Delete Card",
      description:
        "Delete a single card from a deck, identified by its front text. Refuses to delete a " +
        "deck's last card (delete the deck instead).",
      inputSchema: {
        deck_name: z.string().describe("Deck the card belongs to."),
        front: z.string().describe("The card's front text (identifies the card)."),
      },
      outputSchema: DECK_OUTPUT,
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ deck_name, front }): Promise<CallToolResult> => {
      const decks = await loadDecks();
      const cards = decks[deck_name];
      if (!cards) {
        return { isError: true, content: [{ type: "text", text: `Deck "${deck_name}" not found.` }] };
      }
      const idx = cards.findIndex((c) => c.front === front);
      if (idx < 0) {
        return { isError: true, content: [{ type: "text", text: `Card not found in "${deck_name}".` }] };
      }
      if (cards.length <= 1) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Cannot delete the only card in "${deck_name}"; delete the deck instead.` },
          ],
        };
      }
      const newCards = cards.filter((_, i) => i !== idx);
      await saveDecks({ ...decks, [deck_name]: newCards });

      const names = Object.keys(decks);
      const today = todayISO();
      const dueCount = newCards.filter((c) => c.due && c.due <= today).length;
      const newCount = newCards.filter((c) => !c.due).length;
      return deckResult(deck_name, newCards, names, `Deleted a card from "${deck_name}".`, dueCount, newCount);
    },
  );

  // delete_deck: remove a whole deck (text-only, no UI to render). Refuses the last deck.
  server.registerTool(
    "delete_deck",
    {
      title: "Delete Deck",
      description: "Delete a deck and all its cards. Refuses to delete the only remaining deck.",
      inputSchema: {
        deck_name: z.string().describe("Deck to delete."),
      },
    },
    async ({ deck_name }): Promise<CallToolResult> => {
      const decks = await loadDecks();
      if (!decks[deck_name]) {
        return { isError: true, content: [{ type: "text", text: `Deck "${deck_name}" not found.` }] };
      }
      const names = Object.keys(decks);
      if (names.length <= 1) {
        return { isError: true, content: [{ type: "text", text: "Cannot delete the only remaining deck." }] };
      }
      const count = decks[deck_name].length;
      const rest: DeckMap = { ...decks };
      delete rest[deck_name];
      await saveDecks(rest);
      return {
        content: [
          {
            type: "text",
            text: `Deleted deck "${deck_name}" (${count} cards). Remaining decks: ${Object.keys(rest).join(", ")}.`,
          },
        ],
      };
    },
  );

  // due_today: cross-deck summary of what is due now (pull-based; call it to see it).
  server.registerTool(
    "due_today",
    {
      title: "Due Today",
      description:
        "Summarize what is due to review right now across all decks: per-deck and total " +
        "due/new counts. Pull-based (call it to see the summary); it does not appear on its own.",
      inputSchema: {},
      outputSchema: {
        date: z.string(),
        totalDue: z.number(),
        totalNew: z.number(),
        decks: z.array(z.object({ deck: z.string(), dueCount: z.number(), newCount: z.number() })),
      },
    },
    async (): Promise<CallToolResult> => {
      const decks = await loadDecks();
      const today = todayISO();
      const rows = Object.entries(decks).map(([name, cards]) => ({
        deck: name,
        dueCount: cards.filter((c) => c.due && c.due <= today).length,
        newCount: cards.filter((c) => !c.due).length,
      }));
      const totalDue = rows.reduce((a, r) => a + r.dueCount, 0);
      const totalNew = rows.reduce((a, r) => a + r.newCount, 0);
      const lines = rows
        .filter((r) => r.dueCount > 0 || r.newCount > 0)
        .map((r) => `- ${r.deck}: ${r.dueCount} due, ${r.newCount} new`);
      const text =
        `Due today (${today}):\n` +
        (lines.length ? lines.join("\n") : "- nothing due or new") +
        `\n\nTotal: ${totalDue} due, ${totalNew} new across ${rows.length} decks.`;
      return {
        content: [{ type: "text", text }],
        structuredContent: { date: today, totalDue, totalNew, decks: rows },
      };
    },
  );

  // Resource: the bundled flip-card HTML/JS the host renders in a sandboxed iframe.
  registerAppResource(
    server,
    "Memora Flip Cards",
    RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(path.join(DIST_DIR, "mcp-app.html"), "utf-8");
      return {
        contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: html }],
      };
    },
  );

  return server;
}
