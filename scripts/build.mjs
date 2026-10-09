import { build } from "esbuild";
import { cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const extension = join(root, "extension");
const output = join(root, "dist/extension");
await rm(output, { recursive: true, force: true });
await cp(extension, output, { recursive: true });
await cp(join(root, "LICENSE"), join(output, "LICENSE"));

for (const entry of ["background", "app"]) {
  await build({
    entryPoints: [join(extension, `${entry}.mjs`)],
    outfile: join(output, `${entry}.js`),
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "chrome116",
  });
}

console.log("Built Chrome extension in dist/extension/.");
