/** JSON Schema passed directly to the DSH tool registry and model. */
export function directorToolParameters(commands, argumentHelp, argumentProperties) {
  return {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'Use the workflow project.id from the linked project context.' },
      command: { type: 'string', enum: commands, description: 'The operation to perform. Use the command key.' },
      args: { type: 'object', ...(argumentProperties && { properties: argumentProperties }), additionalProperties: true, description: argumentHelp },
    },
    required: ['projectId', 'command'],
    additionalProperties: false,
  }
}
