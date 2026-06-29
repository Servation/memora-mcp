# Memora MCP

An interactive flashcard **MCP App** for Claude Desktop. Claude generates flashcards from your request or the conversation and renders them as an inline, gradeable **flip-card** review. Your grades flow back to the model, so Claude can react to your score and offer to drill what you missed.

Built on the [MCP Apps extension](https://github.com/modelcontextprotocol/ext-apps) (SEP-1865): core MCP spec `2025-11-25` + Apps extension `2026-01-26`.

![Memora flip-card review](media/flip-card.svg)

## What it does

- **`review_deck`** — opens a deck as an inline flip-card UI: click to flip, grade **Got it** / **Missed it**, and a results screen at the end. Grades are sent back to the model via the host bridge.
- **`create_deck`** — Claude generates cards from your request or the chat, saves them to `data/decks.json`, and renders them immediately for review. They persist, so `review_deck` can replay them later.
- Decks are plain JSON read **live** on every call, so you can hand-edit them or let Claude create them. No database, no external service.

## How it works (MCP Apps)

A tool declares a `ui://` resource. When Claude calls the tool, the host (Claude Desktop) fetches that resource and renders its HTML in a **sandboxed iframe**, passes the tool result to the UI, and the UI talks back to the host over JSON-RPC.

```
Claude calls review_deck
        │
        ▼
Host renders ui://memora/review-deck.html  (sandboxed iframe)
        │  tool result (deck + cards)
        ▼
Flip-card UI  ──grade──►  updateModelContext / sendMessage  ──►  model reacts
```

## Tech stack

- **Server:** TypeScript, [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) + [`@modelcontextprotocol/ext-apps`](https://www.npmjs.com/package/@modelcontextprotocol/ext-apps), stdio transport.
- **UI:** React + Vite, bundled to a single inlined HTML file via `vite-plugin-singlefile`.
- Runtime is plain `node` (no bun/tsx needed) once built.

## Prerequisites

- Node.js 20+

## Setup

```bash
npm install
npm run build      # builds the UI bundle (dist/mcp-app.html) and compiles the server (dist/)
```

## Connect to Claude Desktop

Open **Settings → Developer → Edit Config** and add (use the absolute path to this folder):

```json
{
  "mcpServers": {
    "memora": {
      "command": "node",
      "args": ["C:\\path\\to\\memora-mcp\\dist\\main.js", "--stdio"]
    }
  }
}
```

Then fully quit Claude Desktop (from the system tray) and relaunch. `memora` should appear under Settings → Developer.

## Usage (in a Claude Desktop chat)

- `review my World Capitals deck`
- `make me a deck of 10 Spanish travel phrases`
- `turn what we just discussed into a deck called "Photosynthesis"`
- `add 5 harder capitals to my World Capitals deck`  (uses `append`)

## Development

```bash
npm run dev        # vite watch (UI) + tsx server on http://localhost:3001/mcp
npm run typecheck  # tsc --noEmit (UI)
```

For fast local iteration you can also run the app against the MCP Apps reference host (`basic-host`) from the [ext-apps repo](https://github.com/modelcontextprotocol/ext-apps).

## Deck format (`data/decks.json`)

```json
{
  "Deck Name": [
    { "front": "question", "back": "answer" }
  ]
}
```

Read live (mtime-cached); `create_deck` writes here atomically. Keep it valid JSON, or the server falls back to a built-in default deck.

## Project structure

```
memora-mcp/
├── server.ts            # MCP server: review_deck + create_deck + ui:// resource
├── main.ts              # entry: stdio (Claude Desktop) or Streamable HTTP transport
├── mcp-app.html         # UI entry HTML (bundled by vite)
├── src/
│   ├── mcp-app.tsx      # React flip-card UI + grade -> model bridge
│   ├── mcp-app.module.css
│   └── global.css       # host theme variable fallbacks (light/dark)
├── data/decks.json      # editable decks, read live
├── vite.config.ts       # single-file bundle config
└── tsconfig*.json
```

## Ideas / roadmap

- Spaced-repetition scheduling (FSRS-style due dates and ease per card).
- A deck-picker view in the UI.
- Swap the JSON store for a real backend (any flashcard app's REST API) without changing the UI.

## License

MIT
