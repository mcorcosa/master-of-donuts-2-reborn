import { describe, expect, it } from 'vitest';
import { icingVialReading } from './icingVial';

describe('icing vial reading', () => {
  it.each([
    [undefined, 28, 'full'], [0, 28, 'full'], [20, 8, 'full'],
    [21, 7, 'warning'], [24, 4, 'warning'], [25, 3, 'critical'], [28, 0, 'critical'],
    [-2, 28, 'full'], [29, 0, 'critical'],
  ] as const)('maps %s spent dough to %s moves and %s icing', (doughMeter, remaining, tone) => {
    expect(icingVialReading({ doughMeter })).toEqual({ remaining, fraction: remaining / 28, tone });
  });

  it('keeps the thresholds proportional if the budget changes', () => {
    expect(icingVialReading({ doughMeter: 42 }, 56).tone).toBe('warning');
    expect(icingVialReading({ doughMeter: 50 }, 56).tone).toBe('critical');
  });
});
