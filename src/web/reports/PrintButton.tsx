'use client';

/** Opens the browser's print dialog (Ctrl+P does the same); hidden on the printed page. */
export function PrintButton() {
  return (
    <button type="button" className="btn btn--ghost no-print" onClick={() => window.print()}>
      Print
    </button>
  );
}
