'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * A small button that copies `text` to the clipboard and says "Copied" for a moment.
 * `label` names what is copied for screen readers ("Copy query"); `caption` is the visible idle text.
 */
export function CopyButton({
  text,
  label = 'Copy',
  caption = 'Copy',
  className = '',
}: {
  text: string;
  label?: string;
  caption?: string;
  className?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    const ok = await writeClipboard(text);
    setState(ok ? 'copied' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1500);
  }

  return (
    <button
      type="button"
      className={`btn btn--ghost btn--sm no-print ${className}`}
      onClick={() => void copy()}
      title={label}
    >
      <CopyIcon done={state === 'copied'} />
      <span aria-live="polite">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : caption}</span>
      {state === 'idle' && label !== caption && <span className="sr-only">{label.replace(/^Copy\s*/, '')}</span>}
    </button>
  );
}

/** The Clipboard API needs a secure context; fall back to a hidden textarea elsewhere. */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea fallback
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

function CopyIcon({ done }: { done: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {done ? (
        <path d="M4 12.5l5 5L20 6.5" />
      ) : (
        <>
          <rect x="9" y="9" width="12" height="12" rx="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </>
      )}
    </svg>
  );
}
