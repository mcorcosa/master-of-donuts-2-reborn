import { Application, Assets } from 'pixi.js';
import { createBrowserPersistence, createWebPlatform, scopedBrowserStorage } from '@playbridge/web';
import { BrowserQuality } from './performance/browserQuality';
import { BOOSTER_REWARDED_PLACEMENT, createRebornFacebookPlatform, type FacebookHostSDK, loadFacebookSDK } from './platform/facebook';
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
  const playtest = import.meta.env.DEV ? new URLSearchParams(window.location.search).get('playtest') : null;
  const jokerPlaytest = playtest === 'joker';
  const removeAdsDemo = import.meta.env.DEV && !__FACEBOOK__ && playtest === 'remove-ads';
  const storage = browserScoreStorage(() => window.localStorage, __FACEBOOK__ ? 'facebook' : 'web',
    isLegacyFacebookScoreOrigin(window.location, import.meta.env.VITE_DONUTS_LEGACY_FACEBOOK_ORIGIN));
  const boardName = __FACEBOOK__ ? import.meta.env.VITE_DONUTS_FRIENDS_BOARD?.trim() ?? '' : '';
  const facebook = __FACEBOOK__ ? createRebornFacebookPlatform(
    () => loadFacebookSDK(() => window.FBInstant), boardName, createBrowserPersistence(storage),
    import.meta.env.VITE_DONUTS_BOOSTER_REWARDED_PLACEMENT,
    import.meta.env.VITE_DONUTS_REMOVE_ADS_SKU,
  ) : null;
  const platform = facebook?.services ?? createWebPlatform(storage);
  const personalScores = new PersonalScores(jokerPlaytest
    ? createBrowserPersistence(scopedBrowserStorage('', () => window.sessionStorage))
    : platform.persistence);

  let resultsVisible = false;
  let setRemoveAdsVisible: ((visible: boolean) => void) | undefined;
  const app = new Application();
  await startGame(platform, async () => {
    const canvas = document.querySelector<HTMLCanvasElement>('#game');
    if (!canvas) throw new Error('Missing game canvas.');

    if (__FACEBOOK__) Assets.setPreferences({ preferWorkers: false });
    const quality = new BrowserQuality(window);
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
      watchBoosterAd: platform.capabilities().rewardedAds === 'available' ? isCurrent => platform.ads.request({
        kind: 'rewarded', placement: BOOSTER_REWARDED_PLACEMENT, isCurrent,
      }) : undefined,
      quality,
      onPause: callback => platform.lifecycle.onPause(callback),
      onResultsVisibilityChange(visible) {
        resultsVisible = visible;
        setRemoveAdsVisible?.(!visible);
      },
    });
  });

  const purchase = facebook?.removeAds ?? (removeAdsDemo ? (await import('./platform/removeAdsDemo')).createRemoveAdsDemo() : null);
  if (purchase) {
    const { mountRemoveAds } = await import('./view/removeAds');
    const demoCopy = removeAdsDemo ? { title: 'Remove Ads Demo', description: 'Practice checkout. No payment is collected.' } : undefined;
    const view = mountRemoveAds(document, purchase, callback => platform.lifecycle.onPause(callback), demoCopy);
    setRemoveAdsVisible = view.setVisible;
    setRemoveAdsVisible(!resultsVisible);
    app.stage.once('destroyed', view.destroy);
  }
}

void main().catch(error => console.error('Master of Donuts 2 Reborn could not start.', error));
