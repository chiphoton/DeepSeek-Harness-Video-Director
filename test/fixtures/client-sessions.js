/**
 * Give controller-only fixtures the rc.2 session contract. The fixture's
 * binding lookup is backing storage, never an unretained production borrow.
 * Its `open` callback records UI navigation; neither open nor current is
 * exposed on the sessions service consumed by the controller.
 */
export function sessionContext(context) {
  const fixtureContext = context
  if (context.connection?.rpc.call) context = { ...context, connection: { rpc: { call(channel, method, envelope, signal) {
    if (channel !== '/api' || method !== 'video-director') throw new Error('Unexpected Video Director transport')
    return fixtureContext.connection.rpc.call('/video-director', envelope.endpoint, envelope.payload, signal)
  } } } }
  const fixture = context.sessions
  if (!fixture || fixture.retain) return context
  const sessions = {
    list: {
      subscribe: listener => fixture.list.subscribe?.(listener) ?? (() => {}),
      getSnapshot() {
        const { current, ...catalog } = fixture.list.getSnapshot()
        return { ...catalog, byId: Object.fromEntries(Object.entries(catalog.byId).map(([id, row]) => [id, {
          ...row, retainedBy: { ...(current === id ? { mainView: 1 } : {}), ...row.retainedBy },
        }])) }
      },
    },
    create: (...args) => fixture.create(...args),
    refresh: async () => { await fixture.refresh?.() },
    retain(id, { source }) {
      if (source !== 'videoDirector') throw new Error('Missing Video Director ownership label')
      const binding = fixture.binding(id)
      if (!binding) throw new Error(`Unknown fixture session: ${id}`)
      let released = false
      return {
        sessionId: id,
        get binding() { if (released) throw new Error('Reference released'); return binding },
        ready: Promise.resolve(binding),
        release() { released = true },
      }
    },
    async using(id, options, operation) {
      const reference = sessions.retain(id, options)
      try { await reference.ready; return await operation(reference) }
      finally { reference.release() }
    },
  }
  return { ...context, sessions, uiWorkspace: { openSession: id => fixture.open?.(id) } }
}

export function controllerFixture(Controller) {
  return class extends Controller {
    constructor(context) { super(sessionContext(context)) }
  }
}
