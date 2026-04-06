import { readFileSync } from "fs";
import { execSync } from "child_process";

// Build Tailwind CSS
execSync("bunx @tailwindcss/cli -i src/styles/input.css -o dist/index.css --minify", {
  stdio: "inherit",
});

const solidPlugin: import("bun").BunPlugin = {
  name: "solid",
  setup(build) {
    build.onLoad({ filter: /\.[tj]sx$/ }, async (args) => {
      const { transformSync } = await import("@babel/core");
      const code = readFileSync(args.path, "utf-8");
      const result = transformSync(code, {
        presets: [
          ["babel-preset-solid"],
          ["@babel/preset-typescript", { isTSX: true, allExtensions: true }],
        ],
        filename: args.path,
      });
      return { contents: result?.code ?? "", loader: "js" };
    });
  },
};

const result = await Bun.build({
  entrypoints: ["./src/index.tsx"],
  outdir: "./dist",
  minify: process.argv.includes("--minify"),
  sourcemap: process.argv.includes("--sourcemap") ? "external" : "none",
  target: "browser",
  plugins: [solidPlugin],
});

if (!result.success) {
  console.error("Build failed:");
  for (const msg of result.logs) {
    console.error(msg);
  }
  process.exit(1);
}

console.log(`✓ Built ${result.outputs.length} file(s) to dist/`);
