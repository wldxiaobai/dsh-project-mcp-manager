/** Display helpers for the settings page. Paths sent to the host stay absolute. */

export function isProfileSource(source: string): boolean {
  return source === "dsh-profile-user-yml" || source === "dsh-profile-user";
}

/** Replace a user-home prefix with `~`. Call this only for user and profile paths. */
export function displayHomePath(path: string, homeDir: string | undefined): string {
  if (homeDir === undefined || homeDir === "" || path === "") return path;
  const windows = /\\/.test(path) || /\\/.test(homeDir) || /^[A-Za-z]:/.test(path) || /^[A-Za-z]:/.test(homeDir);
  const norm = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "");
  const file = norm(path);
  const home = norm(homeDir);
  if (home === "") return path;
  const fileKey = windows ? file.toLowerCase() : file;
  const homeKey = windows ? home.toLowerCase() : home;
  if (fileKey === homeKey) return "~";
  if (!fileKey.startsWith(homeKey + "/")) return path;
  return "~" + file.slice(home.length);
}

/** Folder name in `.../profiles/<name>/mcp.yml` or `mcp.json`. */
export function profileNameFromFile(filePath: string): string | undefined {
  const norm = filePath.replaceAll("\\", "/");
  const match = /\/profiles\/([^/]+)\/mcp\.(?:yml|json)$/i.exec(norm);
  const name = match?.[1];
  if (name === undefined || name === "." || name === "..") return undefined;
  return name;
}

export type ProfileEndKind = "desktop" | "web" | "named";

export function profileEndKind(name: string): ProfileEndKind {
  const key = name.toLowerCase();
  if (key === "desktop") return "desktop";
  if (key === "web") return "web";
  return "named";
}
