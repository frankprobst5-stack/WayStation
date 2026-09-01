export interface Token {
  key: string;
  value: string;
}

/** Parses OpenHamClock-style bracket tokens: "[Beds 30/100][Power OK][Water -50]". */
export function parseTokens(raw: string): Token[] {
  const matches = [...raw.matchAll(/\[([^\]]+)\]/g)];
  return matches.map((m) => {
    const content = m[1].trim();
    const spaceIdx = content.indexOf(" ");
    if (spaceIdx === -1) return { key: content, value: "" };
    return { key: content.slice(0, spaceIdx), value: content.slice(spaceIdx + 1) };
  });
}
