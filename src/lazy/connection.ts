import { scrubbedParentEnv } from "@deepseek-ai/dsh-subprocess";
import type { Config } from "@deepseek-ai/dsh-mcp-client";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createRequire } from "node:module";

const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };
export type LazyTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

const IDLE_MS = 5 * 60_000;
const DISCOVERY_TIMEOUT_MS = 30_000;

interface Connection {
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  abort: AbortController;
  ready: Promise<void>;
  catalog?: Promise<LazyTool[]>;
  requests: number;
  shutdown?: Promise<void>;
}

/** Cancel one waiter without cancelling work shared by other callers. */
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort!);
  }
}

/** One on-demand connection per mounted row. Never registers remote tools with DSH. */
export class LazyServer {
  private connection?: Connection;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private closing: Promise<void> = Promise.resolve();
  private disposed = false;
  private disposal?: Promise<void>;

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
    const client = new Client({ name: "dsh-project-mcp-manager", version }, {
      versionNegotiation: { mode: "auto" },
      listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => {
        connection.catalog = undefined;
      } } }
    });
    const abort = new AbortController();
    // The SDK can close fire-and-forget on handshake failure. Its stdio close()
    // clears the process handle before awaiting exit, so concurrent close calls
    // would otherwise appear finished while a process is still starting/exiting.
    const start = transport.start.bind(transport);
    const close = transport.close.bind(transport);
    let starting: Promise<void> | undefined;
    let transportClosing = Promise.resolve();
    transport.start = () => starting = Promise.resolve().then(() => {
      abort.signal.throwIfAborted();
      return start();
    });
    transport.close = () => transportClosing = transportClosing.catch(() => {}).then(async () => {
      await starting?.catch(() => {});
      await close();
    });
    // Publish the generation before connect can settle or a transport callback runs.
    const connection: Connection = { client, transport, abort, ready: Promise.resolve(), requests: 0 };
    connection.ready = Promise.resolve().then(async () => {
      abort.signal.throwIfAborted();
      await client.connect(transport, { signal: abort.signal, timeout: DISCOVERY_TIMEOUT_MS });
      if (this.connection !== connection || this.disposed) throw new Error("The MCP connection closed");
    }).catch(() => {
      throw new Error("Unable to connect to the MCP server");
    });
    // Reap failed/closed generations even if every caller already cancelled.
    void connection.ready.catch(() => { void this.close(connection); });
    client.onclose = () => { void this.close(connection); };
    return connection;
  }

  async withClient<T>(signal: AbortSignal, use: (connection: Connection) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.disposed) throw new Error("The MCP server configuration changed");
    let closing: Promise<void>;
    do {
      closing = this.closing;
      // This is a generation fence, not independent work: a newer shutdown can
      // replace the awaited promise. Never parallelize or skip this re-check.
      await abortable(closing, signal);
    } while (closing !== this.closing);
    signal.throwIfAborted();
    if (this.disposed) throw new Error("The MCP server configuration changed");
    clearTimeout(this.idleTimer);
    const connection = this.connection ??= this.open();
    connection.requests++;
    try {
      await abortable(connection.ready, signal);
      signal.throwIfAborted();
      if (this.connection !== connection) throw new Error("The MCP connection closed");
      return await abortable(use(connection), signal);
    } finally {
      connection.requests--;
      if (connection.requests === 0 && this.connection === connection) {
        if (signal.aborted) void this.close(connection);
        else {
          this.idleTimer = setTimeout(() => { void this.close(connection); }, IDLE_MS);
          this.idleTimer.unref();
        }
      }
    }
  }

  listTools(connection: Connection): Promise<LazyTool[]> {
    if (connection.catalog !== undefined) return connection.catalog;
    const catalog = connection.client.listTools(undefined, {
      cacheMode: "refresh",
      signal: connection.abort.signal,
      timeout: DISCOVERY_TIMEOUT_MS
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

  private close(connection = this.connection): Promise<void> {
    if (connection === undefined) return this.closing;
    if (connection.shutdown !== undefined) return connection.shutdown;
    if (this.connection === connection) {
      this.connection = undefined;
      clearTimeout(this.idleTimer);
    }
    // During SDK auto negotiation client.transport is still undefined. Closing the
    // original transport is what cancels the disposable stdio sibling probe.
    const closeTransport = () => (connection.client.transport === undefined
      ? connection.transport.close() : connection.client.close()).catch(() => {});
    connection.shutdown = Promise.resolve().then(async () => {
      connection.abort.abort();
      await closeTransport();
      await connection.ready.catch(() => {});
      // A connect racing the first close may have attached the transport meanwhile.
      await closeTransport();
    });
    this.closing = connection.shutdown;
    return connection.shutdown;
  }

  dispose(): Promise<void> {
    this.disposed = true;
    clearTimeout(this.idleTimer);
    this.disposal ??= this.close();
    return this.disposal;
  }
}
