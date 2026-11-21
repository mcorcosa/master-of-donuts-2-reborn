import { Application, Assets } from 'pixi.js';
import { createBrowserPersistence, createWebPlatform, scopedBrowserStorage } from '@playbridge/web';
import { BrowserQuality } from './performance/browserQuality';
import { createRebornFacebookPlatform, type FacebookHostSDK, loadFacebookSDK } from './platform/facebook';
import { createFriendsScores } from './platform/friendsScores';
import { browserScoreStorage, isLegacyFacebookScoreOrigin, PersonalScores } from './platform/personalScores';
import { startGame } from './platform/startup';
import { mountGame } from './view';
import './styles.css';

declare const __FACEBOOK__: boolean;

declare global {
  interface Window {
    FBInstant?: FacebookHostSDK;
  }
}

async function main(): Promise<void> {
  const jokerPlaytest = import.meta.env.DEV && new URLSearchParams(window.location.search).get('playtest') === 'joker';
  const storage = browserScoreStorage(() => window.localStorage, __FACEBOOK__ ? 'facebook' : 'web',
    isLegacyFacebookScoreOrigin(window.location, import.meta.env.VITE_DONUTS_LEGACY_FACEBOOK_ORIGIN));
  const boardName = __FACEBOOK__ ? import.meta.env.VITE_DONUTS_FRIENDS_BOARD?.trim() ?? '' : '';
  const facebook = __FACEBOOK__ ? createRebornFacebookPlatform(
    () => loadFacebookSDK(() => window.FBInstant), boardName, createBrowserPersistence(storage),
  ) : null;
  const platform = facebook?.services ?? createWebPlatform(storage);
  const personalScores = new PersonalScores(jokerPlaytest
    ? createBrowserPersistence(scopedBrowserStorage('', () => window.sessionStorage))
    : platform.persistence);

  await startGame(platform, async () => {
    const canvas = document.querySelector<HTMLCanvasElement>('#game');
    if (!canvas) throw new Error('Missing game canvas.');

    if (__FACEBOOK__) Assets.setPreferences({ preferWorkers: false });
    const quality = new BrowserQuality(window);
    const app = new Application();
    await app.init({
      canvas,
      width: window.innerWidth,
      height: window.innerHeight,
      background: '#15100d',
      antialias: true,
      autoDensity: true,
      autoStart: false,
      resolution: quality.frames.resolution,
    });
    await mountGame(app, {
      jokerPlaytest,
      personalScores,
      getFriendsScores: () => facebook && createFriendsScores(platform, boardName, facebook.submitScore),
      quality,
      onPause: callback => platform.lifecycle.onPause(callback),
    });
  });
}

void main().catch(error => console.error('Master of Donuts 2 Reborn could not start.', error));
