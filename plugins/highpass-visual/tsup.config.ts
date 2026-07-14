import { defineConfig } from "tsup";
import type { Plugin } from "esbuild";

const omitOptionalFsevents: Plugin = {
  name: "omit-optional-fsevents",
  setup(build) {
    build.onResolve({ filter: /^fsevents$/ }, () => ({ path: "fsevents", namespace: "highpass-empty" }));
    build.onLoad({ filter: /.*/, namespace: "highpass-empty" }, () => ({ contents: "module.exports = {};", loader: "js" }));
  }
};

export default defineConfig({
  entry: {
    "mcp-server": "src/mcp-server-cli.ts"
  },
  format: ["cjs"],
  platform: "node",
  target: "node20",
  bundle: true,
  noExternal: [/.*/],
  esbuildPlugins: [omitOptionalFsevents],
  metafile: true,
  clean: true,
  sourcemap: false
});
