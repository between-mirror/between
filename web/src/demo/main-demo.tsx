// Between Mirror — the demo's entry point.
//
// Deliberately a SEPARATE entry rather than a flag inside main.tsx. The installed application must
// have no code path that can read frozen answers or disable writes, and the surest way to guarantee
// that is for the shim never to be imported by the real entry at all. `npm run build` and
// `npm run build:demo` produce different bundles from different roots; nothing here ships to a user.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../App';
import { DemoBanner } from './DemoBanner';
import { installDemoFetch, type DemoManifest } from './shim';
import { setAskSuggestions } from '../lib/suggestions';
import '../tokens.css';
import '../global.css';
import './demo.css';

// One directory up, because the captured JSON lives at site/demo-data — tracked, reviewable, and the
// single copy. The built bundle under site/demo is a build artifact and is not committed; duplicating
// the data into it would mean two copies that can disagree, and the wrong one would be the one
// nobody reviews.
//
// Resolved relative to the page rather than absolutely, so the demo works wherever the site is
// served: /between/demo/ here, a different path on a fork, or a plain file server locally.
const DATA_BASE = new URL('../demo-data', document.baseURI).toString().replace(/\/$/, '');

async function boot(): Promise<void> {
  const root = createRoot(document.getElementById('root')!);
  try {
    const grab = async (name: string): Promise<unknown> => {
      const r = await fetch(`${DATA_BASE}/${name}`, { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(`${name} ${r.status}`);
      return r.json();
    };
    const [manifest, posts, questions] = await Promise.all([
      grab('manifest.json') as Promise<DemoManifest>,
      grab('posts.json') as Promise<DemoManifest>,
      grab('questions.json') as Promise<string[]>,
    ]);

    // Installed BEFORE the app renders, so no component can race it and reach a real API.
    installDemoFetch({ dataBase: DATA_BASE, manifest, posts });

    // The Ask surface offers these instead of a text box. Registered here, from the captured data,
    // so the questions the app offers and the answers it holds can never drift apart.
    setAskSuggestions(questions);

    root.render(
      <StrictMode>
        <DemoBanner />
        <App />
      </StrictMode>,
    );
  } catch {
    // If the captured data is missing the demo is broken, and saying so plainly beats an app shell
    // that renders empty and looks like the product itself is empty.
    root.render(
      <StrictMode>
        <DemoBanner />
        <main className="demo-broken">
          <h1>The demo could not load its data.</h1>
          <p>
            This page reads a frozen copy of a fictional archive, and that copy did not arrive. The
            application itself is fine — this is a problem with the demo page.
          </p>
        </main>
      </StrictMode>,
    );
  }
}

void boot();
