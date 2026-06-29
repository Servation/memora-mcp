/**
 * Memora MCP server.
 *
 * Decks live in editable data/decks.json, read live (mtime-cached) on every call.
 * - review_deck: show a deck as an interactive flip-card review.
 * - create_deck: Claude generates cards (from the user's request or the
 *   conversation), this saves them to decks.json and renders them for review.
 * Both link the same flip-card ui:// view.
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

type Card = { front: string; back: string };
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

/** Parse + validate the deck map, dropping malformed decks/cards. */
function parseDecks(raw: string): DeckMap {
  const data = JSON.parse(raw) as DeckMap;
  const out: DeckMap = {};
  for (const [name, cards] of Object.entries(data)) {
    if (
      Array.isArray(cards) &&
      cards.length > 0 &&
      cards.every((c) => c && typeof c.front === "string" && typeof c.back === "string")
    ) {
      out[name] = cards.map((c) => ({ front: c.front, back: c.back }));
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
function deckResult(deck: string, cards: Card[], names: string[], note?: string): CallToolResult {
  const text =
    (note ? note + "\n\n" : "") +
    `Deck: ${deck} (${cards.length} cards)\n` +
    cards.map((c, i) => `${i + 1}. ${c.front}  ->  ${c.back}`).join("\n") +
    `\n\nAvailable decks: ${names.join(", ")}`;
  return {
    content: [{ type: "text", text }],
    structuredContent: { deck, count: cards.length, cards, availableDecks: names },
  };
}

/**
 * Creates the Memora MCP server with review_deck + create_deck and the flip-card UI.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: "Memora MCP", version: "0.1.0" });

  // Snapshot deck names at startup for the tool description. Decks added later
  // still work when named; they just are not pre-listed until restart.
  const startupDecks = Object.keys(loadDecksSync());

  // review_deck: show an existing deck.
  registerAppTool(
    server,
    "review_deck",
    {
      title: "Review Deck",
      description:
        "Return the flashcards of a Memora deck and display them as an interactive " +
        "flip-card review. Available decks: " +
        startupDecks.map((d) => `"${d}"`).join(", ") +
        ". Decks are read live from data/decks.json.",
      inputSchema: {
        deck_name: z
          .string()
          .optional()
          .describe("Deck to review. Omit or pass an unknown name to get the first available deck."),
      },
      outputSchema: {
        deck: z.string(),
        count: z.number(),
        cards: z.array(z.object({ front: z.string(), back: z.string() })),
        availableDecks: z.array(z.string()),
      },
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ deck_name }): Promise<CallToolResult> => {
      const decks = await loadDecks();
      const names = Object.keys(decks);
      const name = deck_name && decks[deck_name] ? deck_name : names[0];
      return deckResult(name, decks[name], names);
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
        "request or the current conversation, then display it for review. Use atomic, " +
        "single-concept cards with concise answers. The deck persists to data/decks.json " +
        "and can be reopened later with review_deck.",
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
      outputSchema: {
        deck: z.string(),
        count: z.number(),
        cards: z.array(z.object({ front: z.string(), back: z.string() })),
        availableDecks: z.array(z.string()),
      },
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ deck_name, cards, append }): Promise<CallToolResult> => {
      const clean = (cards ?? [])
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
      decks[deck_name] = (append ? [...existing, ...clean] : clean).slice(0, MAX_CARDS);
      await saveDecks(decks);

      const names = Object.keys(decks);
      const note = `Saved deck "${deck_name}" with ${decks[deck_name].length} card(s).`;
      return deckResult(deck_name, decks[deck_name], names, note);
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
