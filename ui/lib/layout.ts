/** Docked-pane geometry shared by the shell, the panes, and their resize
 *  handles. Kept out of the components so the SSR bundle never imports
 *  the client-only terminal module for a number. */

/** Narrowest terminal column the resize handles will leave free (px). */
export const TERMINAL_MIN_W = 320;

/** Fixed width of the per-tab Forwards pane (px). */
export const FORWARDS_PANE_W = 280;
