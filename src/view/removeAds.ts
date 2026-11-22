import type { RemoveAds, RemoveAdsView } from '../platform/removeAds';
import './removeAds.css';

function updateStatus({ state, message }: RemoveAdsView): string {
  switch (state) {
    case 'checking': return 'Checking for a purchase…';
    case 'checkout': return 'Completing checkout…';
    case 'owned': return 'Your purchase is active. Interstitials are off.';
    case 'pending': return 'Waiting for Facebook to confirm your purchase.';
    case 'available': return message ?? '';
    case 'unavailable': return message ?? 'Purchases are currently unavailable.';
  }
}

export function mountRemoveAds(document: Document, purchase: RemoveAds,
  onPause: (callback: () => void) => () => void, copy = {
    title: 'Remove Interstitials',
    description: 'Permanently removes automatic interstitial ads. Optional rewarded ads remain available.',
  }, onModalOpen: (open: boolean) => void = () => {}): { setVisible(visible: boolean): void; destroy(): void } {
  const window = document.defaultView!;
  const events = new AbortController();
  const options = { signal: events.signal };
  const launch = document.createElement('button');
  launch.type = 'button';
  launch.className = 'remove-ads-button';
  launch.textContent = copy.title;
  launch.setAttribute('aria-haspopup', 'dialog');

  const dialog = document.createElement('dialog');
  dialog.className = 'remove-ads-dialog';
  dialog.setAttribute('aria-labelledby', 'remove-ads-title');
  dialog.setAttribute('aria-describedby', 'remove-ads-description');
  const title = document.createElement('h2');
  title.id = 'remove-ads-title';
  title.textContent = launch.textContent;
  const description = document.createElement('p');
  description.id = 'remove-ads-description';
  description.textContent = copy.description;
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const actions = document.createElement('div');
  actions.className = 'remove-ads-actions';
  const action = document.createElement('button');
  action.type = 'button';
  const done = document.createElement('button');
  done.type = 'button';
  done.textContent = 'Done';
  done.autofocus = true;
  actions.append(action, done);
  dialog.append(title, description, status, actions);
  document.body.append(launch, dialog);

  let generation = 0;
  let pageHidden = false;
  function render(): void {
    if (!dialog.open) return;
    const view = purchase.view;
    const text = updateStatus(view);
    if (status.textContent !== text) status.textContent = text;
    const focusedAction = document.activeElement === action;
    const recheck = view.canRecheck && (view.state === 'pending' || view.state === 'unavailable');
    action.hidden = view.state !== 'available' && !recheck;
    action.textContent = view.state === 'available' ? `Buy · ${view.price}` : 'Check again';
    if (action.hidden && focusedAction) done.focus();
  }

  function foreground(): void {
    if (!pageHidden && !document.hidden) void purchase.refresh();
  }

  function interrupt(): void { generation++; }

  function dismiss(): void {
    dialog.close();
    onModalOpen(false);
    if (!launch.hidden) launch.focus();
  }

  launch.addEventListener('click', () => {
    if (launch.hidden || dialog.open) return;
    generation++;
    dialog.showModal();
    onModalOpen(true);
    render();
    void purchase.refresh();
  }, options);
  action.addEventListener('click', () => {
    const opened = generation;
    const current = () => !launch.hidden && dialog.open && generation === opened && !pageHidden &&
      !document.hidden && document.hasFocus();
    if (!current()) return;
    if (purchase.view.state === 'available') void purchase.buy(current);
    else void purchase.refresh();
  }, options);
  done.addEventListener('click', dismiss, options);
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); }, options);
  window.addEventListener('blur', interrupt, options);
  window.addEventListener('focus', foreground, options);
  window.addEventListener('pagehide', () => { pageHidden = true; interrupt(); }, options);
  window.addEventListener('pageshow', () => { pageHidden = false; foreground(); }, options);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) interrupt();
    else foreground();
  }, options);
  const unsubscribeChange = purchase.onChange(render);
  const unsubscribePause = onPause(interrupt);
  return {
    setVisible(visible) {
      launch.hidden = !visible;
      if (!visible) {
        interrupt();
        if (dialog.open) {
          dialog.close();
          onModalOpen(false);
        }
      }
    },
    destroy() {
      interrupt();
      events.abort();
      unsubscribeChange();
      unsubscribePause();
      if (dialog.open) onModalOpen(false);
      dialog.remove();
      launch.remove();
    },
  };
}
