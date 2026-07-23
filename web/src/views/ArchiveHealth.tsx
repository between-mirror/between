// Between — Archive health. What is actually in this archive, said plainly, before anything else
// draws a line through it.
//
// This view has one job and it is not a pleasant one: to make missing data as visible as present
// data. Every other Explore view renders a shape over whatever the archive happens to contain. If
// three months are absent because the conversation moved to another app, the timeline draws a calm
// stretch and the eras layer gives it a name, and a reader concludes something false about their own
// life. That is the most convincing wrong answer this software can produce.
//
// So: counts, gaps, and named suspicions — never a verdict. Each suspicion is a fact plus a
// hypothesis the owner can confirm in a second ("did you change phones around then?"). It never says
// what the shape means.
import { useEffect, useState } from 'react';
import type { ArchiveHealth as Health, SourceKind, ThreadSummary } from '../lib/api';
import { getArchiveHealth } from '../lib/api';
import { StatCard } from '../components/StatCard';

const LOADING = 'Counting what is here…';
const LOAD_ERROR =
  'The archive report did not come through. The conversation is still here — try again in a moment.';

function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function dayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

// What each export is called in the world the owner lives in, not in the schema.
const SOURCE_LABEL: Record<SourceKind, string> = {
  android_smsbackup: 'Android SMS Backup & Restore',
  whatsapp_txt: 'WhatsApp export',
  imessage_chatdb: 'iMessage (Mac chat.db)',
  imessage_backup: 'iMessage (iPhone backup)',
  generic_jsonl: 'Generic import',
  unknown: 'An import made before Between recorded formats',
};

interface Props {
  thread: ThreadSummary;
  tzOffsetHours?: number;
}

export function ArchiveHealth({ thread, tzOffsetHours }: Props) {
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true); setError(null); setHealth(null);
    getArchiveHealth(thread.id, tzOffsetHours, ctrl.signal)
      .then(setHealth)
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(LOAD_ERROR);
      })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [thread.id, tzOffsetHours]);

  if (loading) return <p className="view-loading">{LOADING}</p>;
  if (error) return <p className="view-error">{error}</p>;
  if (!health || health.volume.total === 0) {
    return <p className="view-empty">There are no messages in this conversation yet.</p>;
  }

  const h = health;
  const peak = Math.max(...h.months.map((m) => m.total), 1);
  const spans = h.source.spans ?? [];

  // Only the suspicions that actually fired. A report that always looks alarming teaches the reader
  // to skip it, which costs more than saying nothing.
  const flags: { key: string; title: string; body: string }[] = [];
  if (h.suspicions.attachmentsStopEarly) {
    flags.push({
      key: 'att',
      title: 'Picture messages stop before the conversation does',
      body: `The last attachment is in ${monthLabel(h.attachments.lastMonthWithAny!)}, but messages carry on `
        + `to ${dayLabel(h.span.lastMs)}. That usually means photos moved to RCS, iMessage or another app — `
        + `and if the photos moved, some of the conversation probably did too. It would not be in this file.`,
    });
  }
  if (h.suspicions.trailingCollapse) {
    flags.push({
      key: 'tail',
      title: 'The archive thins out near the end and never recovers',
      body: 'The final stretch holds a small fraction of the usual volume. A conversation that moved to '
        + 'another app looks exactly like this — and so does one that genuinely quietened. You know which.',
    });
  }
  if (h.suspicions.endsLongBeforeImport) {
    flags.push({
      key: 'stale',
      title: 'The archive ends well before it was exported',
      body: `The last message is ${dayLabel(h.span.lastMs)}, but the backup was taken later. If you were `
        + 'still texting in between, the backup did not capture all of it.',
    });
  }
  if (h.suspicions.lopsided) {
    flags.push({
      key: 'sided',
      title: 'One side is barely represented',
      body: `${h.volume.me.toLocaleString()} from you, ${h.volume.them.toLocaleString()} from them. A restore that `
        + 'dropped one direction reads as silence from that person, and every count here inherits the error.',
    });
  }

  return (
    <section className="health" aria-label="Archive health">
      <header className="health-head">
        <h2>What is in this archive</h2>
        <p className="health-lede">
          Every other view draws a shape over these messages. This one is about what is <em>missing</em>,
          because a quiet month and an absent month look identical on a chart and mean opposite things.
        </p>
      </header>

      <div className="stat-row">
        <StatCard label="Messages" value={h.volume.total.toLocaleString()} />
        <StatCard label="Span" value={`${h.span.months} months`} detail={`${dayLabel(h.span.firstMs)} – ${dayLabel(h.span.lastMs)}`} />
        <StatCard label="Days with any message" value={`${pct(h.span.activeDayShare)}`} detail={`${h.span.activeDays.toLocaleString()} days`} />
        <StatCard label="Typical month" value={h.volume.median.perMonth.toLocaleString()} detail="median messages" />
      </div>

      {flags.length > 0 && (
        <div className="health-flags">
          <h3>Worth checking before you read anything else</h3>
          {flags.map((f) => (
            <div className="note clay" key={f.key}>
              <p><strong>{f.title}</strong></p>
              <p>{f.body}</p>
            </div>
          ))}
        </div>
      )}

      <h3>Month by month</h3>
      <p className="health-note">
        Empty months are shown as empty, not skipped. A bar below the line is a month with far less in
        it than this archive's own normal — not a quiet month by anyone else's standard.
      </p>
      <ol className="health-months">
        {h.months.map((m) => (
          <li key={m.month} className={`health-month${m.total === 0 ? ' health-month--empty' : ''}${m.belowFloor ? ' health-month--thin' : ''}`}>
            <span className="health-month-label">{monthLabel(m.month)}</span>
            <span className="health-month-bar" aria-hidden="true">
              <span className="health-month-fill" style={{ width: `${Math.round((m.total / peak) * 100)}%` }} />
            </span>
            <span className="health-month-n">
              {m.total === 0 ? 'nothing' : m.total.toLocaleString()}
              {m.total > 0 && ` · ${m.activeDays}/${m.daysInMonth} days`}
            </span>
          </li>
        ))}
      </ol>

      {h.gaps.length > 0 && (
        <>
          <h3>Stretches with nothing at all</h3>
          <ul className="health-gaps">
            {h.gaps.map((g) => (
              <li key={g.fromMonth}>
                <strong>{monthLabel(g.fromMonth)} – {monthLabel(g.toMonth)}</strong>
                {' '}({g.months} {g.months === 1 ? 'month' : 'months'}).
                {g.lastBeforeMs != null && g.firstAfterMs != null && (
                  <> Last message {dayLabel(g.lastBeforeMs)}, next {dayLabel(g.firstAfterMs)}.</>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>How this was read</h3>
      <ul className="health-facts">
        <li>
          {/* The demo reads frozen JSON from disk, which can lag a shape change; an absent list
              reads as "not recorded" rather than taking the view down. */}
          <strong>{spans.length > 1 ? 'Sources.' : 'Source.'}</strong>{' '}
          {spans.length === 0 ? 'Not recorded.' : spans.map((s, i) => (
            <span key={s.kind}>
              {i > 0 && ' · '}
              {SOURCE_LABEL[s.kind] ?? s.kind}, {dayLabel(s.firstMs)}–{dayLabel(s.lastMs)}
              {spans.length > 1 && ` (${s.messages.toLocaleString()})`}
            </span>
          ))}
          {h.source.files > 1 && `, across ${h.source.files} files`}
          {h.source.importedAt && ` · imported ${dayLabel(Date.parse(h.source.importedAt))}`}
        </li>
        {spans.length > 1 && (
          // The line that matters in a mixed archive: a stretch only one source can see is a
          // stretch where the other source's absence proves nothing.
          <li><strong>Where they overlap.</strong> Each source is complete only for its own span.
            A quiet stretch inside one of these dates may simply be a stretch the other source was
            not covering — absence in one place is not absence in a life.</li>
        )}
        <li>
          <strong>Times.</strong> Bucketed at UTC{h.timezone.offsetHours >= 0 ? '+' : ''}{h.timezone.offsetHours}.
          {h.timezone.assumed
            ? ' Nobody has confirmed this, so it is an assumption — and every hour-of-day and day-boundary here rests on it.'
            : ' Set by you in Settings.'}
        </li>
        <li>
          <strong>Attachments.</strong> {h.attachments.messages.toLocaleString()} messages carry one
          {h.attachments.smilOnly > 0 && `, of which ${h.attachments.smilOnly.toLocaleString()} hold only layout data and no actual media`}.
          {h.attachments.lastMonthWithAny && ` Last seen ${monthLabel(h.attachments.lastMonthWithAny)}.`}
        </li>
        <li><strong>Reactions.</strong> {h.volume.reactions.toLocaleString()} excluded from every count, here and everywhere else.</li>
        {h.duplicates.collapsed > 0 && (
          <li>
            <strong>Duplicates.</strong> {h.duplicates.collapsed.toLocaleString()} repeated rows
            collapsed at import — across the whole archive, not only this conversation. It is
            counted by comparing what each file said it held against what the archive stored, and a
            file usually covers many conversations, so the number cannot be split between them.
          </li>
        )}
        {h.group.relatedThreads > 0 && (
          <li>
            <strong>Other threads.</strong> {h.group.relatedThreads} other {h.group.relatedThreads === 1 ? 'conversation shares' : 'conversations share'} a
            participant with this one. Things said there are not counted here.
          </li>
        )}
        {h.identity.ambiguous.length > 0 && (
          <li>
            <strong>Identity.</strong> {h.identity.ambiguous.length === 1 ? 'One person is' : `${h.identity.ambiguous.length} people are`} reachable
            at more than one number, and those were merged. Usually right; worth knowing before reading who said what.
          </li>
        )}
      </ul>

      <p className="health-close">
        None of this is a judgement about the relationship. It is a description of the file.
      </p>
    </section>
  );
}
