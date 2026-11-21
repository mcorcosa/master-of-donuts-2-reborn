import { DOMAdapter, Texture } from 'pixi.js';
import { unit } from './movePlayback';

const RAINBOW_LOOP_MS = 3600;
// Stamp coordinates from the Art Director's 48.42525 × 36.03739 drawing.
const ART_WIDTH = 48.42525;
const ART_HEIGHT = 36.03739;
const STAMP_Y = 1 - 7 / ART_HEIGHT;

interface GlazePixel {
  index: number;
  hue: number;
  low: number;
  chroma: number;
  strength: number;
}

function glazePixels(original: Uint8ClampedArray, width: number, height: number): GlazePixel[] {
  const pixels: GlazePixel[] = [];
  for (let x = 0; x < width; x++) {
    let base = height - 1;
    while (base > 0 && original[(base * width + x) * 4 + 3] < 128) base--;
    for (let y = 0; y <= base; y++) {
      const index = (y * width + x) * 4;
      if (!original[index + 3]) continue;
      // Leave the baked rim and inside of the hole in their original colors.
      const cavity = Math.hypot((x - width * 0.50) / (width * 0.18), (y - height * 0.41) / (height * 0.072));
      const strength = unit((base - y - 5) / 4) * unit((cavity - 0.84) * 5);
      if (strength === 0) continue;
      const [red, green, blue] = original.subarray(index, index + 3);
      const high = Math.max(red, green, blue);
      const low = Math.min(red, green, blue);
      const chroma = high - low;
      if (chroma < 3) continue;
      const hue = high === red ? (green - blue) / chroma : high === green
        ? 2 + (blue - red) / chroma : 4 + (red - green) / chroma;
      pixels.push({ index, hue, low, chroma, strength });
    }
  }
  return pixels;
}

function stamp(context: CanvasRenderingContext2D, width: number, height: number): void {
  context.save();
  context.translate(width / 2, height * STAMP_Y);
  context.scale(width / ART_WIDTH, height / ART_HEIGHT);
  context.lineJoin = context.lineCap = 'round';
  context.beginPath();
  context.moveTo(0, -4);
  context.lineTo(5.3, 0);
  context.lineTo(0, 4);
  context.lineTo(-5.3, 0);
  context.closePath();
  context.fillStyle = '#632b23';
  context.fill();
  context.strokeStyle = '#ffefce';
  context.lineWidth = 1.35;
  context.stroke();
  context.beginPath();
  context.moveTo(-2.2, 0);
  context.lineTo(0, -1.7);
  context.lineTo(2.1, 0);
  context.strokeStyle = '#c88156';
  context.lineWidth = 0.65;
  context.stroke();
  context.restore();
}

export class JokerArt {
  readonly texture: Texture;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly frame: ImageData;
  private readonly original: Uint8ClampedArray;
  private readonly pixels: GlazePixel[];
  private morphTexture?: Texture;
  private turns = -1;

  constructor(source: Texture) {
    const { width, height } = source;
    this.canvas = DOMAdapter.get().createCanvas(width, height) as HTMLCanvasElement;
    this.context = this.canvas.getContext('2d')!;
    this.context.drawImage(source.source.resource as CanvasImageSource, 0, 0, width, height);
    this.frame = this.context.getImageData(0, 0, width, height);
    this.original = this.frame.data.slice();
    this.pixels = glazePixels(this.original, width, height);
    this.texture = Texture.from(this.canvas, true);
    this.update(0, true);
  }

  update(now: number, reduced: boolean): void {
    const turns = reduced ? 0 : (now % RAINBOW_LOOP_MS) / RAINBOW_LOOP_MS;
    if (turns === this.turns) return;
    this.turns = turns;
    const { original, frame, context, canvas } = this;
    for (const { index, hue, low, chroma, strength } of this.pixels) {
      const spin = (hue + 6 + 6 * turns) % 6;
      const mid = chroma * (1 - Math.abs(spin % 2 - 1));
      const band = Math.floor(spin);
      const red = band === 0 || band === 5 ? chroma : band === 1 || band === 4 ? mid : 0;
      const green = band === 1 || band === 2 ? chroma : band === 0 || band === 3 ? mid : 0;
      const blue = band === 3 || band === 4 ? chroma : band === 2 || band === 5 ? mid : 0;
      frame.data[index] = original[index] + (low + red - original[index]) * strength;
      frame.data[index + 1] = original[index + 1] + (low + green - original[index + 1]) * strength;
      frame.data[index + 2] = original[index + 2] + (low + blue - original[index + 2]) * strength;
    }
    context.putImageData(frame, 0, 0);
    stamp(context, canvas.width, canvas.height);
    this.texture.source.update();
  }

  morph(flavor: Texture, progress: number): Texture {
    if (progress === 0) return this.texture;
    const { width, height } = this.canvas;
    this.morphTexture ??= Texture.from(DOMAdapter.get().createCanvas(width, height), true);
    const canvas = this.morphTexture.source.resource as HTMLCanvasElement;
    const context = canvas.getContext('2d')!;
    const x = width / 2;
    const y = height * STAMP_Y;
    const radius = Math.hypot(x, y) * (1 - (1 - progress) ** 2);

    // The reveal replaces the underlying rainbow silhouette, including its transparent edge.
    context.clearRect(0, 0, width, height);
    context.save();
    context.beginPath();
    context.rect(0, 0, width, height);
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.clip('evenodd');
    context.drawImage(this.canvas, 0, 0);
    context.restore();
    context.save();
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.clip();
    context.drawImage(flavor.source.resource as CanvasImageSource, 0, 0, width, height);
    context.restore();
    this.morphTexture.source.update();
    return this.morphTexture;
  }

  destroy(): void {
    this.texture.destroy(true);
    this.morphTexture?.destroy(true);
  }
}
