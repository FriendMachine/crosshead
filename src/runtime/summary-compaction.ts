const balancedTruncate = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) {
    return value;
  }
  const marker = " ... ";
  const headLength = Math.max(0, Math.ceil((maxLength - marker.length) * 0.55));
  const tailLength = Math.max(0, maxLength - marker.length - headLength);
  return `${value.slice(0, headLength).trimEnd()}${marker}${value.slice(-tailLength).trimStart()}`;
};

const compactMarkdownLinks = (value: string): string =>
  value.replace(/\[([^\]]+)\]\((?:<[^>]+>|[^)]+)\)/g, "$1");

const IMPORTANT_SUMMARY_PATTERNS = [
  /\bmust\b/i,
  /\btake precedence\b/i,
  /\bshould\b/i,
  /\bavoid\b/i,
  /\bfailed approach\b/i,
  /\bconstraint\b/i,
  /\bpreserve\b/i,
  /\bpublic API\b/i,
  /\broot cause\b/i,
  /\bnext\b/i,
  /\bfix\b/i,
  /\bdo not\b/i,
  /\bcannot\b/i,
  /\bbecause\b/i,
  /\bhidden\b/i,
  /\berror\b/i,
  /\bwarning\b/i,
  /`[^`]+`/,
];

const scoreSummarySentence = (sentence: string): number =>
  IMPORTANT_SUMMARY_PATTERNS.reduce((score, pattern) => score + (pattern.test(sentence) ? 1 : 0), 0);

export const compactContinuitySummary = (value: string, maxLength: number = 640): string => {
  const normalized = compactMarkdownLinks(value).replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  const sentences = normalized.split(/(?<=[.!?])\s+/).map((entry) => entry.trim()).filter(Boolean);
  if (sentences.length <= 1) {
    return balancedTruncate(normalized, maxLength);
  }

  const selected = new Set<number>();
  const ranked = sentences
    .map((sentence, index) => ({ index, score: scoreSummarySentence(sentence) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);

  const renderSelected = (): string => [...selected]
    .sort((left, right) => left - right)
    .map((index) => sentences[index])
    .join(" ");

  for (const entry of ranked) {
    selected.add(entry.index);
    if (renderSelected().length > maxLength) {
      selected.delete(entry.index);
    }
  }

  for (const index of [0, sentences.length - 1]) {
    if (selected.has(index)) {
      continue;
    }
    selected.add(index);
    if (renderSelected().length > maxLength) {
      selected.delete(index);
    }
  }

  return balancedTruncate(renderSelected() || sentences[0] || normalized, maxLength);
};
