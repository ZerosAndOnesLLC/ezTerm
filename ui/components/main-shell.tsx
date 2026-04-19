'use client';
export function MainShell({ onLock }: { onLock: () => void }) {
  return (
    <main className="h-full flex items-center justify-center text-muted">
      Vault unlocked. UI wired in later tasks.
      <button onClick={onLock} className="ml-4 px-3 py-1 border border-border rounded">Lock</button>
    </main>
  );
}
