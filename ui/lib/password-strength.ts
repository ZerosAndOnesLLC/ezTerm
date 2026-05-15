/** Length-weight + character-class diversity heuristic that nudges
 *  users away from "password" without pulling in zxcvbn. Returns 0..4.
 *  Used by every place we ask the user to pick a new master password
 *  (initial setup, change, reset). */
export function scorePassword(pw: string): number {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 8)  score++;
  if (pw.length >= 12) score++;
  if (pw.length >= 16) score++;
  const classes =
    Number(/[a-z]/.test(pw)) +
    Number(/[A-Z]/.test(pw)) +
    Number(/[0-9]/.test(pw)) +
    Number(/[^a-zA-Z0-9]/.test(pw));
  if (classes >= 3) score++;
  return Math.min(score, 4);
}

export const STRENGTH_COPY = ['Too short', 'Weak', 'Fair', 'Strong', 'Very strong'] as const;
export const STRENGTH_BAR  = ['bg-danger', 'bg-danger', 'bg-warning', 'bg-success', 'bg-success'] as const;
