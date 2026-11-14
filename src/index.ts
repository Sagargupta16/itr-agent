import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.js";

// Local-first by design: stdio only, no network transports.
// All logging must go to stderr -- stdout is the MCP channel.
const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("itr-agent ready (stdio)");
