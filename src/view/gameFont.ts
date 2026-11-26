const GAME_FONT = 'DynaPuff';
export const GAME_FONT_FAMILY = [GAME_FONT, 'Trebuchet MS', 'Arial', 'sans-serif'];

export function gameText(value: string): string {
  return value.toUpperCase();
}

const loads = new WeakMap<FontFaceSet, Promise<void>>();

export async function preloadGameFont(fonts?: FontFaceSet): Promise<void> {
  if (!fonts || typeof FontFace === 'undefined') return;
  let ready = loads.get(fonts);
  if (!ready) {
    const font = new FontFace(GAME_FONT, `url("${import.meta.env.BASE_URL}fonts/DynaPuff.ttf")`, { weight: '400 700' });
    ready = font.load().then(face => { fonts.add(face); }).catch(error => {
      loads.delete(fonts);
      throw error;
    });
    loads.set(fonts, ready);
  }
  return ready;
}
