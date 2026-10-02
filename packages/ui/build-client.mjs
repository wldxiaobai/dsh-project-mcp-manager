import * as esbuild from "esbuild";
import { writeFileSync } from "node:fs";

const id = "dsh-project-mcp-ui";
const result = await esbuild.build({
  entryPoints: ["src/client/index.ts"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  write: false,
  external: [
    "react",
    "react/jsx-runtime",
    "react-dom",
    "@deepseek-ai/cordis",
    "@deepseek-ai/dsh-client-ui-primitives",
    "@deepseek-ai/dsh-client-ui-slots",
    "@deepseek-ai/dsh-client-locale",
    "@deepseek-ai/dsh-client-ui-settings",
    "@deepseek-ai/dsh-client-ui-settings-plugins",
    "@deepseek-ai/dsh-client-ui-renderer"
  ]
});
const generated = result.outputFiles[0]?.text ?? "";
const body = generated.replace(/^"use strict";\s*/, "");
const wrapped = [
  "window.__ModuleLoader__.load({",
  `  id: ${JSON.stringify(id)},`,
  "  factory: function (require) {",
  "\"use strict\";",
  "var module = { exports: {} };",
  "var exports = module.exports;",
  body,
  "return module.exports;",
  "}});",
  ""
].join("\n");
writeFileSync(new URL("./lib/client.js", import.meta.url), wrapped);
