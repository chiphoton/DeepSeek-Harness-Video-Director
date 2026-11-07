import { directorToolParameters } from './agent-tool-parameters.js'

export function qualityTool(host) {
  return {
    name: 'vd_quality',
    description: 'Record and execute a bounded Video Director quality loop. Create criteria and limits, step to run/inspect, provide evidence for perceptual checks, revise only when needed, then step again. Stop at accepted/stopped. Never bypass the plan budget with separate run calls. Host deadlines cancel runs; agent reasoning continues within its current DSH turn.',
    parameters: directorToolParameters(
      ['create', 'list', 'get', 'step', 'stop', 'revise', 'evaluate', 'read-result'],
      'create {brief,criteria:[{id,type:graph-valid|run-completed|node-count|artifact-count|text-includes|perceptual,min?,nodeId?,text?,description?}],maxIterations?,maxJobs?,maxMinutes?}; list {}; get/step/stop {id}; revise {id,edits,idempotencyKey?}; evaluate {id,criterionId,verdict:pass|fail|unknown|needs-human,reason,confidence:0..1,evidence:[{jobId,assetId?,atSeconds?}]}; read-result {resultId,path,offset?,limit?}',
    ),
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    presentCall: args => ({ card: 'generic', title: `Quality: ${args.command}`, kind: ['step', 'stop'].includes(args.command) ? 'execute' : ['create', 'revise', 'evaluate'].includes(args.command) ? 'edit' : 'read' }),
    async execute(args, exec) {
      if (!exec.agent?.session?.id) throw new Error('Quality tool requires an owning chat session')
      const result = await host.rpc('quality/command', { ...args, args: args.command === 'step' ? { waitMs: 10000, ...args.args } : args.args, protocol: 'vd/1', sessionId: exec.agent.session.id }, exec.signal)
      if (!result.ok) throw Object.assign(new Error(result.error.message.slice(0, 500)), { code: result.error.code })
      return result.value
    },
  }
}
