/** Pure helpers for the first-run tour (Apple-style, 3 slides). */
export const TOUR_SLIDE_COUNT = 3;

export function isFirstTourSlide(index: number): boolean {
  return index <= 0;
}

export function isLastTourSlide(index: number): boolean {
  return index >= TOUR_SLIDE_COUNT - 1;
}

export function nextTourSlide(index: number): number {
  if (index >= TOUR_SLIDE_COUNT - 1) return TOUR_SLIDE_COUNT - 1;
  if (index < 0) return 0;
  return index + 1;
}

export function prevTourSlide(index: number): number {
  if (index <= 0) return 0;
  if (index >= TOUR_SLIDE_COUNT) return TOUR_SLIDE_COUNT - 1;
  return index - 1;
}
