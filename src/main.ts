import { Application, Assets } from 'pixi.js';
import { startFacebookGame } from './platform/facebook';
import { mountGame } from './view';
import './styles.css';

declare const __FACEBOOK__: boolean;

async function prepareGame(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#game');
  if (!canvas) throw new Error('Missing game canvas.');

  if (__FACEBOOK__) Assets.setPreferences({ preferWorkers: false });
  const app = new Application();
  await app.init({
    canvas,
    resizeTo: window,
    background: '#15100d',
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
  });
  await mountGame(app);
  app.render();
}

async function main(): Promise<void> {
  if (__FACEBOOK__) await startFacebookGame(prepareGame);
  else await prepareGame();
}

void main().catch(error => console.error('Master of Donuts 2 Reborn could not start.', error));
