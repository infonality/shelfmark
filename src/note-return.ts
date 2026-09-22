/** Number of page turns for which a footnote's return action remains useful. */
export const NOTE_RETURN_PAGE_WINDOW = 5;

export type NoteReturn = {
  spine: number;
  page: number;
  ratio: number;
  navigationPages: number;
};

/**
 * Age a pending footnote return after one successful previous/next page turn.
 * The functional shape makes this safe when quick wheel or key events arrive
 * before React has rendered the preceding state update.
 */
export function noteReturnAfterPageTurn(origin: NoteReturn | null): NoteReturn | null {
  if (!origin) return null;
  const navigationPages = origin.navigationPages + 1;
  if (navigationPages > NOTE_RETURN_PAGE_WINDOW) return null;
  return { ...origin, navigationPages };
}
