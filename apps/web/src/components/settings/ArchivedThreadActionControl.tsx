import { ArchiveX } from "lucide-react";

import { Button } from "../ui/button";

interface ArchivedThreadActionControlProps {
  readonly readOnly: boolean;
  readonly onUnarchive: () => void;
}

export function ArchivedThreadActionControl({
  readOnly,
  onUnarchive,
}: ArchivedThreadActionControlProps) {
  if (readOnly) {
    return (
      <span
        aria-label="Agent-created archived thread is read-only"
        className="text-[11px] font-medium text-muted-foreground"
      >
        Read only
      </span>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 shrink-0 cursor-pointer gap-1.5 px-2.5"
      onClick={onUnarchive}
    >
      <ArchiveX className="size-3.5" />
      <span>Unarchive</span>
    </Button>
  );
}
