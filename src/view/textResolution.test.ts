import { Container, Text } from 'pixi.js';
import { describe, expect, it, vi } from 'vitest';
import { SceneTextResolution } from './textResolution';

describe('scene text resolution', () => {
  it('updates nested, hidden and delayed text only when the tier changes', () => {
    const root = new Container();
    const hidden = root.addChild(new Container({ visible: false }));
    const caption = hidden.addChild(new Text({ text: 'Level' }));
    const resolution = new SceneTextResolution();
    resolution.trackTree(root);

    expect(resolution.set(2, 1.6)).toBe(true);
    expect(caption.resolution).toBe(4);
    const late = new Text({ text: '−1 move' });
    resolution.track(late);
    expect(late.resolution).toBe(4);

    const captionUpdate = vi.spyOn(caption, 'onViewUpdate');
    const lateUpdate = vi.spyOn(late, 'onViewUpdate');
    expect(resolution.set(2, 1.55)).toBe(false);
    expect(captionUpdate).not.toHaveBeenCalled();
    expect(lateUpdate).not.toHaveBeenCalled();

    late.destroy();
    lateUpdate.mockClear();
    expect(resolution.set(1.5, 1.6)).toBe(true);
    expect(caption.resolution).toBe(3);
    expect(captionUpdate).toHaveBeenCalledOnce();
    expect(lateUpdate).not.toHaveBeenCalled();
    root.destroy({ children: true });
  });

  it('accounts for a fixed local scale without invalidating regular text at the same tier', () => {
    const resolution = new SceneTextResolution();
    const root = new Container();
    const caption = root.addChild(new Text({ text: 'Moves left' }));
    const badge = root.addChild(new Text({ text: 'Free' }));
    resolution.track(badge, 2);
    resolution.trackTree(root);

    expect(resolution.set(1, 1.6)).toBe(true);
    expect(caption.resolution).toBe(2);
    expect(badge.resolution).toBe(4);

    const captionUpdate = vi.spyOn(caption, 'onViewUpdate');
    expect(resolution.set(1, 1.25)).toBe(false);
    expect(badge.resolution).toBe(3);
    expect(captionUpdate).not.toHaveBeenCalled();
    root.destroy({ children: true });
  });
});
