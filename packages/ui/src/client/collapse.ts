/**
 * 设置页把多份配置收成一张卡。优先序与装载器七层影子序一致；
 * 同一作用域里原名、归一名、服务身份三把键先到先得。
 * 同名的低优先级行留在卡片上作「已被覆盖」说明。
 * 异名、但服务身份相同（stdio 的命令加参数，或 http 的地址）的非 yml 行不占卡片。
 * 同样情况的 yml 行并进胜出者的卡片：装载器只启动高优先级那条，单独成卡会停在等待启动。
 */

export interface CollapseServer {
  serverName: string;
  source: string;
  projectRoot: string;
  layer: "project" | "user";
  needsYmlTakeover: boolean;
  /** 与装载器 serviceIdentityKeyOf 相同。null 表示这行没有可比较的命令或地址。 */
  serviceKey: string | null;
}

export interface LogicalServer<T extends CollapseServer = CollapseServer> {
  winner: T;
  shadowed: T[];
}

/** 数字越小越优先，与装载器 SOURCE_RANK 一致。 */
const SOURCE_RANK: Record<string, number> = {
  "dsh-project": 0,
  "dsh-project-json": 1,
  "cc-project": 2,
  "dsh-profile-user-yml": 3,
  "dsh-profile-user": 4,
  "dsh-user-yml": 5,
  "dsh-user": 6
};

function normServerName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function scopeOf(row: CollapseServer): string {
  return row.layer === "project" ? row.projectRoot : "";
}

export function collapseServers<T extends CollapseServer>(rows: T[]): LogicalServer<T>[] {
  const ranked = rows.map((row, index) => ({ row, index }));
  ranked.sort((a, b) => {
    const delta = (SOURCE_RANK[a.row.source] ?? 99) - (SOURCE_RANK[b.row.source] ?? 99);
    return delta !== 0 ? delta : a.index - b.index;
  });

  const byName = new Map<string, T>();
  const byNorm = new Map<string, T>();
  const byIdentity = new Map<string, T>();
  const shadowed = new Map<T, T[]>();
  const anchor = new Map<T, number>();

  for (const { row, index } of ranked) {
    const scope = scopeOf(row);
    const nameKey = scope + "\0" + row.serverName;
    const norm = normServerName(row.serverName);
    const normKey = norm === "" ? undefined : scope + "\0n\0" + norm;
    const idKey = row.serviceKey == null || row.serviceKey === "" ? undefined : scope + "\0i\0" + row.serviceKey;
    const nameWinner = byName.get(nameKey);
    const normWinner = normKey === undefined ? undefined : byNorm.get(normKey);
    const idWinner = idKey === undefined ? undefined : byIdentity.get(idKey);
    const winner = nameWinner ?? normWinner ?? idWinner;
    if (winner !== undefined) {
      const sameName = nameWinner !== undefined || normWinner !== undefined;
      if (!sameName && row.needsYmlTakeover) continue;
      const notes = shadowed.get(winner);
      if (notes !== undefined) notes.push(row);
      const at = anchor.get(winner);
      if (at !== undefined && index < at) anchor.set(winner, index);
      byName.set(nameKey, winner);
      if (normKey !== undefined) byNorm.set(normKey, winner);
      continue;
    }
    byName.set(nameKey, row);
    if (normKey !== undefined) byNorm.set(normKey, row);
    if (idKey !== undefined) byIdentity.set(idKey, row);
    shadowed.set(row, []);
    anchor.set(row, index);
  }

  const winners = [...anchor.keys()];
  winners.sort((a, b) => (anchor.get(a) ?? 0) - (anchor.get(b) ?? 0));
  return winners.map((winner) => ({ winner, shadowed: shadowed.get(winner) ?? [] }));
}

/** 同名（含归一名）留在「已被覆盖」说明里；异名同命令或同地址单独说明它没有被装载。 */
export function partitionShadowed<T extends CollapseServer>(server: LogicalServer<T>): { named: T[]; identity: T[] } {
  const winnerNorm = normServerName(server.winner.serverName);
  const named: T[] = [];
  const identity: T[] = [];
  for (const row of server.shadowed) {
    const norm = normServerName(row.serverName);
    if (winnerNorm !== "" && norm === winnerNorm) named.push(row);
    else identity.push(row);
  }
  return { named, identity };
}
