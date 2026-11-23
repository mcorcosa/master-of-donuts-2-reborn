import { describe, expect, it } from 'vitest';
import { FirstMatchHand } from './firstMatchHand';

const source = { x: 72, y: 280 };
const destination = { x: 200, y: 280 };
const route = { from: 0, to: 1 };

describe('first-match hand', () => {
  it('holds, swipes between the top donuts, rests and loops', () => {
    const hand = new FirstMatchHand();
    expect(hand.root.eventMode).toBe('none');
    expect(hand.show(route, source, destination, 0, 'animate')).toBe(true);
    expect(hand.root.position).toMatchObject(source);
    hand.show(route, source, destination, 300, 'animate');
    expect(hand.root.position).toMatchObject(source);
    hand.show(route, source, destination, 860, 'animate');
    expect(hand.root.position).toMatchObject({ x: 136, y: 272 });
    hand.show(route, source, destination, 1350, 'animate');
    expect(hand.root.position).toMatchObject(destination);
    hand.show(route, source, destination, 1600, 'animate');
    expect(hand.root.position).toMatchObject(destination);
    hand.show(route, source, destination, 1900, 'animate');
    expect(hand.root.position).toMatchObject(source);
  });

  it('pauses the phase, replants the fingertip on a new source, and stays put in reduced motion', () => {
    const hand = new FirstMatchHand();
    hand.show(route, source, destination, 0, 'animate');
    hand.show(route, source, destination, 860, 'animate');
    hand.pause();
    hand.show(route, source, destination, 5000, 'animate');
    expect(hand.root.x).toBe(136);
    const reverse = { from: 1, to: 0 };
    hand.show(reverse, destination, source, 5500, 'animate');
    expect(hand.root.position).toMatchObject(destination);
    expect(hand.root.scale.x).toBe(-1);
    hand.show(reverse, destination, source, 6200, 'animate');
    expect(hand.root.x).toBeLessThan(destination.x);
    expect(hand.show(reverse, destination, source, 6500, 'reduced')).toBe(false);
    hand.show(reverse, destination, source, 9000, 'reduced');
    expect(hand.root.position).toMatchObject(destination);
    hand.hide();
    expect(hand.root.visible).toBe(false);
  });
});
