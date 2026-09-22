import { describe, expect, it } from "vite-plus/test";

import { isFirstTourSlide, isLastTourSlide, nextTourSlide, prevTourSlide } from "./tour.logic";

describe("tour slide helpers", () => {
  it("stays on the first slide when going back", () => {
    expect(prevTourSlide(0)).toBe(0);
    expect(isFirstTourSlide(0)).toBe(true);
  });

  it("advances one slide at a time", () => {
    expect(nextTourSlide(0)).toBe(1);
    expect(nextTourSlide(1)).toBe(2);
  });

  it("stays on the last slide when going forward", () => {
    expect(nextTourSlide(2)).toBe(2);
    expect(nextTourSlide(99)).toBe(2);
    expect(isLastTourSlide(2)).toBe(true);
  });

  it("clamps out-of-range indexes", () => {
    expect(nextTourSlide(-1)).toBe(0);
    expect(prevTourSlide(99)).toBe(2);
  });
});
