import {
  loadMarks,
  markLoad,
  onLoadMark,
  resetLoadTimeline,
} from "./load-timeline";
import type { LoadMark } from "./load-timeline";

beforeEach(() => {
  resetLoadTimeline();
});

describe("markLoad", () => {
  it("records a milestone with the time it happened", () => {
    markLoad("boot", "cold start");

    const [mark] = loadMarks();
    expect(mark.milestone).toBe("boot");
    expect(mark.detail).toBe("cold start");
    expect(Number.isFinite(mark.atMs)).toBe(true);
    expect(mark.atMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps marks in the order they happened", () => {
    markLoad("boot");
    markLoad("watch-started");
    markLoad("first-fix");

    expect(loadMarks().map((mark) => mark.milestone)).toEqual([
      "boot",
      "watch-started",
      "first-fix",
    ]);
  });

  it("ignores a repeat of a milestone already recorded", () => {
    markLoad("search-started", "first search");
    markLoad("search-started", "a second search, overwriting nothing");

    const marks = loadMarks();
    expect(marks).toHaveLength(1);
    expect(marks[0].detail).toBe("first search");
  });
});

describe("onLoadMark", () => {
  it("notifies a listener when a new mark is recorded", () => {
    const listener = vi.fn();
    onLoadMark(listener);

    markLoad("boot");

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ milestone: "boot" }),
    );
  });

  it("does not replay marks recorded before it subscribed", () => {
    markLoad("boot");
    const listener = vi.fn();

    onLoadMark(listener);

    expect(listener).not.toHaveBeenCalled();
  });

  it("stops notifying once unsubscribed", () => {
    const listener = vi.fn();
    const unsubscribe = onLoadMark(listener);
    unsubscribe();

    markLoad("boot");

    expect(listener).not.toHaveBeenCalled();
  });

  it("still notifies a second listener, and still records the mark, when the first listener throws", () => {
    onLoadMark(() => {
      throw new Error("a bug in one reporter");
    });
    const wellBehaved = vi.fn();
    onLoadMark(wellBehaved);

    markLoad("boot");

    expect(wellBehaved).toHaveBeenCalled();
    expect(loadMarks()).toHaveLength(1);
  });
});

describe("loadMarks", () => {
  it("cannot be mutated into the record", () => {
    markLoad("boot");

    const returned = loadMarks() as LoadMark[];
    returned.push({ milestone: "first-row", atMs: 0 });

    expect(loadMarks()).toHaveLength(1);
  });
});
