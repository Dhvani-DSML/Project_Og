"use client";

import { useEffect, useState } from "react";

type Props = {
  beforeTokens: number;
  afterTokens: number;
  reductionPercent: number;
};

/**
 * Renders as a full-width track on mount, then animates down to the actual
 * before/after ratio a tick later -- the CSS transition needs a state flip
 * after first paint to actually animate rather than snap straight to its
 * final width.
 */
export default function CompressionBar({ beforeTokens, afterTokens, reductionPercent }: Props) {
  const [settled, setSettled] = useState(false);
  const ratio = beforeTokens > 0 ? Math.min(afterTokens / beforeTokens, 1) : 1;

  useEffect(() => {
    setSettled(false);
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setSettled(true)));
    return () => cancelAnimationFrame(id);
  }, [beforeTokens, afterTokens]);

  return (
    <div className="token-panel">
      <div className="token-panel-label">Context compression, last query</div>
      <div className="token-panel-bar-track">
        <div className="token-panel-bar-fill" style={{ width: settled ? `${ratio * 100}%` : "100%" }} />
      </div>
      <div className="token-panel-number">
        {beforeTokens.toLocaleString()} <span className="token-panel-arrow">→</span> {afterTokens.toLocaleString()}
        <span className="token-panel-unit"> tokens</span>
      </div>
      <div className="token-panel-reduction">
        {reductionPercent >= 0
          ? `${reductionPercent}% reduction`
          : `${Math.abs(reductionPercent)}% larger (nothing here was worth compressing)`}
      </div>
    </div>
  );
}
