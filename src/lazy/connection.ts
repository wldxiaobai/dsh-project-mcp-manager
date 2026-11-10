import { scrubbedParentEnv } from "@deepseek-ai/dsh-subprocess";
import type { Config } from "@deepseek-ai/dsh-mcp-client";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export type LazyTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

const IDLE_MS = 5 * 60_000;

interface Connection {
  client: Client;
  abort: AbortController;
  ready: Promise<void>;
  catalog?: Promise<LazyTool[]>;
}

/** One on-demand connection per mounted row. Never registers remote tools with DSH. */
export class LazyServer {
  private connection?: Connection;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private requests = 0;
  private disposed = false;

  constructor(private readonly config: Config) {}

  private open(): Connection {
    const config = this.config;
    const transport = config.transport === "stdio"
      ? new StdioClientTransport({
        command: config.command,
        args: config.args,
        cwd: config.cwd || undefined,
        env: { ...scrubbedParentEnv(), ...config.env }
      })
      : new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
    const client = new Client({ name: "dsh-project-mcp-manager", version: "0.10.0" }, {
      versionNegotiation: { mode: "auto" },
      listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => {
        connection.catalog = undefined;
      } } }
    });
    const abort = new AbortController();
    const ready = client.connect(transport, {
      signal: abort.signal,
      timeout: Math.min(30_000, config.toolCallTimeoutMs)
    }).then(() => {
      if (this.connection !== connection) throw new Error("The MCP connection closed");
    }).catch(async () => {
      if (this.connection === connection) this.connection = undefined;
      await (client.transport === undefined ? transport.close() : client.close()).catch(() => {});
      throw new Error("Unable to connect to the MCP server");
    });
    const connection: Connection = { client, abort, ready };
    client.onclose = () => {
      if (this.connection === connection) this.connection = undefined;
    };
    return connection;
  }

  async withClient<T>(signal: AbortSignal, use: (connection: Connection) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.disposed) throw new Error("The MCP server configuration changed");
    clearTimeout(this.idleTimer);
    this.requests++;
    try {
      const connection = this.connection ??= this.open();
      await connection.ready;
      signal.throwIfAborted();
      if (this.connection !== connection) throw new Error("The MCP connection closed");
      return await use(connection);
    } finally {
      this.requests--;
      if (this.requests === 0 && this.connection !== undefined) {
        this.idleTimer = setTimeout(() => void this.close(), IDLE_MS);
        this.idleTimer.unref();
      }
    }
  }

  listTools(connection: Connection): Promise<LazyTool[]> {
    if (connection.catalog !== undefined) return connection.catalog;
    const catalog = connection.client.listTools(undefined, {
      cacheMode: "refresh",
      timeout: Math.min(30_000, this.config.toolCallTimeoutMs)
    }).then(({ tools }) => tools).catch((error: unknown) => {
      if (connection.catalog === catalog) connection.catalog = undefined;
      throw error;
    });
    connection.catalog = catalog;
    return catalog;
  }

  callTool(connection: Connection, tool: LazyTool, args: Record<string, unknown>, signal: AbortSignal) {
    if (this.connection !== connection) throw new Error("The MCP connection closed");
    if (tool.execution?.taskSupport === "required") throw new Error("This tool requires task-based execution");
    return connection.client.callTool({ name: tool.name, arguments: args }, {
      signal,
      timeout: this.config.toolCallTimeoutMs,
      toolDefinition: tool
    });
  }

  private async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    if (connection === undefined) return;
    connection.abort.abort();
    await connection.client.close().catch(() => {});
    await connection.ready.catch(() => {});
  }

  dispose(): Promise<void> {
    this.disposed = true;
    clearTimeout(this.idleTimer);
    return this.close();
  }
}
