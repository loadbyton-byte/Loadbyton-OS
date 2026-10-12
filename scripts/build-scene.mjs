// Bundles the hero scene (three.js, tree-shaken) into public/assets/scene3d.js. Run: npm run build:scene
import { build } from "esbuild";
await build({ entryPoints: ["web-src/scene3d.src.js"], bundle: true, minify: true, format: "esm", target: "es2020", outfile: "public/assets/scene3d.js", legalComments: "none", logLevel: "info" });
