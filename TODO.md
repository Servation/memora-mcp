# Memora MCP: TODO / Roadmap

Backlog captured 2026-06-28. Check items off as they land.

## Features
- [ ] `edit_card` tool: edit a single card's front/back (e.g. "change the back of card 3 to ...").
- [ ] Editable flip-card UI: edit card text inline with a Save button that persists to `data/decks.json`.
- [ ] Deck management tools: rename deck, delete deck, delete card.
- [ ] Fuller FSRS scheduler to replace the current SM-2-lite scheduling.
- [ ] "Due today" overview across all decks (a home / dashboard view).
- [ ] Cloze and reverse-card support.

## Distribution and discoverability
- [ ] Publish to npm (un-private package, `bin` + shebang, `files`, build-on-publish) so it is `npx`-installable.
- [ ] Register in the official MCP Registry (`server.json` + `mcp-publisher`, GitHub auth). Needs the npm publish first.
- [ ] PR to awesome-mcp-servers and similar curated lists.
- [ ] Submit to MCP directories (glama.ai, mcp.so, Smithery).
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
