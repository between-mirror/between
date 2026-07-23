// Between — the archive-health caution, on Home.
//
// The full report lives in Explore, and the reader who most needs it is exactly the reader who will
// never open it: they came to look at the river, the river looks calm, and the calm IS the missing
// data. A report nobody opens does not prevent the failure it was built to prevent, so the one-line
// version travels to where they already are.
//
// Two rules hold it in place. It says nothing at all when there is nothing to say — a card that
// always looks concerned is one people learn to scroll past, and it has then spent the attention it
// would need on the day something is actually wrong. And it never interprets: every line is a fact
// about the archive, with the door to the full report underneath.
import { useEffect, useState } from 'react';
import type { ArchiveHealth } from '../lib/api';
import { getArchiveHealth } from '../lib/api';

interface Props {
  threadId: number;
  /** Opens the full report. Absent in surfaces that cannot navigate. */
  onOpenReport?: () => void;
}

export function ArchiveCaution({ threadId, onOpenReport }: Props) {
  const [health, setHealth] = useState<ArchiveHealth | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setHealth(null);
    getArchiveHealth(threadId, undefined, ctrl.signal)
      .then(setHealth)
      .catch(() => {
        // Best-effort. If the count cannot be taken, Home stays quiet rather than claiming either
        // that the archive is whole or that something is wrong with it.
      });
    return () => ctrl.abort();
  }, [threadId]);

  const caution = health?.caution;
  if (!caution || caution.level === 'clear' || !caution.headline) return null;

  return (
    <aside className={`archive-caution archive-caution--${caution.level}`} aria-label="What this archive cannot see">
      <p className="archive-caution-head">{caution.headline}</p>
      {caution.reasons.length > 0 && (
        <ul className="archive-caution-reasons">
          {caution.reasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
      )}
      {onOpenReport && (
        <button type="button" className="link-btn archive-caution-more" onClick={onOpenReport}>
          See what this archive can and cannot show
        </button>
      )}
    </aside>
  );
}
