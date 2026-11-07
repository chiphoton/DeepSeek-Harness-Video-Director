import { directorToolParameters } from './agent-tool-parameters.js'

export function libraryTool(host) {
  return {
    name: 'vd_library',
    description: 'Use and manage Video Director skills in the linked workflow. Load selected versions with load. When chat context recommends a built-in skill, invoke it by name for this turn. Create/save immutable instruction versions. Read resources only as needed. Scripts are resources, never automatically executed.',
    parameters: directorToolParameters(
      ['list', 'create', 'save', 'get', 'bind', 'load', 'invoke', 'active', 'unload', 'resource', 'archive', 'publish', 'read-result'],
      'list {query?,name?,offset?,limit?} (name is exact); create {name,description,content,resources?} or {markdown:SKILL.md,resources?}; save {id,expectedRevision,name,description,content,resources?,frontmatter?}; get {id,revision?}; bind/load {id,revision}; invoke {name} (built-in, no saved selection); active {}; unload {id}; resource {id,revision,path,offset?}; archive/publish {id,expectedRevision,enabled?}; read-result {resultId,path,offset?,limit?}',
    ),
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    presentCall: args => ({ card: 'generic', title: args.command === 'invoke' ? `Skill · ${args.args?.name ?? 'built-in'}` : `Skills: ${args.command}`, kind: ['create', 'save', 'bind', 'unload', 'archive', 'publish'].includes(args.command) ? 'edit' : 'read' }),
    async execute(args, exec) {
      if (!exec.agent?.session?.id) throw new Error('Library tool requires an owning chat session')
      const result = await host.rpc('library/command', { ...args, protocol: 'vd/1', sessionId: exec.agent.session.id }, exec.signal)
      if (!result.ok) throw Object.assign(new Error(result.error.message.slice(0, 500)), { code: result.error.code })
      return result.value
    },
  }
}
