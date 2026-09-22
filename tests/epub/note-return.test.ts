import { describe, expect, it } from "vitest";
import {
  NOTE_RETURN_PAGE_WINDOW,
  NoteReturn,
  noteReturnAfterPageTurn,
} from "../../src/note-return";

const origin: NoteReturn = {
  spine: 4,
  page: 11,
  ratio: 0.42,
  navigationPages: 0,
};

describe("EPUB footnote return window", () => {
  it("keeps the original location through five page turns", () => {
    let current: NoteReturn | null = origin;

    for (let turn = 1; turn <= NOTE_RETURN_PAGE_WINDOW; turn += 1) {
      current = noteReturnAfterPageTurn(current);
      expect(current).toMatchObject({
        spine: origin.spine,
        page: origin.page,
        ratio: origin.ratio,
        navigationPages: turn,
      });
    }
  });

  it("expires after the sixth page turn", () => {
    let current: NoteReturn | null = origin;
    for (let turn = 0; turn <= NOTE_RETURN_PAGE_WINDOW; turn += 1) {
      current = noteReturnAfterPageTurn(current);
    }
    expect(current).toBeNull();
  });

  it("leaves an absent return action absent", () => {
    expect(noteReturnAfterPageTurn(null)).toBeNull();
  });
});
