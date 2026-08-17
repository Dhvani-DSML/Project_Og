/** @type {import('next').NextConfig} */
const nextConfig = {
  // web-tree-sitter and @xenova/transformers do Node-native file I/O
  // (loading WASM grammars, reading the bundled ONNX model off disk via
  // process.cwd()-relative paths). Letting the bundler process them risks
  // breaking that -- keep them external so API routes require() them at
  // runtime exactly like the tsx scripts already do.
  serverExternalPackages: ["web-tree-sitter", "@xenova/transformers", "tree-sitter-wasms"],
};

export default nextConfig;
