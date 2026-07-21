// Between — the first-run empty state. Shown when the store holds no threads
// because nothing has been imported yet (NOT because a filter matched nothing;
// that case still reads "No one by that name." in ConversationList). A calm
// panel that names the one command which starts everything, and points at the
// phone-export steps for the person who hasn't made an archive yet.
import { useCallback, useState } from 'react';
import { VOICE_INTERIM } from '../lib/voice';

// The exact ingest invocation (README §"Run it"). Kept verbatim and unbroken so
// it survives a copy — <your-export>.xml is a placeholder for the real filename.
const INGEST_CMD = 'npx tsx server/src/cli/ingest.ts <your-export>.xml';

export function FirstRunEmpty() {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(() => {
    navigator.clipboard?.writeText(INGEST_CMD).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      },
      () => { /* clipboard unavailable — the command is still readable */ },
    );
  }, []);

  return (
    <div className="firstrun" role="note">
      <div className="firstrun-inner">
        <h3 className="firstrun-title">{VOICE_INTERIM.firstRunTitle}</h3>
        <p className="firstrun-body">{VOICE_INTERIM.firstRunBody}</p>

        <p className="firstrun-cmd-label">{VOICE_INTERIM.firstRunCmdLabel}</p>
        <div className="firstrun-cmd">
          <code>{INGEST_CMD}</code>
          <button
            type="button"
            className="firstrun-copy"
            onClick={onCopy}
            aria-label="Copy the import command"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>

        <p className="firstrun-hint">{VOICE_INTERIM.firstRunPhoneHint}</p>
      </div>
    </div>
  );
}
