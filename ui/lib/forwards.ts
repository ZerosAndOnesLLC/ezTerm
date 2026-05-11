import type { Forward, ForwardKind, ForwardSpec } from './types';

/** Human-readable label for a forward. Uses the user-typed `name` if
 *  set; otherwise auto-labels from kind + bind/dest so the UI doesn't
 *  show a blank row. Accepts either a runtime `ForwardSpec` (no DB id)
 *  or a persistent `Forward` row — both have the fields we need. */
export function forwardLabel(
  f: Pick<ForwardSpec, 'name' | 'kind' | 'bind_addr' | 'bind_port' | 'dest_addr' | 'dest_port'>,
): string {
  if (f.name) return f.name;
  if (f.kind === 'dynamic') return `SOCKS5 @ ${f.bind_addr}:${f.bind_port}`;
  return `${f.bind_addr}:${f.bind_port} → ${f.dest_addr}:${f.dest_port}`;
}

/** Single-letter badge per forward kind, used by the pane row and the
 *  session-dialog list. Centralised so we don't drift between sites. */
export const KIND_LETTER: Record<ForwardKind, string> = {
  local:   'L',
  remote:  'R',
  dynamic: 'D',
};

// Re-export the most common type so callers don't need two imports.
export type { Forward };
