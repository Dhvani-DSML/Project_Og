/** @type {import('next').NextConfig} */
const nextConfig = {
  // web-tree-sitter and @xenova/transformers do Node-native file I/O
  // (loading WASM grammars, reading the bundled ONNX model off disk via
  // process.cwd()-relative paths). Letting the bundler process them risks
  // breaking that -- keep them external so API routes require() them at
  // runtime exactly like the tsx scripts already do.
  serverExternalPackages: ["web-tree-sitter", "@xenova/transformers", "tree-sitter-wasms"],
  // Both API routes load these via fs + path.join(process.cwd(), ...), not
  // a static import -- @vercel/nft's static analysis can miss that.
  //
  // The object keys here are ROUTE PATH globs matched against the route
  // (e.g. "/api/ingest"), NOT source-file globs -- confirmed against
  // Next's own docs after an earlier key of "src/app/api/**/*" turned out
  // to silently match nothing (verified by instrumenting
  // collect-build-traces.js directly: combinedIncludes.size was 0, so the
  // whole include/exclude step was a no-op the entire time; every file
  // that appeared to be "included" was actually picked up by the
  // bundler's own automatic trace, coincidentally).
  //
  // The onnxruntime-node entry is the real fix for a first-deploy
  // production failure: @xenova/transformers loads the ONNX model through
  // onnxruntime-node's native .node addon, which itself dlopen()s
  // libonnxruntime.so.1.14.0 (16.3MB) as a sibling file at the OS/native
  // level -- invisible to any JS-level tracer (no require()/import/fs call
  // references it). Locally via tsx this never showed up because tsx runs
  // against the full, untouched node_modules where the OS's own dynamic
  // linker just finds the sibling .so; only the deployed, traced function
  // bundle strips it out. First prod deploy failed with
  // "libonnxruntime.so.1.14.0: cannot open shared object file" until this
  // include was added (and the key format was fixed).
  outputFileTracingIncludes: {
    "/api/*": [
      "src/embeddings/models/**/*",
      "node_modules/tree-sitter-wasms/out/tree-sitter-typescript.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-tsx.wasm",
      "node_modules/onnxruntime-node/bin/napi-v3/linux/x64/**/*",
    ],
  },
  // Trims the other 34 tree-sitter grammars the tracer pulls in via the
  // externalized tree-sitter-wasms package (~50MB unused). Listed by name,
  // not a wildcard+negation glob -- Next's exclude matching does
  // path.join(dir, pattern) before handing patterns to picomatch, which
  // turns a leading "!" into a dead literal character rather than a
  // negation (verified directly against picomatch with the resolved
  // paths); a broad wildcard here would also delete the 2 grammars needed
  // above, since excludes apply after includes are merged in.
  outputFileTracingExcludes: {
    "/api/*": [
      "node_modules/tree-sitter-wasms/out/tree-sitter-bash.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-c.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-c_sharp.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-cpp.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-css.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-dart.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-elisp.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-elixir.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-elm.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-embedded_template.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-go.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-html.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-java.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-javascript.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-json.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-kotlin.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-lua.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-objc.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-ocaml.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-php.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-python.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-ql.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-rescript.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-ruby.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-rust.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-scala.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-solidity.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-swift.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-systemrdl.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-tlaplus.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-toml.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-vue.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-yaml.wasm",
      "node_modules/tree-sitter-wasms/out/tree-sitter-zig.wasm",
    ],
  },
};

export default nextConfig;
