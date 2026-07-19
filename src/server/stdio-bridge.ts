import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import {
  authorizationHeaderForToken,
  normalizeMcpEndpoint
} from "./lib/mcp-connection";

const rawEndpoint = process.env.PHOSPHENE_MCP_URL?.trim();
if (!rawEndpoint) {
  console.error(
    "PHOSPHENE_MCP_URL is required, for example https://your-domain.example/mcp"
  );
  process.exit(1);
}

let endpoint: URL;
try {
  endpoint = normalizeMcpEndpoint(rawEndpoint);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const authorization = authorizationHeaderForToken(
  process.env.PHOSPHENE_MCP_TOKEN
);
const headers = authorization ? { Authorization: authorization } : undefined;
const remoteTransport = new StreamableHTTPClientTransport(endpoint, {
  requestInit: headers ? { headers } : undefined
});
const remoteClient = new Client(
  { name: "phosphene-stdio-bridge", version: "1.0.0" },
  { capabilities: {} }
);
const localServer = new Server(
  { name: "Phosphene", version: "1.0.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Local stdio bridge for a user-owned Phosphene Streamable HTTP endpoint."
  }
);

localServer.setRequestHandler(ListToolsRequestSchema, (request) =>
  remoteClient.listTools(request.params)
);
localServer.setRequestHandler(CallToolRequestSchema, (request) =>
  remoteClient.callTool(request.params)
);

const stdioTransport = new StdioServerTransport();
await remoteClient.connect(remoteTransport);
await localServer.connect(stdioTransport);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await Promise.allSettled([localServer.close(), remoteClient.close()]);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
process.stdin.once("end", () => void shutdown());
