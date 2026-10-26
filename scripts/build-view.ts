import { join } from "node:path";

const repo = join(import.meta.dir, "..");

/** Bundles the view into `<outdir>/view.js`: one file with the styles and every dependency inside, as Mirador serves it. */
export async function buildView(outdir: string) {
  const result = await Bun.build({
    entrypoints: [join(repo, "web", "main.tsx")],
    outdir,
    naming: "view.js",
    target: "browser",
    format: "esm",
    minify: true,
    splitting: false,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!result.success) throw new Error(`Building the view failed:\n${result.logs.join("\n")}`);
  if (result.outputs.length !== 1) throw new Error(`Expected one output file, got ${result.outputs.map(({ path }) => path).join(", ")}`);
  return result.outputs[0]!;
}

if (import.meta.main) {
  const output = await buildView(join(repo, "dist"));
  console.log(`${output.path}: ${(output.size / 1024).toFixed(0)} KB`);
}
