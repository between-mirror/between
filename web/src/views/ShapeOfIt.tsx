// Between — "The shape of it": the sentiment-free baseline. Every number here is
// counted, never interpreted — volume, rhythm, cadence, plain word frequency. No
// LLM, no valence. The palette still holds the convention: amber is you (the
// owner / outgoing), slate is her (the partner). Nothing is a grade; nothing is
// red or green. Facts stated plainly, offered without weather.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { AmbientStats, ThreadSummary } from '../lib/api';
import { getAmbient } from '../lib/api';
import { StatCard } from '../components/StatCard';

const LOADING = 'Counting the plain shape of it…';
const LOAD_ERROR =
  'The counts did not come through. The conversation is still here — try again in a moment.';

interface ShapeOfItProps {
  thread: ThreadSummary;
  /** Drill from a stat/receipt to the transcript at a message id. */
  onOpenReceipt?: (messageId: number, sentAtMs: number) => void;
}

// ── plain-language formatters ────────────────────────────────────────────────

function nf(n: number): string {
  return n.toLocaleString();
}

/** A reply latency in human units. Ambient gives minutes; 0/negative → "—". */
function humanMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '—';
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 24) return hours < 2 ? `${hours.toFixed(1)} hr` : `${Math.round(hours)} hr`;
  const days = hours / 24;
  return days < 2 ? 'about a day' : `${Math.round(days)} days`;
}

const dayLabel = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const monthLabel = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' });

/** A YYYY-MM-DD date key → "Mar 4, 2020". Empty/invalid → "—". */
function fmtDate(date: string): string {
  if (!date) return '—';
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) return date;
  return dayLabel.format(new Date(ms));
}

/** A "YYYY-MM" month key → "Mar 2020". */
function fmtMonth(ym: string): string {
  if (!ym) return '—';
  const ms = Date.parse(`${ym}-01T00:00:00Z`);
  if (Number.isNaN(ms)) return ym;
  return monthLabel.format(new Date(ms));
}

/** A UTC hour (0–23) as a compact clock label, e.g. "12a", "6a", "12p", "9p". */
function hourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  if (h === 0) return '12a';
  if (h === 12) return '12p';
  return h < 12 ? `${h}a` : `${h - 12}p`;
}

// ── the view ─────────────────────────────────────────────────────────────────

export function ShapeOfIt({ thread, onOpenReceipt }: ShapeOfItProps) {
  const [ambient, setAmbient] = useState<AmbientStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    setAmbient(null);
    getAmbient(thread.id, undefined, ctrl.signal)
      .then((a) => setAmbient(a))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(LOAD_ERROR);
      })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [thread.id]);

  return (
    <div className="overview" tabIndex={-1}>
      <div className="overview-scroll" tabIndex={0}>
        {loading ? (
          <p className="overview-status">{LOADING}</p>
        ) : error ? (
          <p className="overview-status overview-status--error">{error}</p>
        ) : ambient ? (
          <ShapeBody thread={thread} ambient={ambient} onOpenReceipt={onOpenReceipt} />
        ) : null}
      </div>
    </div>
  );
}

interface ShapeBodyProps {
  thread: ThreadSummary;
  ambient: AmbientStats;
  onOpenReceipt?: (messageId: number, sentAtMs: number) => void;
}

function ShapeBody({ thread, ambient }: ShapeBodyProps) {
  const her = thread.displayName.split(/\s+/)[0] || 'Them';
  const { volume, rhythm, cadence, language, extras } = ambient;

  const iLoveYou = language.iLoveYou;
  const endearments = extras.endearments;
  const apologies = extras.apologies;

  return (
    <div className="overview-inner">
      {/* 1 — the baseline report card */}
      <section className="ov-section" aria-label="Baseline counts">
        <div className="ov-head">
          <h2 className="ov-title">The shape of it</h2>
          <p className="ov-sub">
            Just the counts — no reading between the lines. Amber is you, slate is {her}.
          </p>
        </div>
        <div className="statcards">
          <StatCard
            label="Total messages"
            value={<span className="tnum">{nf(volume.total)}</span>}
            detail={<>You {nf(volume.me)} · {her} {nf(volume.them)}</>}
            title="Every message counted, both directions."
          />
          <StatCard
            label="Active days"
            value={<span className="tnum">{nf(volume.activeDays)}</span>}
            detail="days with at least one message"
            title="Distinct days that carried any message."
          />
          <StatCard
            label="Busiest day"
            tone="warmth"
            value={<span className="tnum">{nf(rhythm.busiestDay.count)}</span>}
            detail={rhythm.busiestDay.count > 0 ? fmtDate(rhythm.busiestDay.date) : 'none yet'}
            title="The single day with the most messages."
          />
          <StatCard
            label="Longest streak"
            value={<><span className="tnum">{nf(rhythm.longestStreakDays)}</span> days</>}
            detail={`longest quiet: ${nf(rhythm.longestSilenceDays)} days`}
            title="Longest unbroken run of days with messages, and the longest gap."
          />
          <StatCard
            label="Median reply"
            tone="tension"
            value={<>You {humanMinutes(cadence.medianReplyMinMe)} · {her} {humanMinutes(cadence.medianReplyMinThem)}</>}
            detail="a typical turnaround"
            title="Median minutes to reply, each side."
          />
          <StatCard
            label="“I love you”"
            tone="warmth"
            value={<>You <span className="tnum">{nf(iLoveYou.me)}</span> · {her} <span className="tnum">{nf(iLoveYou.them)}</span></>}
            detail={iLoveYou.me + iLoveYou.them === 0 ? 'not said in words' : 'said, in words'}
            title="Times the phrase “I love you” appears, each side."
          />
          <StatCard
            label="Terms of endearment"
            tone="warmth"
            value={<>You <span className="tnum">{nf(endearments.me)}</span> · {her} <span className="tnum">{nf(endearments.them)}</span></>}
            detail="babe, love, honey, and kin"
            title="Pet names and endearments, each side."
          />
          <StatCard
            label="Apologies"
            tone="tension"
            value={<>You <span className="tnum">{nf(apologies.me)}</span> · {her} <span className="tnum">{nf(apologies.them)}</span></>}
            detail="“sorry”, said either way"
            title="Times an apology was offered, each side."
          />
        </div>
      </section>

      {/* 2 — hour-of-day rhythm */}
      <HourOfDaySection hourOfDay={rhythm.hourOfDay} tzOffsetHours={ambient.tzOffsetHours} her={her} />

      {/* 3 — word maps */}
      <WordMapsSection
        topWordsMe={language.topWordsMe}
        topWordsThem={language.topWordsThem}
        her={her}
      />

      {/* 4 — emoji row */}
      <EmojiSection topEmoji={language.topEmoji} />

      {/* 5 — the more-grid */}
      <MoreGrid ambient={ambient} her={her} />
    </div>
  );
}

// ── hour-of-day bar chart ────────────────────────────────────────────────────

interface HourOfDaySectionProps {
  hourOfDay: { hour: number; me: number; them: number }[];
  tzOffsetHours: number;
  her: string;
}

function HourOfDaySection({ hourOfDay, tzOffsetHours, her }: HourOfDaySectionProps) {
  // Normalize to a full 24-slot array so every hour has a bar even at zero.
  const byHour = new Map(hourOfDay.map((h) => [h.hour, h]));
  const hours = Array.from({ length: 24 }, (_, hour) => {
    const h = byHour.get(hour);
    return { hour, me: h?.me ?? 0, them: h?.them ?? 0 };
  });
  const peak = hours.reduce((m, h) => Math.max(m, h.me + h.them), 0);

  if (peak === 0) {
    return (
      <section className="ov-section" aria-label="Hour of day">
        <div className="ov-head">
          <h2 className="ov-title">Hour of day</h2>
          <p className="ov-sub">Nothing to plot yet.</p>
        </div>
      </section>
    );
  }

  // Layout — a fixed viewBox; bars fill their column, stacked you-over-her.
  const W = 720;
  const H = 180;
  const padL = 8;
  const padR = 8;
  const padTop = 8;
  const padBottom = 22;
  const plotW = W - padL - padR;
  const plotH = H - padTop - padBottom;
  const slot = plotW / 24;
  const barW = Math.max(4, slot * 0.62);

  return (
    <section className="ov-section" aria-label="Hour of day">
      <div className="ov-head">
        <h2 className="ov-title">Hour of day</h2>
        <p className="ov-sub">
          When messages land, by the clock. Hours are UTC (offset {tzOffsetHours >= 0 ? '+' : ''}
          {tzOffsetHours}). Amber is you, slate is {her}.
        </p>
      </div>
      <div style={{
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius)',
        background: 'var(--surface)',
        padding: '14px 12px',
        overflowX: 'auto',
      }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="Messages by hour of day, you in amber and them in slate"
          style={{ display: 'block', minWidth: 480 }}
        >
          {hours.map(({ hour, me, them }) => {
            const total = me + them;
            const x = padL + hour * slot + (slot - barW) / 2;
            const totalH = (total / peak) * plotH;
            const themH = total > 0 ? (them / peak) * plotH : 0;
            const meH = totalH - themH;
            const yThem = padTop + plotH - themH;
            const yMe = yThem - meH;
            const showLabel = hour % 3 === 0;
            return (
              <g key={hour}>
                {/* baseline slot tint so empty hours still read as a column */}
                <rect
                  x={x} y={padTop} width={barW} height={plotH}
                  fill="var(--line)" opacity={0.28} rx={2}
                />
                {them > 0 && (
                  <rect
                    x={x} y={yThem} width={barW} height={Math.max(0, themH)}
                    fill="var(--tension)" rx={2}
                  >
                    <title>{hourLabel(hour)} — {her} {nf(them)}</title>
                  </rect>
                )}
                {me > 0 && (
                  <rect
                    x={x} y={yMe} width={barW} height={Math.max(0, meH)}
                    fill="var(--warmth)" rx={2}
                  >
                    <title>{hourLabel(hour)} — you {nf(me)}</title>
                  </rect>
                )}
                {showLabel && (
                  <text
                    x={x + barW / 2} y={H - 6}
                    textAnchor="middle"
                    fontSize={11}
                    fill="var(--ink-faint)"
                  >
                    {hourLabel(hour)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}

// ── word maps ────────────────────────────────────────────────────────────────

interface WordMapsSectionProps {
  topWordsMe: { w: string; n: number }[];
  topWordsThem: { w: string; n: number }[];
  her: string;
}

function WordMapsSection({ topWordsMe, topWordsThem, her }: WordMapsSectionProps) {
  const me = topWordsMe.slice(0, 18);
  const them = topWordsThem.slice(0, 18);
  if (me.length === 0 && them.length === 0) return null;

  return (
    <section className="ov-section" aria-label="Word maps">
      <div className="ov-head">
        <h2 className="ov-title">The words you reach for</h2>
        <p className="ov-sub">Most-used words, sized by how often. Yours in amber, {her}’s in slate.</p>
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: 12,
      }}>
        <WordCloud title="You" words={me} tone="warmth" />
        <WordCloud title={her} words={them} tone="tension" />
      </div>
    </section>
  );
}

interface WordCloudProps {
  title: string;
  words: { w: string; n: number }[];
  tone: 'warmth' | 'tension';
}

function WordCloud({ title, words, tone }: WordCloudProps) {
  const color = tone === 'warmth' ? 'var(--warmth)' : 'var(--tension)';
  const max = words.reduce((m, x) => Math.max(m, x.n), 0);
  const min = words.reduce((m, x) => Math.min(m, x.n), Number.POSITIVE_INFINITY);
  const span = max > min ? max - min : 1;

  return (
    <div style={{
      border: '1px solid var(--line)',
      borderRadius: 'var(--radius)',
      background: 'var(--surface)',
      padding: '14px 16px',
    }}>
      <div style={{
        fontSize: 12,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: 'var(--ink-faint)',
        marginBottom: 10,
      }}>
        {title}
      </div>
      {words.length === 0 ? (
        <p style={{ color: 'var(--ink-faint)', margin: 0 }}>No words to show yet.</p>
      ) : (
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'baseline',
          gap: '4px 12px',
          lineHeight: 1.25,
        }}>
          {words.map(({ w, n }) => {
            const t = max > min ? (n - min) / span : 0.5; // 0..1
            const size = 13 + Math.round(t * 17); // 13px..30px
            const weight = 400 + Math.round(t * 300); // 400..700
            const opacity = 0.55 + t * 0.45; // faint..solid
            return (
              <span
                key={w}
                title={`${w} · ${nf(n)}`}
                className="tnum"
                style={{
                  fontSize: size,
                  fontWeight: weight,
                  color,
                  opacity,
                  whiteSpace: 'nowrap',
                }}
              >
                {w}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── emoji row ────────────────────────────────────────────────────────────────

interface EmojiSectionProps {
  topEmoji: { e: string; n: number }[];
}

function EmojiSection({ topEmoji }: EmojiSectionProps) {
  const emoji = topEmoji.slice(0, 12);
  if (emoji.length === 0) return null;

  return (
    <section className="ov-section" aria-label="Most-used emoji">
      <div className="ov-head">
        <h2 className="ov-title">Most-used emoji</h2>
        <p className="ov-sub">The small glyphs that carried the tone.</p>
      </div>
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 10,
      }}>
        {emoji.map(({ e, n }) => (
          <div
            key={e}
            title={`${e} · ${nf(n)}`}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 4,
              minWidth: 56,
              padding: '10px 8px',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius)',
              background: 'var(--surface)',
            }}
          >
            <span style={{ fontSize: 26, lineHeight: 1 }}>{e}</span>
            <span className="tnum" style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{nf(n)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── the more-grid ────────────────────────────────────────────────────────────

interface MoreGridProps {
  ambient: AmbientStats;
  her: string;
}

function MoreGrid({ ambient, her }: MoreGridProps) {
  const { extras } = ambient;
  const goodnight = extras.goodnight;
  const goodmorning = extras.goodmorning;
  const lastOfDay = extras.lastOfDay;
  const doubleText = extras.doubleTextRate;
  const busiestMonths = extras.busiestMonths.slice(0, 3);
  const longest = extras.longestMessages[0] ?? null;

  const endsTotal = lastOfDay.me + lastOfDay.them;
  const endsYou = endsTotal > 0 ? Math.round((lastOfDay.me / endsTotal) * 100) : null;

  return (
    <section className="ov-section" aria-label="More of the shape">
      <div className="ov-head">
        <h2 className="ov-title">A few more edges</h2>
        <p className="ov-sub">Smaller shapes worth noticing.</p>
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 12,
      }}>
        <MoreCard label="Goodnights & good mornings">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <MoreLine
              term="goodnight"
              you={goodnight.me}
              her={goodnight.them}
              herName={her}
            />
            <MoreLine
              term="good morning"
              you={goodmorning.me}
              her={goodmorning.them}
              herName={her}
            />
          </div>
        </MoreCard>

        <MoreCard label="Who ends the day">
          {endsYou == null ? (
            <p style={{ margin: 0, color: 'var(--ink-faint)' }}>Too quiet to say.</p>
          ) : (
            <>
              <p style={{ margin: 0, fontSize: 22, fontWeight: 600 }} className="tnum">
                <span style={{ color: 'var(--warmth)' }}>You {endsYou}%</span>
                {' · '}
                <span style={{ color: 'var(--tension)' }}>{her} {100 - endsYou}%</span>
              </p>
              <p style={{ margin: '6px 0 0', color: 'var(--ink-soft)', fontSize: 13 }}>
                who sends the last message of the day
              </p>
            </>
          )}
        </MoreCard>

        <MoreCard label="Double-texting">
          <p style={{ margin: 0, fontSize: 15, color: 'var(--ink-soft)' }} className="tnum">
            <span style={{ color: 'var(--warmth)' }}>You {Math.round(doubleText.me * 100)}%</span>
            {' · '}
            <span style={{ color: 'var(--tension)' }}>{her} {Math.round(doubleText.them * 100)}%</span>
          </p>
          <p style={{ margin: '6px 0 0', color: 'var(--ink-faint)', fontSize: 13 }}>
            share of messages sent back-to-back before a reply
          </p>
        </MoreCard>

        <MoreCard label="Busiest months">
          {busiestMonths.length === 0 ? (
            <p style={{ margin: 0, color: 'var(--ink-faint)' }}>Nothing to rank yet.</p>
          ) : (
            <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {busiestMonths.map((m) => (
                <li key={m.ym} style={{ color: 'var(--ink-soft)', fontSize: 14 }}>
                  {fmtMonth(m.ym)} — <span className="tnum" style={{ color: 'var(--ink)' }}>{nf(m.count)}</span>
                </li>
              ))}
            </ol>
          )}
        </MoreCard>

        <MoreCard label="Longest message">
          {longest == null ? (
            <p style={{ margin: 0, color: 'var(--ink-faint)' }}>None to show yet.</p>
          ) : (
            <>
              <p style={{
                margin: 0,
                fontSize: 12,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: longest.dir === 'me' ? 'var(--warmth)' : 'var(--tension)',
              }}>
                {longest.dir === 'me' ? 'You' : her} · <span className="tnum">{nf(longest.words)}</span> words
              </p>
              <p style={{
                margin: '8px 0 0',
                color: 'var(--ink-soft)',
                fontSize: 13,
                lineHeight: 1.5,
                display: '-webkit-box',
                WebkitLineClamp: 4,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}>
                {longest.preview}
              </p>
            </>
          )}
        </MoreCard>
      </div>
    </section>
  );
}

interface MoreCardProps {
  label: string;
  children: ReactNode;
}

function MoreCard({ label, children }: MoreCardProps) {
  return (
    <div style={{
      border: '1px solid var(--line)',
      borderRadius: 'var(--radius)',
      background: 'var(--surface)',
      padding: '14px 16px',
    }}>
      <div style={{
        fontSize: 12,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: 'var(--ink-faint)',
        marginBottom: 10,
      }}>
        {label}
      </div>
      {children}
    </div>
  );
}

interface MoreLineProps {
  term: string;
  you: number;
  her: number;
  herName: string;
}

function MoreLine({ term, you, her, herName }: MoreLineProps) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 14 }}>
      <span style={{ color: 'var(--ink-soft)' }}>“{term}”</span>
      <span className="tnum">
        <span style={{ color: 'var(--warmth)' }}>{nf(you)}</span>
        {' · '}
        <span style={{ color: 'var(--tension)' }} title={herName}>{nf(her)}</span>
      </span>
    </div>
  );
}
