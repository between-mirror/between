// Between — the light/dark toggle. Stamps data-theme on <html> via useTheme.
import { useTheme } from '../lib/hooks';
import { MoonIcon, SunIcon } from './icons';

export function ThemeToggle() {
  const { resolved, toggle } = useTheme();
  const next = resolved === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="icon-btn"
      onClick={toggle}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
    >
      {resolved === 'dark' ? <MoonIcon /> : <SunIcon />}
    </button>
  );
}
