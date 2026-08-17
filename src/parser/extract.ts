import { Parser, Language, Node as SyntaxNode } from "web-tree-sitter";
import path from "node:path";
import fs from "node:fs";

const WASM_DIR = path.join(
  process.cwd(),
  "node_modules/tree-sitter-wasms/out"
);

let tsParser: Parser | null = null;
let tsxParser: Parser | null = null;

export async function initParsers() {
  await Parser.init();
  tsParser = new Parser();
  tsParser.setLanguage(
    await Language.load(path.join(WASM_DIR, "tree-sitter-typescript.wasm"))
  );
  tsxParser = new Parser();
  tsxParser.setLanguage(
    await Language.load(path.join(WASM_DIR, "tree-sitter-tsx.wasm"))
  );
}

function parserFor(filePath: string): Parser {
  if (!tsParser || !tsxParser) throw new Error("Call initParsers() first");
  return filePath.endsWith(".tsx") || filePath.endsWith(".jsx")
    ? tsxParser
    : tsParser;
}

export type SymbolNode = {
  id: string;          // "file.ts::functionName"
  name: string;
  kind: "function" | "class" | "const_fn" | "method";
  file: string;
  startLine: number;
  endLine: number;
  exported: boolean;
};

export type Edge = {
  from: string;         // symbol id or file id doing the calling
  to: string;            // resolved symbol id, or an unresolved raw name
  type: "calls" | "imports";
  resolved: boolean;
};

export type ImportBinding = {
  localName: string;     // name used inside this file
  sourcePath: string;    // raw import path, e.g. "./config"
};

export type FileGraph = {
  file: string;
  symbols: SymbolNode[];
  imports: ImportBinding[];
  edges: Edge[];
};

/**
 * Parses one file and extracts:
 *  - top-level function/class/const-arrow-function declarations (symbols)
 *  - import statements (bindings, unresolved paths)
 *  - call expressions inside each symbol's body (edges, unresolved names)
 * Resolution against OTHER files happens later, once all files are parsed
 * (see resolveEdges in graph.ts) — a single file can't resolve cross-file
 * calls on its own.
 */
export function extractFile(filePath: string, source: string): FileGraph {
  const parser = parserFor(filePath);
  const tree = parser.parse(source);
  const root = tree.rootNode;

  const symbols: SymbolNode[] = [];
  const imports: ImportBinding[] = [];
  const rawCalls: { from: string; calleeName: string }[] = [];

  const fileId = filePath;

  function symId(name: string) {
    return `${filePath}::${name}`;
  }

  function isExported(node: SyntaxNode): boolean {
    let p = node.parent;
    while (p) {
      if (p.type === "export_statement") return true;
      p = p.parent;
    }
    return false;
  }

  // Walk every call_expression inside a given subtree, recording the callee name.
  function collectCalls(node: SyntaxNode, ownerId: string) {
    for (const child of node.children) {
      if (child.type === "call_expression") {
        const fn = child.childForFieldName("function");
        if (fn) {
          // handles both `foo()` and `obj.foo()` — for the latter we take
          // the rightmost identifier, which is a heuristic, not full
          // type resolution.
          const name =
            fn.type === "identifier"
              ? fn.text
              : fn.type === "member_expression"
              ? fn.childForFieldName("property")?.text ?? fn.text
              : fn.text;
          rawCalls.push({ from: ownerId, calleeName: name });
        }
      }
      collectCalls(child, ownerId);
    }
  }

  for (const rawNode of root.children) {
    // `export function foo() {}` parses as export_statement -> function_declaration.
    // Unwrap it so the checks below see the real declaration node, while
    // isExported() (which walks back up parents) still reports true.
    const node =
      rawNode.type === "export_statement"
        ? rawNode.childForFieldName("declaration") ?? rawNode
        : rawNode;

    // import ... from "..."
    if (node.type === "import_statement") {
      const sourceNode = node.childForFieldName("source");
      const sourcePath = sourceNode ? sourceNode.text.replace(/['"]/g, "") : "";
      const clause = node.namedChildren.find(
        (c) => c.type === "import_clause"
      );
      if (clause) {
        for (const spec of clause.descendantsOfType([
          "import_specifier",
          "identifier",
          "namespace_import",
        ])) {
          const local =
            spec.childForFieldName("alias")?.text ?? spec.text;
          if (local && sourcePath) imports.push({ localName: local, sourcePath });
        }
      }
      continue;
    }

    // function foo() {}
    if (node.type === "function_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const id = symId(nameNode.text);
        symbols.push({
          id,
          name: nameNode.text,
          kind: "function",
          file: fileId,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: isExported(node),
        });
        collectCalls(node, id);
      }
    }

    // class Foo { method() {} }
    if (node.type === "class_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const classId = symId(nameNode.text);
        symbols.push({
          id: classId,
          name: nameNode.text,
          kind: "class",
          file: fileId,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: isExported(node),
        });
        const body = node.childForFieldName("body");
        if (body) {
          for (const member of body.namedChildren) {
            if (member.type === "method_definition") {
              const mName = member.childForFieldName("name");
              if (mName) {
                const methodId = `${classId}.${mName.text}`;
                symbols.push({
                  id: methodId,
                  name: `${nameNode.text}.${mName.text}`,
                  kind: "method",
                  file: fileId,
                  startLine: member.startPosition.row + 1,
                  endLine: member.endPosition.row + 1,
                  exported: isExported(node),
                });
                collectCalls(member, methodId);
              }
            }
          }
        }
      }
    }

    // const foo = (...) => {}   /   const foo = function() {}
    if (node.type === "lexical_declaration") {
      for (const decl of node.namedChildren) {
        if (decl.type !== "variable_declarator") continue;
        const nameNode = decl.childForFieldName("name");
        const valueNode = decl.childForFieldName("value");
        if (
          nameNode &&
          valueNode &&
          (valueNode.type === "arrow_function" ||
            valueNode.type === "function_expression")
        ) {
          const id = symId(nameNode.text);
          symbols.push({
            id,
            name: nameNode.text,
            kind: "const_fn",
            file: fileId,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            exported: isExported(node),
          });
          collectCalls(valueNode, id);
        }
      }
    }
  }

  const edges: Edge[] = rawCalls.map((c) => ({
    from: c.from,
    to: c.calleeName, // unresolved for now — resolved cross-file in graph.ts
    type: "calls",
    resolved: false,
  }));

  return { file: fileId, symbols, imports, edges };
}
