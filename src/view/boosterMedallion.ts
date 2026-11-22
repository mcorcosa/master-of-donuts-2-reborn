import { DOMAdapter, Texture } from 'pixi.js';
import type { BoosterKind } from '../game/boosters';

type Stops = readonly (readonly [number, string])[];
type Trace = (context: CanvasRenderingContext2D) => void;

function shade(gradient: CanvasGradient, stops: Stops): CanvasGradient {
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  return gradient;
}

function disc(
  context: CanvasRenderingContext2D, y: number, radius: number, fill?: string | CanvasGradient, edge?: string, width = 1,
): void {
  context.beginPath();
  context.arc(0, y, radius, 0, Math.PI * 2);
  if (fill) { context.fillStyle = fill; context.fill(); }
  if (edge) { context.strokeStyle = edge; context.lineWidth = width; context.stroke(); }
}

function curve(context: CanvasRenderingContext2D, trace: Trace, stroke: string | CanvasGradient, width: number): void {
  context.beginPath();
  trace(context);
  context.strokeStyle = stroke;
  context.lineWidth = width;
  context.stroke();
}

function gust(context: CanvasRenderingContext2D): void {
  const strokes: { width: number; trace: Trace }[] = [
    { width: 2.15, trace: path => {
      path.moveTo(-8.7, -0.65);
      path.lineTo(5.4, -0.65);
      path.bezierCurveTo(11.05, -0.65, 10.2, -7.95, 5.8, -7.8);
      path.quadraticCurveTo(3.55, -7.65, 3.15, -5.82);
    } },
    { width: 1.9, trace: path => {
      path.moveTo(-6.9, 3);
      path.lineTo(4.65, 3);
      path.bezierCurveTo(8.1, 3, 7.95, 7.65, 4.8, 7.56);
      path.quadraticCurveTo(3.3, 7.45, 2.77, 6.5);
    } },
    { width: 1.5, trace: path => { path.moveTo(-9.3, -4.1); path.lineTo(-2, -4.1); } },
  ];
  context.rotate(-0.18);
  const metal = shade(context.createLinearGradient(3, -8, 0, 8), [[0, '#fff3b8'], [0.4, '#ffd574'], [1, '#ca7b34']]);
  for (const { width, trace } of strokes) curve(context, trace, '#163637', width + 1.1);
  for (const { width, trace } of strokes) curve(context, trace, metal, width);
}

function rainbowDonut(context: CanvasRenderingContext2D, art: Texture): void {
  context.save();
  context.shadowColor = '#11041dce';
  context.shadowBlur = 8;
  context.shadowOffsetY = 5;
  context.drawImage(art.source.resource as CanvasImageSource, -12.2, -9.1, 24.4, 18.2);
  context.restore();
  const x = 6.9, y = -6.3, size = 2.65;
  context.beginPath();
  context.moveTo(x, y - size);
  context.quadraticCurveTo(x + size * 0.13, y - size * 0.15, x + size * 0.78, y);
  context.quadraticCurveTo(x + size * 0.13, y + size * 0.15, x, y + size);
  context.quadraticCurveTo(x - size * 0.13, y + size * 0.15, x - size * 0.78, y);
  context.quadraticCurveTo(x - size * 0.13, y - size * 0.15, x, y - size);
  context.fillStyle = '#fffce5';
  context.fill();
}

export const MEDALLION_ART_SIZE = 40;

export function createBoosterMedallion(kind: BoosterKind, jokerArt: Texture): Texture {
  const resolution = 4;
  const size = MEDALLION_ART_SIZE * resolution;
  const canvas = DOMAdapter.get().createCanvas(size, size) as HTMLCanvasElement;
  const context = canvas.getContext('2d')!;
  const joker = kind === 'joker';
  context.setTransform(resolution, 0, 0, resolution, size / 2, size / 2);
  context.lineJoin = context.lineCap = 'round';

  context.save();
  context.shadowColor = '#5627268c';
  context.shadowBlur = 8.4;
  context.shadowOffsetY = 5;
  disc(context, 0, 15.8, '#66372f');
  context.restore();

  const metal = shade(context.createLinearGradient(-8, -15, 10, 16), [
    [0, '#ffffd7'], [0.21, '#ffd383'], [0.4, '#ac5c29'], [0.57, '#ffe29b'], [0.75, '#ca8744'], [1, '#71351f'],
  ]);
  disc(context, 0, 16.2, '#6f3526');
  disc(context, -0.45, 15.45, metal);
  disc(context, -0.45, 12.65, undefined, '#713a29', 0.94);
  curve(context, path => path.arc(0, -0.45, 14.65, 3.5, 5.09), '#ffffda', 0.84);
  curve(context, path => path.arc(0, -0.45, 14.45, 0.16, 1.65), '#ffe6a5aa', 0.48);
  const face = shade(context.createRadialGradient(-4, -6, 0, -4, -6, 20), joker
    ? [[0, '#aa6099'], [0.49, '#653766'], [1, '#2e1843']]
    : [[0, '#408879'], [0.46, '#246657'], [1, '#102f35']]);
  disc(context, -0.4, 11.95, face, joker ? '#ffbdce71' : '#a5ffcd61', 0.5);
  if (joker) rainbowDonut(context, jokerArt);
  else gust(context);
  return Texture.from(canvas, true);
}
