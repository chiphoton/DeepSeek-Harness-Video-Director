import { DirectorLauncher, DirectorOverlay } from './App'
import { ProjectChatSource } from './chat-source'
import { DirectorController } from './controller'
import type { ClientContext } from './types'

/** Cordis services used by the browser half of Video Director. */
export const inject = ['slots', 'sessions', 'connection', 'modelDirectories']

/**
 * Register an additive launcher and a frame-wide studio surface. The plugin
 * deliberately does not register `root`: DSH keeps ownership of its native
 * shell, Session Controller, approval surfaces, and conversation lifecycle.
 */
export function apply(ctx: ClientContext): void {
  const director = new DirectorController(ctx)
  const chat = new ProjectChatSource(ctx, director)

  ctx.effect(() => {
    void director.start()
    return () => {
      chat.dispose()
      director.dispose()
    }
  }, 'video-director: project runtime')

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'video-director',
    order: 30,
    label: 'Video Director',
    inject: () => ({ director, chat }),
  }, DirectorLauncher))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'video-director-studio',
    order: 100,
    label: 'Video Director Studio',
    inject: () => ({ director, chat }),
  }, DirectorOverlay))
}
