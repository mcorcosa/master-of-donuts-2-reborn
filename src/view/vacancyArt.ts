import { CanvasSource, DOMAdapter, Texture } from 'pixi.js';

const WIDTH = 215;
const HEIGHT = 160;
const ART_BODY_ALPHA = 153;
const BODY_OPACITY = 0.15;
const RIM_OPACITY = 0.37;
const RIM_RADIUS = 3;

function vacancyMask(texture: Texture): Uint8ClampedArray {
  const canvas = DOMAdapter.get().createCanvas(WIDTH, HEIGHT);
  const context = canvas.getContext('2d')!;
  context.drawImage(texture.source.resource as CanvasImageSource, 0, 0, WIDTH, HEIGHT);
  const { data } = context.getImageData(0, 0, WIDTH, HEIGHT);
  const mask = new Uint8ClampedArray(WIDTH * HEIGHT);
  const alphaAt = (x: number, y: number) => x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT
    ? 0 : data[(y * WIDTH + x) * 4 + 3];

  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const pixel = y * WIDTH + x;
      const offset = pixel * 4;
      const alpha = data[offset + 3];
      if (!alpha) continue;
      const interior = Math.min(alpha, alphaAt(x - RIM_RADIUS, y), alphaAt(x + RIM_RADIUS, y),
        alphaAt(x, y - RIM_RADIUS), alphaAt(x, y + RIM_RADIUS));
      const luminance = (data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722) / 255;
      // Keep the ice's highlights and cavities in the white mask.
      const relief = Math.max(0, Math.min(1, (luminance - 0.68) / 0.27));
      const coverage = Math.min(1, alpha / ART_BODY_ALPHA);
      const body = 255 * BODY_OPACITY * coverage * relief * relief * (3 - 2 * relief);
      mask[pixel] = Math.max(body, RIM_OPACITY * (alpha - interior));
    }
  }
  return mask;
}

export function stackVacancyMask(
  mask: Uint8ClampedArray, width: number, height: number, step: number, count: number,
): Uint8ClampedArray {
  const extra = Math.ceil((count - 1) * step);
  const stack = new Uint8ClampedArray(width * (height + extra));
  for (let slot = 0; slot < count; slot++) {
    const offset = extra - slot * step;
    const top = Math.floor(offset);
    const fraction = offset - top;
    for (let y = 0; y <= height && top + y < height + extra; y++) {
      const target = (top + y) * width;
      for (let x = 0; x < width; x++) {
        const current = y < height ? mask[y * width + x] : 0;
        const previous = y > 0 ? mask[(y - 1) * width + x] : 0;
        const alpha = current * (1 - fraction) + previous * fraction;
        stack[target + x] = Math.max(stack[target + x], alpha);
      }
    }
  }
  return stack;
}

export class VacancyArt {
  private readonly mask: Uint8ClampedArray;
  private readonly textures = new Map<number, Texture>();
  private step = 0;

  constructor(texture: Texture) {
    this.mask = vacancyMask(texture);
  }

  setStride(fractionOfDonutHeight: number): void {
    const step = fractionOfDonutHeight * HEIGHT;
    if (Math.abs(step - this.step) < 1e-6) return;
    this.destroy();
    this.step = step;
  }

  texture(count: number): Texture {
    const cached = this.textures.get(count);
    if (cached) return cached;
    const alpha = stackVacancyMask(this.mask, WIDTH, HEIGHT, this.step, count);
    const canvas = DOMAdapter.get().createCanvas(WIDTH, alpha.length / WIDTH);
    const context = canvas.getContext('2d')!;
    const image = context.createImageData(canvas.width, canvas.height);
    image.data.fill(255);
    for (let i = 0; i < alpha.length; i++) image.data[i * 4 + 3] = alpha[i];
    context.putImageData(image, 0, 0);
    const texture = new Texture({ source: new CanvasSource({ resource: canvas, autoGenerateMipmaps: true }) });
    this.textures.set(count, texture);
    return texture;
  }

  destroy(): void {
    for (const texture of this.textures.values()) texture.destroy(true);
    this.textures.clear();
  }
}
