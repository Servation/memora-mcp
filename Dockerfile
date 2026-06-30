# Container image for Memora's MCP server. Used by Glama's listing check
# (the server must start and answer introspection over stdio) and for running
# Memora in Docker generally. Installs the published npm package and launches
# it in stdio mode.
FROM node:20-alpine
RUN npm install -g @servation/memora-mcp
ENTRYPOINT ["memora-mcp", "--stdio"]
