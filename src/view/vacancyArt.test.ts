import { expect, it } from 'vitest';
import { stackVacancyPixels } from './vacancyArt';

function glass(...alpha: number[]): Uint8ClampedArray {
  return Uint8ClampedArray.from(alpha.flatMap(value => value ? [255, 248, 236, value] : [0, 0, 0, 0]));
}

it('keeps one glass sample at each intersection, even for ten vacancies', () => {
  const sample = glass(66, 48, 24);
  expect(stackVacancyPixels(sample, 1, 3, 1, 3).pixels).toEqual(glass(66, 66, 66, 48, 24));
  expect(stackVacancyPixels(sample, 1, 3, 0, 10).pixels).toEqual(sample);
});

it('samples fractional seat spacing and exposes only the exact stack height', () => {
  const sample = glass(64, 32, 0);
  const stack = stackVacancyPixels(sample, 1, 3, 0.5, 2);
  expect(stack.pixels).toEqual(glass(32, 64, 32, 0));
  expect(stack.height - stack.top).toBe(3.5);
});

it('preserves the chosen layer color and samples transparent edges without a dark fringe', () => {
  const sample = Uint8ClampedArray.of(255, 245, 223, 100, 230, 215, 196, 100);
  expect(stackVacancyPixels(sample, 1, 2, 1, 2).pixels)
    .toEqual(Uint8ClampedArray.of(255, 245, 223, 100, 230, 215, 196, 100, 230, 215, 196, 100));
  expect(stackVacancyPixels(sample, 1, 2, 0.5, 2).pixels.slice(0, 4))
    .toEqual(Uint8ClampedArray.of(255, 245, 223, 50));
});
