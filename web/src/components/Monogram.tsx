// Between — a calm monogram avatar. Tint is chosen from tokens (warmth/tension),
// never a hardcoded color, and varies gently per contact for legibility.
import { hashString, monogramInitials } from '../lib/format';

interface MonogramProps {
  name: string;
  size?: number;
}

export function Monogram({ name, size = 42 }: MonogramProps) {
  const initials = monogramInitials(name);
  // parity of the hash picks one of the two sentiment poles as a soft tint
  const tone = hashString(name) % 2 === 0 ? 'warmth' : 'tension';
  return (
    <span
      className="monogram"
      data-tone={tone}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
      aria-hidden
    >
      {initials}
    </span>
  );
}
