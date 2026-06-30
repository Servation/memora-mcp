/**
 * Memora MCP server: tool + resource wiring.
 *
 * Data model, storage, and the result builder live in decks.ts; FSRS scheduling
 * and ordering live in scheduling.ts. This file just registers the MCP tools and
 * the flip-card UI resource.
 *
 * Deck names use "::" to form a category tree; the `study` tool reviews a whole
 * subtree, merging its decks into one session (each card stays attributed to its
 * source deck so grading/editing routes correctly).
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
import path from "node:path";
import { schedule, counts } from "./scheduling.js";
import {
  type Card,
  type DeckMap,
  type Tagged,
  DIST_DIR,
  loadDecks,
  loadDecksSync,
  saveDecks,
  orderAndSlim,
  slimOf,
  quizDeckNames,
  isCloze,
  deckResult,
} from "./decks.js";

const RESOURCE_URI = "ui://memora/review-deck.html";
const MAX_CARDS = 1000;
/** Separator that turns deck names into a category tree (Anki-style). */
const PATH_SEP = "::";

/** Shared structured-output shape for the deck/review tools. */
const DECK_OUTPUT = {
  deck: z.string(),
  count: z.number(),
  cards: z.array(z.object({ front: z.string(), back: z.string(), deck: z.string(), options: z.array(z.string()).optional() })),
  availableDecks: z.array(z.string()),
  dueCount: z.number(),
  newCount: z.number(),
  quizDecks: z.array(z.string()).optional(),
};

/**
 * Creates the Memora MCP server with all tools and the flip-card UI.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: "Memora MCP", version: "0.1.0" });

  const startupDecks = Object.keys(loadDecksSync());

  // review_deck: review a single deck, due cards first (shuffled within tiers).
  registerAppTool(
    server,
    "review_deck",
    {
      title: "Review Deck",
      description:
        "Return the flashcards of a single Memora deck and display them as an interactive " +
        "flip-card review (due cards first). Available decks: " +
        startupDecks.map((d) => `"${d}"`).join(", ") +
        ". Deck names use \"::\" to form a category tree; use the study tool to review a " +
        "whole category. Decks are read live from data/decks.json.",
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
      const tagged: Tagged[] = decks[name].map((c) => ({ card: c, deck: name }));
      const { dueCount, newCount } = counts(decks[name]);
      return deckResult(name, orderAndSlim(tagged), names, undefined, dueCount, newCount, quizDeckNames(decks));
    },
  );

  // study: review every card under a category node (path prefix), merged into one session.
  registerAppTool(
    server,
    "study",
    {
      title: "Study Category",
      description:
        "Study every card under a category node of the deck tree. Deck names use \"::\" to " +
        "nest (e.g. \"LLM::Attention\"); studying a node reviews all decks at or under that " +
        "path, merged and shuffled into one session. Omit path to study all decks. Each card " +
        "stays attributed to its source deck.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe("Category path, e.g. \"LLM\" or \"LLM::Attention\". Omit to study all decks."),
      },
      outputSchema: DECK_OUTPUT,
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ path: nodePath }): Promise<CallToolResult> => {
      const decks = await loadDecks();
      const names = Object.keys(decks);
      const prefix = (nodePath ?? "").trim();
      const matched = prefix
        ? names.filter((n) => n === prefix || n.startsWith(prefix + PATH_SEP))
        : names;
      if (!matched.length) {
        return { isError: true, content: [{ type: "text", text: `No decks at or under "${prefix}".` }] };
      }
      const tagged: Tagged[] = matched.flatMap((n) => decks[n].map((c) => ({ card: c, deck: n })));
      const all: Card[] = matched.flatMap((n) => decks[n]);
      const { dueCount, newCount } = counts(all);
      const title = prefix
        ? `${prefix} (${matched.length} deck${matched.length > 1 ? "s" : ""})`
        : `All decks (${matched.length})`;
      return deckResult(title, orderAndSlim(tagged), names, undefined, dueCount, newCount, quizDeckNames(decks));
    },
  );

  // create_deck: Claude generates cards; persist + render. "::" in the name nests it.
  registerAppTool(
    server,
    "create_deck",
    {
      title: "Create Deck",
      description:
        "Create (or extend) a flashcard deck from cards you generate based on the user's " +
        "request or the current conversation, then display it for review. Use \"::\" in " +
        "deck_name to nest under a category (e.g. \"LLM::Attention\"). The deck persists to " +
        "data/decks.json.\n\n" +
        "Follow Memora's card-quality rules (based on Wozniak's '20 Rules of Formulating " +
        "Knowledge'). The front is the prompt/question, the back is the answer:\n" +
        "1. Minimum information (atomic): each card tests exactly one fact or concept. Split " +
        "complex material into several simple cards; never ask for lists or paragraph answers.\n" +
        "2. Concise answers: the back is ideally 1-5 words (a name, date, term, or single " +
        "concept), never a sentence or paragraph.\n" +
        "3. Active recall: make the front a specific question (not 'Explain X'), or a cloze " +
        "deletion: write the blank as \"[...]\" in the front and the hidden term as the back " +
        "(e.g. front \"The Transformer was introduced in [...].\", back \"2017\").\n" +
        "4. Unambiguous: each front must point to exactly one correct answer.\n\n" +
        "Set reverse=true to also add the back->front version of each non-cloze card (useful " +
        "for vocabulary or term/definition pairs that should be drilled both ways).",
      inputSchema: {
        deck_name: z.string().describe("Name for the deck to create or add to (\"::\" nests it)."),
        cards: z
          .array(z.object({ front: z.string(), back: z.string() }))
          .describe("Flashcards generated from the user's request or the conversation."),
        append: z
          .boolean()
          .optional()
          .describe("If true and the deck already exists, append to it; otherwise replace/create."),
        reverse: z
          .boolean()
          .optional()
          .describe("If true, also add the reverse (back -> front) of each non-cloze card."),
      },
      outputSchema: DECK_OUTPUT,
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ deck_name, cards, append, reverse }): Promise<CallToolResult> => {
      const clean: Card[] = (cards ?? [])
        .filter((c) => c && typeof c.front === "string" && typeof c.back === "string")
        .map((c) => ({ front: c.front.trim(), back: c.back.trim() }))
        .filter((c) => c.front && c.back)
        .slice(0, MAX_CARDS);

      if (!deck_name?.trim() || clean.length === 0) {
        return {
          isError: true,
          content: [{ type: "text", text: "Provide a deck_name and at least one {front, back} card." }],
        };
      }

      // reverse: drill each pair both ways. Skip cloze cards (a "[...]" front has no
      // sensible inverse) and degenerate front===back pairs.
      const prepared: Card[] = reverse
        ? clean.flatMap((c) =>
            isCloze(c.front) || c.front === c.back ? [c] : [c, { front: c.back, back: c.front }],
          )
        : clean;

      const decks = await loadDecks();
      const existing = decks[deck_name] ?? [];
      const merged = (append ? [...existing, ...prepared] : prepared).slice(0, MAX_CARDS);
      const updated: DeckMap = { ...decks, [deck_name]: merged };
      await saveDecks(updated);

      const names = Object.keys(updated);
      const { dueCount, newCount } = counts(merged);
      const note = `Saved deck "${deck_name}" with ${merged.length} card(s).`;
      return deckResult(deck_name, slimOf(merged, deck_name), names, note, dueCount, newCount, quizDeckNames(updated));
    },
  );

  // create_quiz: Claude generates multiple-choice questions; persist + render.
  registerAppTool(
    server,
    "create_quiz",
    {
      title: "Create Quiz",
      description:
        "Create (or extend) a multiple-choice quiz deck from questions you generate based on " +
        "the user's request or the conversation, then display it for review. Use \"::\" in " +
        "deck_name to nest under a category. Persists to data/decks.json and is reviewed like " +
        "flashcards with spaced repetition.\n\n" +
        "Each question: a clear, specific prompt; 3 to 4 concise options with exactly ONE " +
        "correct answer and plausible (not obviously wrong) distractors. The answer must match " +
        "one of the options exactly.",
      inputSchema: {
        deck_name: z.string().describe("Name for the quiz deck to create or add to (\"::\" nests it)."),
        questions: z
          .array(
            z.object({
              question: z.string(),
              options: z.array(z.string()).min(2),
              answer: z.string().describe("The correct option (must match one of options exactly)."),
            }),
          )
          .describe("Multiple-choice questions you generate."),
        append: z.boolean().optional().describe("If true and the deck exists, append; otherwise replace/create."),
      },
      outputSchema: DECK_OUTPUT,
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ deck_name, questions, append }): Promise<CallToolResult> => {
      const clean: Card[] = (questions ?? [])
        .map((q) => ({
          question: typeof q.question === "string" ? q.question.trim() : "",
          options: (q.options ?? []).map((o) => (typeof o === "string" ? o.trim() : "")).filter(Boolean),
          answer: typeof q.answer === "string" ? q.answer.trim() : "",
        }))
        .filter((q) => q.question && q.answer && q.options.length >= 2 && q.options.includes(q.answer))
        .map((q) => ({ front: q.question, back: q.answer, options: q.options }))
        .slice(0, MAX_CARDS);

      if (!deck_name?.trim() || clean.length === 0) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Provide a deck_name and at least one question with 2+ options and an answer that matches one option exactly.",
            },
          ],
        };
      }

      const decks = await loadDecks();
      const existing = decks[deck_name] ?? [];
      const merged = (append ? [...existing, ...clean] : clean).slice(0, MAX_CARDS);
      const updated: DeckMap = { ...decks, [deck_name]: merged };
      await saveDecks(updated);

      const names = Object.keys(updated);
      const { dueCount, newCount } = counts(merged);
      const note = `Saved quiz "${deck_name}" with ${merged.length} question(s).`;
      return deckResult(deck_name, slimOf(merged, deck_name), names, note, dueCount, newCount, quizDeckNames(updated));
    },
  );

  // grade_card: app-only. The UI calls this to persist an FSRS review result.
  registerAppTool(
    server,
    "grade_card",
    {
      title: "Grade Card",
      description:
        "Record a spaced-repetition review result for a single card and update its FSRS " +
        "schedule in data/decks.json. Called by the flip-card UI; not for direct model use.",
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
        "then re-render the deck. Keep edits within Memora's card-quality rules (atomic, " +
        "concise 1-5 word answers, unambiguous).",
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

      const names = Object.keys(decks);
      const { dueCount, newCount } = counts(newCards);
      return deckResult(deck_name, slimOf(newCards, deck_name), names, `Updated a card in "${deck_name}".`, dueCount, newCount, quizDeckNames(decks));
    },
  );

  // rename_deck: rename a deck (also moves it in the tree), preserving cards + schedules.
  registerAppTool(
    server,
    "rename_deck",
    {
      title: "Rename Deck",
      description:
        "Rename a deck, preserving its cards and schedules. Use \"::\" in the new name to move " +
        "it under a category. Fails if a deck with the new name already exists.",
      inputSchema: {
        deck_name: z.string().describe("Current deck name."),
        new_name: z.string().describe("New deck name (\"::\" nests it under a category)."),
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
      const renamed: DeckMap = {};
      for (const [k, v] of Object.entries(decks)) renamed[k === deck_name ? newName : k] = v;
      await saveDecks(renamed);

      const names = Object.keys(renamed);
      const cards = renamed[newName];
      const { dueCount, newCount } = counts(cards);
      return deckResult(newName, slimOf(cards, newName), names, `Renamed "${deck_name}" to "${newName}".`, dueCount, newCount, quizDeckNames(renamed));
    },
  );

  // delete_card: remove a single card. Refuses to empty a deck.
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
          content: [{ type: "text", text: `Cannot delete the only card in "${deck_name}"; delete the deck instead.` }],
        };
      }
      const newCards = cards.filter((_, i) => i !== idx);
      await saveDecks({ ...decks, [deck_name]: newCards });

      const names = Object.keys(decks);
      const { dueCount, newCount } = counts(newCards);
      return deckResult(deck_name, slimOf(newCards, deck_name), names, `Deleted a card from "${deck_name}".`, dueCount, newCount, quizDeckNames(decks));
    },
  );

  // delete_deck: remove a whole deck (text-only). Refuses the last deck.
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
      const today = new Date().toISOString().slice(0, 10);
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
