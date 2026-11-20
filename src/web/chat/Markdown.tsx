import type { ReactNode } from 'react';

/**
 * A small, safe Markdown renderer for Text Result Blocks: paragraphs, headings, bullet and
 * numbered lists, **bold**, *italic* and `code`. Builds React elements (no raw HTML).
 */
export function Markdown({ text }: { text: string }) {
  const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/);
  return <>{blocks.map((block, i) => renderBlock(block.trim(), i))}</>;
}

function renderBlock(block: string, key: number): ReactNode {
  if (!block) return null;
  const lines = block.split('\n');
  const heading = /^(#{1,4})\s+(.*)$/.exec(block);
  if (heading && lines.length === 1) {
    const level = Math.min(heading[1]!.length + 2, 6);
    const Tag = `h${level}` as 'h3';
    return <Tag key={key}>{inline(heading[2]!)}</Tag>;
  }
  if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
    return (
      <ul key={key}>
        {lines.map((l, i) => (
          <li key={i}>{inline(l.replace(/^\s*[-*]\s+/, ''))}</li>
        ))}
      </ul>
    );
  }
  if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
    return (
      <ol key={key}>
        {lines.map((l, i) => (
          <li key={i}>{inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>
        ))}
      </ol>
    );
  }
  return (
    <p key={key}>
      {lines.map((l, i) => (
        <span key={i}>
          {i > 0 && <br />}
          {inline(l)}
        </span>
      ))}
    </p>
  );
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const token = match[0];
    if (match.index > last) out.push(text.slice(last, match.index));
    const key = out.length;
    if (token.startsWith('`')) out.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (token.startsWith('**')) out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else out.push(<em key={key}>{token.slice(1, -1)}</em>);
    last = match.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
