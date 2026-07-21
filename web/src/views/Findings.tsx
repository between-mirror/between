// Between — "The findings": the final insight layer (A–E). Deterministic, counted, never graded.
// A the ledger of hands (physical + death-wish disclosures, both sides — keyword flags, weighed
// not tallied), B kids claimed vs shared, C the apology economics, D how the owner leaves a fight
// across the eras, E the wearing-down curve. Palette convention holds: amber (--warmth) is you,
// slate (--tension) is the other person, clay (--clay) is severity. Nothing red/green, nothing a verdict.
// The flagged messages sit behind a disclosure — the tab should not open into the hardest words.
import { useEffect, useState } from 'react';
import type { ThreadSummary, Findings as FindingsData, LedgerEntry, Exit, CalibrationStatus } from '../lib/api';
import { getFindings, getCalibrationStatus } from '../lib/api';
import { StatCard } from '../components/StatCard';

const LOADING = 'Counting the last five questions…';
const LOAD_ERROR = 'The findings did not come through. The conversation is still here — try again in a moment.';

interface FindingsProps {
  thread: ThreadSummary;
  onOpenReceipt?: (messageId: number, sentAtMs: number) => void;
}

const nf = (n: number): string => n.toLocaleString();
const pc = (x: number): string => `${Math.round(x * 100)}%`;
const ratio = (my: number, our: number): string => (our ? (my / our).toFixed(2) : my ? '∞' : '0');
const dayLabel = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const fmtDate = (iso: string): string => {
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(ms) ? iso : dayLabel.format(new Date(ms));
};

export function Findings({ thread, onOpenReceipt }: FindingsProps) {
  const [data, setData] = useState<FindingsData | null>(null);
  const [cal, setCal] = useState<CalibrationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setData(null); setError(null); setCal(null);
    getFindings(thread.id, ctrl.signal)
      .then((d) => setData(d))
      .catch((e) => { if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : LOAD_ERROR); });
    getCalibrationStatus(thread.id, ctrl.signal).then(setCal).catch(() => { /* non-fatal */ });
    return () => ctrl.abort();
  }, [thread.id]);

  return (
    <div className="overview" tabIndex={-1}>
      <div className="overview-scroll" tabIndex={0}>
        {!data && !error ? <p className="overview-status">{LOADING}</p>
          : error ? <p className="overview-status overview-status--error">{error}</p>
          : data ? <FindingsBody data={data} cal={cal} onOpenReceipt={onOpenReceipt} /> : null}
      </div>
    </div>
  );
}

// The other party, in copy. Not a pronoun: the app knows which number is yours and what you named
// the other person, and nothing else about either of you.
const them = 'them';

function FindingsBody({ data, cal, onOpenReceipt }: { data: FindingsData; cal: CalibrationStatus | null; onOpenReceipt?: (id: number, ms: number) => void }) {
  const deathWishes = data.ledger.byDir.death_wish.me + data.ledger.byDir.death_wish.them;
  return (
    <div className="overview-inner">
      <section className="ov-section" aria-label="The findings">
        <div className="ov-head">
          <h2 className="ov-title">The findings</h2>
          <p className="ov-sub">Five harder questions, answered by counting — never graded. Amber is you, slate is {them}.</p>
        </div>
      </section>

      {cal && !cal.calibrated && (
        <section className="ov-section" aria-label="Not yet calibrated">
          <div className="cal2-provisional" role="note">
            <b>Not yet tuned to you.</b> These counts use shipped defaults, and the honesty check that keeps the
            direction fair hasn't run. Read anything about <em>who</em> as provisional until you finish the
            <b> Calibrate</b> tab — it takes a few minutes and everything directional depends on it.
          </div>
        </section>
      )}

      {deathWishes > 0 && <CrisisBanner />}
      <LedgerSection data={data} onOpenReceipt={onOpenReceipt} />
      <KidsSection data={data} />
      <ApologySection data={data} />
      <ExitSection data={data} />
      <WearingSection data={data} />
    </div>
  );
}

// ── crisis resource — deterministic, shown whenever a death-wish exists on either side.
// Never depends on the model prose and never suppressed by age; this is the load-bearing safety net.
function CrisisBanner() {
  return (
    <section className="ov-section" aria-label="If you are not safe">
      <div className="findings-crisis" role="note">
        <p>Some of what's counted below is people saying they don't want to be here. This is a mirror, not a ruling —
          if <em>"I want to die"</em> is true for you or for them right now, the next move is a person, not a text.</p>
        <p className="findings-crisis-line">In the US, call or text <b>988</b> (Suicide &amp; Crisis Lifeline). Outside the US, reach your local crisis line, or someone who can sit with you today.</p>
      </div>
    </section>
  );
}

// ── A · the ledger of hands ───────────────────────────────────────────────────
function LedgerSection({ data, onOpenReceipt }: { data: FindingsData; onOpenReceipt?: (id: number, ms: number) => void }) {
  const { byDir, entries } = data.ledger;
  const recent = [...entries].sort((a, b) => b.ms - a.ms).slice(0, 40);
  return (
    <section className="ov-section" aria-label="The ledger of hands">
      <div className="ov-head">
        <h2 className="ov-title">The ledger of hands</h2>
        <p className="ov-sub">
          Keyword disclosures — admissions, threats, and accusations tangled together. Weigh them; do not tally them.
        </p>
      </div>
      <div className="statcards">
        <StatCard label="Physical harm named" tone="tension"
          value={<>You <span className="tnum">{nf(byDir.physical.me)}</span> · {them} <span className="tnum">{nf(byDir.physical.them)}</span></>}
          detail="admissions, threats, accusations — flagged by words, not adjudicated" />
        <StatCard label="Death-wishes" tone="tension"
          value={<>You <span className="tnum">{nf(byDir.death_wish.me)}</span> · {them} <span className="tnum">{nf(byDir.death_wish.them)}</span></>}
          detail="said to each other across eight years" />
      </div>
      <details className="findings-reveal">
        <summary>Show the flagged messages ({nf(entries.length)}) — the most recent {Math.min(40, recent.length)}</summary>
        <ul className="findings-ledger">
          {recent.map((e) => <LedgerRow key={e.id} e={e} onOpenReceipt={onOpenReceipt} />)}
        </ul>
      </details>
    </section>
  );
}

function LedgerRow({ e, onOpenReceipt }: { e: LedgerEntry; onOpenReceipt?: (id: number, ms: number) => void }) {
  const who = e.dir === 'me' ? 'you' : them;
  const accent = e.category === 'death_wish' ? 'var(--clay)' : e.dir === 'me' ? 'var(--warmth)' : 'var(--tension)';
  return (
    <li>
      <button type="button" className="findings-ledger-row" onClick={() => onOpenReceipt?.(e.id, e.ms)}
        title="Open this message in the transcript">
        <span className="findings-ledger-meta">
          <i className="findings-dot" style={{ background: accent }} aria-hidden />
          <span className="findings-ledger-when">{fmtDate(e.date)}</span>
          <span className="findings-ledger-who">{who}</span>
          <span className="findings-ledger-cat">{e.category === 'death_wish' ? 'death-wish' : 'physical'}</span>
        </span>
        <span className="findings-ledger-text">{e.text}</span>
      </button>
    </li>
  );
}

// ── B · kids in the crossfire ─────────────────────────────────────────────────
function KidsSection({ data }: { data: FindingsData }) {
  const k = data.kidsFraming.total;
  return (
    <section className="ov-section" aria-label="Kids in the crossfire">
      <div className="ov-head">
        <h2 className="ov-title">Kids in the crossfire</h2>
        <p className="ov-sub">"My kids" versus "our kids." A higher my:our ratio is a child claimed, not shared.</p>
      </div>
      <div className="statcards">
        <StatCard label="You" tone="warmth"
          value={<>my <span className="tnum">{nf(k.myMe)}</span> · our <span className="tnum">{nf(k.ourMe)}</span></>}
          detail={`my:our ${ratio(k.myMe, k.ourMe)}`} />
        <StatCard label={them} tone="tension"
          value={<>my <span className="tnum">{nf(k.myThem)}</span> · our <span className="tnum">{nf(k.ourThem)}</span></>}
          detail={`my:our ${ratio(k.myThem, k.ourThem)}`} />
      </div>
    </section>
  );
}

// ── C · the apology economics ─────────────────────────────────────────────────
function ApologySection({ data }: { data: FindingsData }) {
  const r = data.apology.firstRepairAfterPeak;
  const m = data.apology.metWithFire;
  return (
    <section className="ov-section" aria-label="The apology economics">
      <div className="ov-head">
        <h2 className="ov-title">The apology economics</h2>
        <p className="ov-sub">Who knocks first after a fight — and what the knock is met with.</p>
      </div>
      <div className="statcards">
        <StatCard label="Repairs first" tone="neutral"
          value={<>You <span className="tnum">{nf(r.me)}</span> · {them} <span className="tnum">{nf(r.them)}</span></>}
          detail={`${nf(r.none)} fights healed by no one`} />
        <StatCard label="Your apology met with fire" tone="tension"
          value={<span className="tnum">{pc(m.me.rate)}</span>}
          detail={`${nf(m.me.rejected)} of ${nf(m.me.total)}`} />
        <StatCard label="Their apology met with fire" tone="warmth"
          value={<span className="tnum">{pc(m.them.rate)}</span>}
          detail={`${nf(m.them.rejected)} of ${nf(m.them.total)}`} />
      </div>
    </section>
  );
}

// ── D · the exit signature ────────────────────────────────────────────────────
const EXIT_ORDER: { key: Exit; label: string; color: string }[] = [
  { key: 'met', label: 'met fire', color: 'var(--clay)' },
  { key: 'block_threat', label: 'block', color: 'var(--tension)' },
  { key: 'withdraw_silent', label: 'went silent', color: 'var(--ink-faint)' },
  { key: 'withdraw_notice', label: 'named pause', color: 'var(--warmth)' },
  { key: 'softened', label: 'softened', color: 'var(--warmth-glow)' },
];

function ExitSection({ data }: { data: FindingsData }) {
  const eras = data.exitSignature.byEra.filter((e) => e.total > 0);
  return (
    <section className="ov-section" aria-label="Your exit signature">
      <div className="ov-head">
        <h2 className="ov-title">How you leave a fight</h2>
        <p className="ov-sub">Your last move in each fight, era by era. Watch the silence grow.</p>
      </div>
      <div className="findings-legend">
        {EXIT_ORDER.map((s) => (
          <span key={s.key} className="findings-legend-item">
            <i className="findings-swatch" style={{ background: s.color, border: s.color === 'var(--warmth-glow)' ? '1px solid var(--line-2)' : 'none' }} aria-hidden />
            {s.label}
          </span>
        ))}
      </div>
      <ul className="findings-bars">
        {eras.map((e) => (
          <li key={e.startMs} className="findings-bar-row">
            <span className="findings-bar-label" title={e.name ?? undefined}>{e.name ?? '—'}</span>
            <span className="findings-bar-track" role="img"
              aria-label={EXIT_ORDER.map((s) => `${s.label} ${pc((e.counts[s.key] ?? 0) / e.total)}`).join(', ')}>
              {EXIT_ORDER.map((s) => {
                const w = (e.counts[s.key] ?? 0) / e.total;
                if (w <= 0) return null;
                return <i key={s.key} className="findings-bar-seg"
                  style={{ width: `${w * 100}%`, background: s.color, border: s.color === 'var(--warmth-glow)' ? '1px solid var(--line-2)' : 'none' }}
                  title={`${s.label} ${pc(w)}`} />;
              })}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── E · the wearing-down curve ────────────────────────────────────────────────
function WearingSection({ data }: { data: FindingsData }) {
  // collapse quarters → years for a readable curve of YOUR warmth / "i love you" / playful
  const byYear = new Map<number, { warmth: number; ily: number; play: number; n: number }>();
  for (const q of data.wearingDown.quarters) {
    const y = Number(q.quarter.slice(0, 4));
    const g = byYear.get(y) ?? { warmth: 0, ily: 0, play: 0, n: 0 };
    g.warmth += q.me.warmthRate; g.ily += q.me.ilyRate; g.play += q.me.playfulRate; g.n += 1;
    byYear.set(y, g);
  }
  const years = [...byYear.entries()].filter(([, g]) => g.n > 0).sort((a, b) => a[0] - b[0])
    .map(([year, g]) => ({ year, warmth: g.warmth / g.n, ily: g.ily / g.n, play: g.play / g.n }));
  const maxWarmth = Math.max(0.001, ...years.map((y) => y.warmth));

  return (
    <section className="ov-section" aria-label="The wearing-down curve">
      <div className="ov-head">
        <h2 className="ov-title">The wearing down</h2>
        <p className="ov-sub">Your warmth, "I love you," and play, year by year. Still talking — the question is whether still saying it.</p>
      </div>
      <ul className="findings-wear">
        {years.map((y) => (
          <li key={y.year} className="findings-wear-row">
            <span className="findings-wear-year tnum">{y.year}</span>
            <span className="findings-wear-track">
              <i className="findings-wear-fill" style={{ width: `${(y.warmth / maxWarmth) * 100}%`, background: 'var(--warmth)' }} aria-hidden />
            </span>
            <span className="findings-wear-nums">
              warmth <b className="tnum">{pc(y.warmth)}</b> · ily <b className="tnum">{pc(y.ily)}</b> · play <b className="tnum">{pc(y.play)}</b>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
