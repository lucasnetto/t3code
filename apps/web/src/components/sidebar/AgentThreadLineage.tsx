export function agentThreadLineageLabel(parentTitle: string, turnId: string): string {
  return `Agent thread created from ${parentTitle}, spawning turn ${turnId}`;
}

export function AgentThreadLineage({
  parentTitle,
  turnId,
}: {
  readonly parentTitle: string;
  readonly turnId: string;
}) {
  const accessibleLineage = agentThreadLineageLabel(parentTitle, turnId);

  return (
    <span
      className="max-w-28 shrink-0 truncate"
      aria-label={accessibleLineage}
      title={accessibleLineage}
    >
      Agent · from {parentTitle}
    </span>
  );
}
