import { expect, it } from 'vitest';
import { stackVacancyMask } from './vacancyArt';

it('keeps the brighter rim sample at an intersection', () => {
  const mask = Uint8ClampedArray.of(66, 48, 24);
  expect(stackVacancyMask(mask, 1, 3, 1, 3)).toEqual(Uint8ClampedArray.of(66, 66, 66, 48, 24));
  expect(stackVacancyMask(mask, 1, 3, 0, 10)).toEqual(mask);
});

it('samples fractional offsets before taking the maximum', () => {
  const mask = Uint8ClampedArray.of(64, 32, 0);
  expect(stackVacancyMask(mask, 1, 3, 0.5, 2)).toEqual(Uint8ClampedArray.of(32, 64, 32, 0));
});
