import { CanvasSource, DOMAdapter, Rectangle, Texture } from 'pixi.js';

export function stackVacancyPixels(
  pixels: Uint8ClampedArray, width: number, height: number, step: number, count: number,
) {
  const span = (count - 1) * step;
  const extra = Math.ceil(span);
  const rowBytes = width * 4;
  const stack = new Uint8ClampedArray(rowBytes * (height + extra));
  // Transparent rows on either side make fractional seat sampling safe at the edges.
  const padded = new Uint8ClampedArray(rowBytes * (height + 2));
  padded.set(pixels, rowBytes);
  for (let slot = 0; slot < count; slot++) {
    const offset = extra - slot * step;
    const top = Math.floor(offset);
    const fraction = offset - top;
    for (let y = 0; y <= height && top + y < height + extra; y++) {
      const prevRow = y * rowBytes;
      const nextRow = prevRow + rowBytes;
      const stackRow = (top + y) * rowBytes;
      for (let x = 0; x < rowBytes; x += 4) {
        const previous = prevRow + x;
        const next = nextRow + x;
        const before = padded[previous + 3] * fraction;
        const after = padded[next + 3] * (1 - fraction);
        const alpha = before + after;
        const target = stackRow + x;
        // Use a single sample at overlaps. The higher seat wins ties.
        const coverage = Math.round(alpha);
        if (!coverage || coverage < stack[target + 3]) continue;
        for (let channel = 0; channel < 3; channel++) {
          stack[target + channel] = (padded[previous + channel] * before + padded[next + channel] * after) / alpha;
        }
        stack[target + 3] = coverage;
      }
    }
  }
  return { pixels: stack, height: height + extra, top: extra - span };
}

export class VacancyArt {
  private readonly pixels: Uint8ClampedArray;
  private readonly width: number;
  private readonly height: number;
  private readonly textures = new Map<number, Map<number, Texture>>();

  constructor(texture: Texture) {
    this.width = texture.width;
    this.height = texture.height;
    const canvas = DOMAdapter.get().createCanvas(this.width, this.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(texture.source.resource as CanvasImageSource, 0, 0, this.width, this.height);
    this.pixels = context.getImageData(0, 0, this.width, this.height).data;
  }

  private stride(fractionOfDonutHeight: number): number {
    // Equivalent layouts can differ in the last few floating-point bits after a resize.
    return Math.round(fractionOfDonutHeight * this.height * 1e6) / 1e6;
  }

  keepStrides(...fractionsOfDonutHeight: number[]): void {
    const steps = fractionsOfDonutHeight.map(fraction => this.stride(fraction));
    for (const [step, textures] of this.textures) {
      if (steps.includes(step)) continue;
      for (const texture of textures.values()) texture.destroy(true);
      this.textures.delete(step);
    }
  }

  texture(count: number, fractionOfDonutHeight: number): Texture {
    const step = this.stride(fractionOfDonutHeight);
    let textures = this.textures.get(step);
    if (!textures) {
      textures = new Map();
      this.textures.set(step, textures);
    }
    const cached = textures.get(count);
    if (cached) return cached;
    const stack = stackVacancyPixels(this.pixels, this.width, this.height, step, count);
    const canvas = DOMAdapter.get().createCanvas(this.width, stack.height);
    const context = canvas.getContext('2d')!;
    const image = context.createImageData(canvas.width, canvas.height);
    image.data.set(stack.pixels);
    context.putImageData(image, 0, 0);
    const texture = new Texture({
      source: new CanvasSource({ resource: canvas, autoGenerateMipmaps: true }),
      // Crop the fractional padding so the lowest seat keeps the original art scale.
      frame: new Rectangle(0, stack.top, this.width, stack.height - stack.top),
    });
    textures.set(count, texture);
    return texture;
  }

  destroy(): void {
    this.keepStrides();
  }
}
