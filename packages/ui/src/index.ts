/**
 * 配套 UI 的宿主半区。浏览器经 connection 的精确 Fetch 路由读写 projectMcp；
 * 页面本身由 ./client 挂进设置里的 Plugins 标签。headless 没有 connection 时
 * 本插件不注册路由，装载器照常工作。
 */
import type { Context } from "@deepseek-ai/cordis";
import { openNativeTextFile } from "@deepseek-ai/dsh-native-command";
import type { McpRowSource, ProjectFileState } from "dsh-project-mcp-manager";
import {
  MCP_UI_OPEN_PATH,
  MCP_UI_SERVER_PATH,
  MCP_UI_EVENTS_PATH,
  MCP_UI_STATE_PATH,
  MCP_UI_TOOL_PATH,
  MCP_UI_TOOLS_PATH,
  type McpUiLayer,
  type McpUiOpenTarget,
  type McpUiServer,
  type McpUiState
} from "./wire.js";

export const name = "dsh-project-mcp-ui";
/** connection 必须注入：浏览器路由挂在它的 /api Fetch 表上。headless 没有这条服务时，本插件行停在等待，装载器不受影响。 */
export const inject = ["projectMcp", "connection"];

const YML_SOURCES = new Set<McpRowSource>(["dsh-project", "dsh-profile-user-yml", "dsh-user-yml"]);

interface FetchConnection {
  fetch: {
    register(route: {
      path: string;
      methods: readonly ("GET" | "HEAD" | "POST")[];
      requestBody: "buffered" | "streaming";
      fetch: (request: Request) => Promise<Response>;
    }): () => Promise<void>;
  };
}

function connectionOf(ctx: Context): FetchConnection | undefined {
  const connection = (ctx as Context & { connection?: FetchConnection }).connection;
  if (connection?.fetch?.register == null) return undefined;
  return connection;
}

function layerOf(source: string): McpUiLayer {
  return source === "dsh-project" || source === "dsh-project-json" || source === "cc-project" ? "project" : "user";
}

function serversFrom(snapshot: ProjectFileState[], mcp: Context["projectMcp"]): McpUiServer[] {
  const out: McpUiServer[] = [];
  for (const file of snapshot) {
    const source = file.source;
    if (source === undefined) continue;
    for (const server of file.servers) {
      const projectRoot = file.kind === "global" ? "" : file.project;
      const managedPath = mcp.managedPathFor(source, projectRoot === "" ? file.project : projectRoot) ?? null;
      out.push({
        serverName: server.serverName,
        source,
        projectRoot: projectRoot === "" ? file.project : projectRoot,
        filePath: file.path,
        managedPath,
        needsYmlTakeover: !YML_SOURCES.has(source),
        layer: layerOf(source),
        enabled: server.enabled,
        active: server.enabled && server.fiberPhase === "active" && (server.skipReason == null || server.skipReason === ""),
        fiberPhase: server.fiberPhase,
        skipReason: server.skipReason,
        toolCount: server.toolCount,
        endpoint: server.transport === "streamable-http" ? (server.url ?? "") : (server.command ?? "")
      });
    }
  }
  return out;
}

function openTargetsFrom(snapshot: ProjectFileState[], mcp: Context["projectMcp"]): McpUiOpenTarget[] {
  const targets: McpUiOpenTarget[] = [];
  const user = mcp.managedPathFor("dsh-user-yml", "");
  if (user !== undefined) {
    targets.push({ id: "user", label: "user", path: user, source: "dsh-user-yml", projectRoot: "" });
  }
  const profile = mcp.managedPathFor("dsh-profile-user-yml", "");
  if (profile !== undefined) {
    targets.push({ id: "profile", label: "profile", path: profile, source: "dsh-profile-user-yml", projectRoot: "" });
  }
  const seen = new Set<string>();
  for (const file of snapshot) {
    if (file.kind === "global") continue;
    if (seen.has(file.project)) continue;
    seen.add(file.project);
    const path = mcp.managedPathFor("dsh-project", file.project);
    if (path === undefined) continue;
    targets.push({ id: "project:" + file.project, label: file.project, path, source: "dsh-project", projectRoot: file.project });
  }
  return targets;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json();
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("请求体必须是 JSON 对象");
  return body as Record<string, unknown>;
}

function asSource(value: unknown): McpRowSource {
  if (typeof value !== "string" || value === "") throw new Error("缺少 source");
  return value as McpRowSource;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`缺少 ${label}`);
  return value;
}

export function apply(ctx: Context) {
  const mcp = ctx.projectMcp;
  let revision = 0;
  const unsubscribe = mcp.subscribeUpdated(() => {
    revision += 1;
  });
  ctx.effect(() => unsubscribe, "dsh-project-mcp-ui: unsubscribe");

  const connection = connectionOf(ctx);
  if (connection === undefined) {
    throw new Error("project mcp ui：connection 服务不可用，无法注册 /api/project-mcp 路由");
  }

  const state = async (): Promise<McpUiState> => {
    const snapshot = await mcp.snapshot();
    return {
      revision,
      servers: serversFrom(snapshot, mcp),
      openTargets: openTargetsFrom(snapshot, mcp)
    };
  };

  const guarded = (fetch: (request: Request) => Promise<Response>) => async (request: Request): Promise<Response> => {
    try {
      return await fetch(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ ok: false, message }, { status: 400 });
    }
  };

  const routes: { path: string; methods: readonly ("GET" | "POST")[]; fetch: (request: Request) => Promise<Response> }[] = [
    {
      path: MCP_UI_STATE_PATH,
      methods: ["GET"],
      fetch: async () => Response.json(await state())
    },
    {
      path: MCP_UI_OPEN_PATH,
      methods: ["POST"],
      fetch: async (request) => {
        const body = await readJson(request);
        const source = asSource(body.source);
        const projectRoot = asString(body.projectRoot, "projectRoot");
        const path = mcp.managedPathFor(source, projectRoot);
        if (path === undefined) return Response.json({ ok: false, message: "无法定位受管 yml" }, { status: 400 });
        await openNativeTextFile(path, request.signal);
        return Response.json({ ok: true, path });
      }
    },
    {
      path: MCP_UI_SERVER_PATH,
      methods: ["POST"],
      fetch: async (request) => {
        const body = await readJson(request);
        const source = asSource(body.source);
        const projectRoot = asString(body.projectRoot, "projectRoot");
        const rawName = asString(body.serverName, "serverName");
        const action = asString(body.action, "action");
        if (!YML_SOURCES.has(source) && body.acknowledge !== true) {
          return Response.json({
            ok: false,
            code: "confirm-yml",
            managedPath: mcp.managedPathFor(source, projectRoot) ?? null,
            filePath: typeof body.filePath === "string" ? body.filePath : ""
          });
        }
        if (action !== "enable" && action !== "disable" && action !== "remove") throw new Error(`未知操作：${action}`);
        const path = action === "remove"
          ? await mcp.removeServer(source, projectRoot, rawName)
          : await mcp.setServerEnabled(source, projectRoot, rawName, action === "enable");
        return Response.json({ ok: true, path });
      }
    },
    {
      path: MCP_UI_TOOL_PATH,
      methods: ["POST"],
      fetch: async (request) => {
        const body = await readJson(request);
        const source = asSource(body.source);
        const projectRoot = asString(body.projectRoot, "projectRoot");
        const rawName = asString(body.serverName, "serverName");
        const tool = asString(body.tool, "tool");
        if (!YML_SOURCES.has(source) && body.acknowledge !== true) {
          return Response.json({
            ok: false,
            code: "confirm-yml",
            managedPath: mcp.managedPathFor(source, projectRoot) ?? null,
            filePath: typeof body.filePath === "string" ? body.filePath : ""
          });
        }
        const path = await mcp.setToolEnabled(source, projectRoot, rawName, tool, body.enabled === true);
        return Response.json({ ok: true, path });
      }
    },
    {
      path: MCP_UI_TOOLS_PATH,
      methods: ["POST"],
      fetch: async (request) => {
        const body = await readJson(request);
        const projectRoot = asString(body.projectRoot, "projectRoot");
        const rawName = asString(body.serverName, "serverName");
        return Response.json({ ok: true, tools: mcp.toolStates(projectRoot, rawName) });
      }
    }
  ];

  for (const route of routes) {
    ctx.effect(() => connection.fetch.register({ path: route.path, methods: route.methods, requestBody: "buffered", fetch: guarded(route.fetch) }), `dsh-project-mcp-ui: ${route.path}`);
  }
  ctx.effect(() => connection.fetch.register({
    path: MCP_UI_EVENTS_PATH,
    methods: ["GET"],
    requestBody: "buffered",
    fetch: (request) => Promise.resolve(eventStream(request, mcp))
  }), "dsh-project-mcp-ui: events");
}

/** 对账结束推一条 SSE。浏览器关页时 abort 退订。 */
function eventStream(request: Request, mcp: Context["projectMcp"]): Response {
  const encoder = new TextEncoder();
  let unsubscribe = (): void => {};
  let ping: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const write = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // 对端已关闭
        }
      };
      const close = () => {
        unsubscribe();
        if (ping !== undefined) clearInterval(ping);
        try {
          controller.close();
        } catch {
          // 已经关闭
        }
      };
      write("event: ready\ndata: 0\n\n");
      unsubscribe = mcp.subscribeUpdated(() => write("event: updated\ndata: 1\n\n"));
      ping = setInterval(() => write(": ping\n\n"), 20000);
      request.signal.addEventListener("abort", close);
    },
    cancel() {
      unsubscribe();
      if (ping !== undefined) clearInterval(ping);
    }
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache"
    }
  });
}
