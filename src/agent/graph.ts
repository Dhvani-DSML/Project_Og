import { StateGraph, START, END, Command } from "@langchain/langgraph";
import { AgentStateAnnotation } from "./state";
import { classifyQuery } from "./nodes/router";
import { traverseGraph } from "./nodes/graph-traversal";
import { retrieveByVector, isLowConfidence } from "./nodes/vector-retrieval";
import { compressContext } from "./nodes/compress";
import { generateAnswer } from "./nodes/answer";
import type { AgentState } from "./state";

const builder = new StateGraph(AgentStateAnnotation)
  .addNode("router", async (state: AgentState) => {
    const { taskType, targetSymbolHint } = await classifyQuery(state.query);
    return { taskType, targetSymbolHint };
  })
  .addNode("graphTraversal", async (state: AgentState) => {
    const graphResults = await traverseGraph(state.repoKey, state.targetSymbolHint, state.hopDepth);
    return { graphResults, walkedNodes: graphResults.map((r) => r.nodeId) };
  })
  .addNode("vectorRetrieval", async (state: AgentState) => {
    const vectorResults = await retrieveByVector(state.repoKey, state.query);
    return { vectorResults, walkedNodes: vectorResults.map((r) => r.id) };
  })
  // Gate nodes, not plain conditional edges, because the fallback loop needs
  // to both DECIDE where to go next AND update state (fallbackAttempted,
  // hopDepth) in the same step -- Command is the mechanism LangGraph
  // provides for a node to do both instead of a pure routing function that
  // can only pick a destination.
  .addNode(
    "graphQualityGate",
    (state: AgentState) => {
      if (!state.fallbackAttempted) {
        // Single-path structural query found no anchor in the graph at all --
        // the router named a symbol that doesn't exist, or misfired. Nothing
        // left to try on the graph side; fall back to semantic search on the
        // raw query rather than compressing an empty result.
        if (state.taskType === "structural" && state.graphResults.length === 0) {
          return new Command({ update: { fallbackAttempted: true }, goto: "vectorRetrieval" });
        }
        // BFS frontier was still non-empty when traversal stopped at the hop
        // cutoff -- there's likely more graph beyond it. Confirmed real, not
        // theoretical: see README, loadConfig's blast radius on sample-repo.
        // Applies regardless of taskType (truncation is truncation whether
        // this run is structural-only or "both").
        if (state.graphResults.some((r) => r.hops === state.hopDepth)) {
          return new Command({
            update: { fallbackAttempted: true, hopDepth: state.hopDepth + 1 },
            goto: "graphTraversal",
          });
        }
      }
      return new Command({ goto: "compress" });
    },
    { ends: ["vectorRetrieval", "graphTraversal", "compress"] }
  )
  .addNode(
    "vectorQualityGate",
    (state: AgentState) => {
      // Single-path semantic query came back weak or empty. Only worth
      // falling back to the graph if the router actually extracted a symbol
      // name to anchor on -- a genuinely nameless semantic question ("how
      // does the connection pooling work") has nothing for graph traversal to
      // start from, so there's no point routing there just to get another
      // empty result.
      if (
        !state.fallbackAttempted &&
        state.taskType === "semantic" &&
        state.targetSymbolHint &&
        isLowConfidence(state.vectorResults)
      ) {
        return new Command({ update: { fallbackAttempted: true }, goto: "graphTraversal" });
      }
      return new Command({ goto: "compress" });
    },
    { ends: ["graphTraversal", "compress"] }
  )
  .addNode("compress", async (state: AgentState) => {
    return compressContext(state.repoKey, state.graphResults, state.vectorResults);
  })
  .addNode("generateAnswer", async (state: AgentState) => {
    return generateAnswer(state.query, state.compressedContext);
  });

builder
  .addEdge(START, "router")
  .addConditionalEdges(
    "router",
    (state: AgentState) => {
      if (state.taskType === "structural") return ["graphTraversal"];
      if (state.taskType === "semantic") return ["vectorRetrieval"];
      return ["graphTraversal", "vectorRetrieval"];
    },
    ["graphTraversal", "vectorRetrieval"]
  )
  .addEdge("graphTraversal", "graphQualityGate")
  .addEdge("vectorRetrieval", "vectorQualityGate")
  .addEdge("compress", "generateAnswer")
  .addEdge("generateAnswer", END);

export const agentGraph = builder.compile();
