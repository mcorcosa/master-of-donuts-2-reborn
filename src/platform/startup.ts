import type { PlatformServices } from '@playbridge/core';

export async function startGame(
  { lifecycle, capabilities }: Pick<PlatformServices, 'lifecycle' | 'capabilities'>,
  prepareGame: () => Promise<void>,
): Promise<void> {
  await lifecycle.initialize();
  const reportsLoading = capabilities().hostLoading === 'available';
  if (reportsLoading) lifecycle.loading({ phase: 'start' });
  await prepareGame();
  if (reportsLoading) lifecycle.loading({ phase: 'finish' });
  await lifecycle.start();
}
