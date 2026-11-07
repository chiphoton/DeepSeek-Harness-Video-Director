import { directorToolParameters } from './agent-tool-parameters.js'

export function workspaceTool(host) {
  return {
    name: 'vd_workspace',
    description: 'Discover shared Video Director operations and invoke the same Host handlers as the UI. Use manifest, then describe for one operation. View actions select/frame/zoom/inspect/preview require an open canvas and return a receipt; check view-status for acknowledgement. Credentials stay in dsh settings.',
    parameters: directorToolParameters(
      ['manifest', 'describe', 'call', 'view', 'view-status', 'storage', 'read-result'],
      'manifest {}; describe {name}; call {name,input}; view {action,nodeIds?,zoom?,viewId?}; view-status {id}; storage {action:info|change|reset|open,dataDir?,expectedDataDir?}; read-result {resultId,path,offset?,limit?}',
    ),
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    presentCall: args => ({ card: 'generic', title: `Workspace: ${args.command}`, kind: ['call', 'view'].includes(args.command) ? 'edit' : 'read' }),
    async execute(args, exec) {
      if (!exec.agent?.session?.id) throw new Error('Workspace tool requires an owning chat session')
      if (args.command === 'storage') {
        const project = await host.store.getProject(args.projectId)
        if (project.sessionId !== exec.agent.session.id) throw new Error('Storage operations require the owning chat session')
        if (!['info', 'change', 'reset', 'open'].includes(args.args?.action)) throw new Error('Choose info, change, reset, or open. Folder dialogs require human input.')
        const result = await host.rpc(`storage/${args.args.action}`, { dataDir: args.args.dataDir, expectedDataDir: args.args.expectedDataDir }, exec.signal)
        if (!result.ok) throw Object.assign(new Error(result.error.message.slice(0, 500)), { code: result.error.code })
        return result.value
      }
      const result = await host.rpc('workspace/command', { ...args, protocol: 'vd/1', sessionId: exec.agent.session.id }, exec.signal)
      if (!result.ok) throw Object.assign(new Error(result.error.message.slice(0, 500)), { code: result.error.code })
      return result.value
    },
  }
}
