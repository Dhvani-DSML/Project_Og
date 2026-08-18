"use client";

import { useState } from "react";
import GraphVisualization from "./GraphVisualization";
import CompressionBar from "./CompressionBar";

type IngestStats = {
  files: number;
  symbols: number;
  totalCalls: number;
  resolvedCalls: number;
  resolutionRate: string;
};

type TokenStats = {
  beforeTokens: number;
  afterTokens: number;
  reductionPercent: number;
};

type Citation = {
  symbolId: string;
  file: string;
  startLine: number;
  endLine: number;
};

type WalkedEdge = { source: string; target: string };

type Message = {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  taskType?: string;
  walkedNodes?: string[];
  walkedEdges?: WalkedEdge[];
  targetSymbolHint?: string | null;
};

export default function ChatPanel() {
  const [repoInput, setRepoInput] = useState("");
  const [ingestState, setIngestState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [repoKey, setRepoKey] = useState<string | null>(null);
  const [ingestStats, setIngestStats] = useState<IngestStats | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [questionInput, setQuestionInput] = useState("");
  const [queryLoading, setQueryLoading] = useState(false);
  const [lastTokenStats, setLastTokenStats] = useState<TokenStats | null>(null);

  async function handleIngest(e: React.FormEvent) {
    e.preventDefault();
    if (!repoInput.trim() || ingestState === "loading") return;
    setIngestState("loading");
    setIngestError(null);
    setRepoKey(null);
    setIngestStats(null);
    setMessages([]);
    setLastTokenStats(null);

    try {
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: repoInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Ingestion failed.");
      setRepoKey(data.repoKey);
      setIngestStats(data.stats);
      setIngestState("success");
    } catch (err: any) {
      setIngestError(err.message ?? String(err));
      setIngestState("error");
    }
  }

  async function handleAsk(e: React.FormEvent) {
    e.preventDefault();
    if (!questionInput.trim() || !repoKey || queryLoading) return;
    const question = questionInput.trim();
    setQuestionInput("");
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setQueryLoading(true);

    try {
      const res = await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoKey, question }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Query failed.");
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.answer,
          citations: data.citations,
          taskType: data.taskType,
          walkedNodes: data.walkedNodes,
          walkedEdges: data.walkedEdges,
          targetSymbolHint: data.targetSymbolHint,
        },
      ]);
      setLastTokenStats(data.tokenStats);
    } catch (err: any) {
      setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${err.message ?? String(err)}` }]);
    } finally {
      setQueryLoading(false);
    }
  }

  return (
    <div className="app">
      <header className="header">
        <h1>Ripple</h1>
        <p className="subtitle">See how a change ripples through your codebase, not just what looks similar.</p>
      </header>

      <form className="ingest-form" onSubmit={handleIngest}>
        <input
          type="text"
          placeholder="Local dir, GitHub URL, or owner/repo (e.g. sindresorhus/p-timeout)"
          value={repoInput}
          onChange={(e) => setRepoInput(e.target.value)}
          disabled={ingestState === "loading"}
        />
        <button type="submit" disabled={ingestState === "loading" || !repoInput.trim()}>
          {ingestState === "loading" ? "Ingesting…" : "Ingest repo"}
        </button>
      </form>

      {ingestState === "loading" && (
        <p className="status status-loading">
          Parsing, building the call graph, embedding symbols, and indexing — this can take a while on a real repo.
        </p>
      )}
      {ingestState === "error" && <p className="status status-error">{ingestError}</p>}
      {ingestState === "success" && ingestStats && (
        <p className="status status-success">
          Ingested {ingestStats.files} files, {ingestStats.symbols} symbols, {ingestStats.resolvedCalls}/
          {ingestStats.totalCalls} calls resolved ({ingestStats.resolutionRate}).
        </p>
      )}

      {lastTokenStats && (
        <CompressionBar
          beforeTokens={lastTokenStats.beforeTokens}
          afterTokens={lastTokenStats.afterTokens}
          reductionPercent={lastTokenStats.reductionPercent}
        />
      )}

      <div className="chat">
        {messages.map((m, i) => (
          <div key={i} className={`message message-${m.role}`}>
            <div className="message-role">{m.role === "user" ? "You" : "Ripple"}</div>
            <div className="message-content">{m.content}</div>
            {m.citations && m.citations.length > 0 && (
              <div className="citations">
                {m.citations.map((c) => (
                  <span key={c.symbolId} className="citation-pill" title={c.symbolId}>
                    {c.file}:{c.startLine}-{c.endLine}
                  </span>
                ))}
              </div>
            )}
            {/* Only worth rendering when there's an actual traversed path to
                show -- a pure semantic answer's walkedNodes are disconnected
                vector matches, not a graph, so a "graph" of floating dots
                wouldn't demonstrate anything. */}
            {m.walkedEdges && m.walkedEdges.length > 0 && (
              <GraphVisualization
                walkedNodes={m.walkedNodes ?? []}
                walkedEdges={m.walkedEdges}
                targetSymbolHint={m.targetSymbolHint ?? null}
              />
            )}
          </div>
        ))}
        {queryLoading && (
          <div className="message message-assistant message-pending">
            <span className="ripple-loader" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            Thinking…
          </div>
        )}
      </div>

      <form className="ask-form" onSubmit={handleAsk}>
        <input
          type="text"
          placeholder={repoKey ? "Ask about this repo…" : "Ingest a repo first"}
          value={questionInput}
          onChange={(e) => setQuestionInput(e.target.value)}
          disabled={!repoKey || queryLoading}
        />
        <button type="submit" disabled={!repoKey || queryLoading || !questionInput.trim()}>
          Ask
        </button>
      </form>
    </div>
  );
}
