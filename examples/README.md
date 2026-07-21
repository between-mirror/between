# The demo — meet Alex & Jordan

This folder lets you try Between Mirror on a **fictional couple** before you point it at your own messages.
Everything here is invented. There is no real person, no real archive, and nothing in it left anyone's
phone. It exists so you can see exactly what the tool does — and doesn't — before trusting it with your
own eight years.

**Alex and Jordan** are a made-up couple over about two years (2022–2024): a warm start, the ordinary
friction of moving in together — chores, money, time, whose turn it is to walk the dog — and the
repair that follows most fights. It is a *normal, hard, loving* relationship, not an abusive one. The
power-balance reading lands where it should: **two readings, held at once** — because that is the
honest shape of most conflict. There is no crisis content of any kind.

## What's here

- **`demo-archive.xml`** — the input. This is what an Android *SMS Backup & Restore* export looks like:
  the format you'd produce from your own phone (see the main README's "Get your messages out of your
  phone"). Human-readable; open it if you're curious what Between actually ingests.
- **`demo.db`** — the built demo, *not committed* (it's generated on demand). It holds the same
  fictional thread already read: the river, episodes, eras, findings, a calibration, and one short
  reading, so every view is populated at $0 with no model and no network.

## Run it

From the repo root:

```
npm run demo:serve
```

That builds `examples/demo.db` from the generator and starts the app pointed at it — **your own
`between.db` is never touched** (it uses the `BETWEEN_DB` override). Open <http://localhost:5273>.

Or just rebuild the demo data without serving:

```
npm run demo
```

## How it's made

`server/src/cli/gen-demo.ts` authors the narrative (fully deterministic — a seeded generator, fixed
dates, no randomness that could drift) and writes both files. It contains no real data and never reads
your archive. Read it if you want to confirm exactly what the demo is.
