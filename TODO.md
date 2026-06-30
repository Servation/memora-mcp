# Memora MCP: TODO / Roadmap

Backlog captured 2026-06-28. Check items off as they land.

## Features
- [x] `edit_card` tool: edit a single card's front/back (e.g. "change the back of card 3 to ...").
- [x] Editable flip-card UI: edit card text inline with a Save button that persists to `data/decks.json`.
- [x] Deck management tools: rename deck, delete deck, delete card.
- [x] Fuller FSRS scheduler to replace the current SM-2-lite scheduling (via ts-fsrs).
- [x] "Due today" overview across all decks (pull-based `due_today` tool; cannot self-appear).
- [x] Category tree (Anki-style "::" deck names) + `study` tool (review a subtree) + tree picker UI.
- [x] Trivia / multiple-choice (`create_quiz` + quiz review mode), reusing decks, the tree, and FSRS.
- [x] Mind-map style viewer of the deck tree (pure-SVG horizontal tidy tree, no extra library).
- [x] Cloze (inline fill-in-the-blank reveal) and reverse-card support (`reverse` flag on create_deck).

## Distribution and discoverability
- [x] Publish to npm: `@servation/memora-mcp` (scoped; `bin` + shebang, `files`, prepack build, per-user `~/.memora` storage). `npx -y @servation/memora-mcp --stdio`.
- [x] Register in the official MCP Registry: `io.github.Servation/memora-mcp` (`server.json` + `mcpName` ownership marker, published via `mcp-publisher`).
- [x] PR to awesome-mcp-servers (punkpeye/awesome-mcp-servers#8960, Education category; pending maintainer merge).
- [x] Submit to MCP directories: submitted to mcpservers.org; claimed the Glama listing via `glama.json`. mcp.so / Smithery auto-ingest from the MCP Registry.
- [ ] Social-preview image (upload in repo Settings).
- [ ] Real screen-capture GIF for the README hero (replace the SVG mockup).

## Cross-client and deployment
- [ ] Deploy the Streamable HTTP transport as a hosted server (needed for ChatGPT-style hosted apps).
- [ ] Test and document in other MCP Apps hosts (VS Code, Goose).

## Polish and verification
- [ ] Eyeball the grading round trip in Claude Desktop (flip, mark missed, finish, confirm Claude reacts).
- [ ] Add tests around deck parsing and scheduling.

## Maybe later
- [ ] Turn the "scaffold + wire an MCP App into Claude Desktop" workflow into a reusable Claude Code skill (handy for an OTTR MCP App).
- [ ] Optional: reconnect to a real backend (the original Memora REST API) instead of JSON. Descoped for now.
