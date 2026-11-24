/**
 * Continue a failed subagent instead of replacing it.
 *
 * The shipped `subagent` tool returns only a display name, and that name stays
 * bound to the child that first took it. A Session id never reaches the model,
 * so once a child settles there is no address for it and the only visible
 * option is to start another child from scratch. A `send_message` also parks
 * input on an idle child without waking it, so an addressed continuation can
 * stop unnoticed.
 *
 * This row supplies the missing entry point:
 *
 * - `subagent_status` lists the calling agent's whole subagent tree with
 *   Session ids, names, labels, activity, and the turn each child is on.
 * - `subagent_continue` resumes one listed child by Session id or by name
 *   through `ctx.subagents.sendMessage`, then wakes it when it is resident but
 *   idle, so it continues its own transcript, tools, and permissions instead
 *   of a replacement starting over.
 * - A bounded automatic continuation follows a failed direct child at the
 *   configured delegation depth, then stops and logs once the budget is spent.
 *
 * The module imports nothing on purpose: a profile bundle is installed from a
 * linked workspace directory, where only the browser module table's packages
 * resolve, so official Harness packages are unavailable to it. Tool
 * definitions are therefore plain objects with JSON Schema parameters, and
 * every delivery reuses the message the subagent service itself accepted,
 * which needs no message constructor.
 *
 * Activation is defensive by design. `apply` never throws: any failure leaves
 * only a warning in the log, because a failing Host row must not take the
 * whole profile boot down with it.
 *
 * @module @local/dsh-subagent-continue
 */

/** Service names this row needs; the patch row declares the same inject list. */
export const inject = ['tools', 'systemPrompt', 'subagents', 'agents']

const STATUS_TOOL = 'subagent_status'
const CONTINUE_TOOL = 'subagent_continue'

/** Opening line of a model-initiated continuation. */
const CONTINUE_OPENING =
  'Continue your work from where it stopped. Pick up the task you were given and carry it to the end.'

/** Opening line of an automatic continuation. */
const RETRY_OPENING =
  'Your previous turn failed before it finished. Continue the same task from where it stopped; the work you '
  + 'already completed is in this conversation. This is an automatic continuation of the same session.'

/** Model-facing name of one catalog row. */
function addressOf(row) {
  return row.path ?? row.id
}

/** Whether the subagent service can cold-resume this local child. */
function resumable(row) {
  return row.kind === 'child' && (row.mode === 'continuable' || row.mode === 'one-shot')
}

/** Turn position facts of one child's own events. */
function frontierOf(events) {
  let turn
  let ended
  for (const event of events) {
    if (event.type === 'turn/start') turn = event.data.turn
    if (event.type === 'turn/end') ended = event.data.reason.kind
  }
  return { turn, ended }
}

/** Sum the four disjoint durable usage buckets of one child. */
function usageOf(events) {
  let total = 0
  for (const event of events) {
    if (event.type !== 'assistant/message' || event.data.usage === undefined) continue
    const usage = event.data.usage
    total += usage.inputTokens + usage.outputTokens
      + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  }
  return total
}

/** Render a thrown value without letting coercion escape. */
function describeThrown(value) {
  try {
    return value instanceof Error ? `${value.name}: ${value.message}` : String(value)
  } catch {
    return 'unrenderable failure'
  }
}

/**
 * Install the continuation tools, their guidance, and the automatic continuation.
 * @param ctx - Host context owning every registration.
 * @param raw - this entry's config; omitted fields take the documented defaults.
 */
export function apply(ctx, raw) {
  try {
    install(ctx, raw)
  } catch (error) {
    // A failing Host row must not fail the profile boot; keep the diagnostic
    // and leave this row inactive instead.
    ctx.logger.warn(`subagent-continue: not activated: ${describeThrown(error)}`)
  }
}

/**
 * Build every registration once activation is known to be possible.
 * @param ctx - Host context with the injected services.
 * @param raw - config object from the row.
 */
function install(ctx, raw) {
  const settings = raw !== null && typeof raw === 'object' ? raw : {}
  const maxRetries = Math.max(0, Math.trunc(Number(settings.maxRetries ?? 2)))
  const configuredDepth = settings.retryDepth === undefined
    ? undefined
    : Math.max(0, Math.trunc(Number(settings.retryDepth)))
  const maxStatusRows = Math.max(1, Math.trunc(Number(settings.maxStatusRows ?? 200)))

  /** Automatic continuations already sent to one failed child. */
  const attempts = new Map()
  /** Children whose automatic continuations are spent. */
  const spent = new Set()

  /** Delegation depth of one agent: the persisted header is the monotone floor. */
  const depthOf = (agent) =>
    (typeof agent.session?.header?.delegationDepth === 'number' ? agent.session.header.delegationDepth : 0)

  /**
   * Deliver one continuation and start its turn.
   * @param parent - live agent allowed to message inside this tree.
   * @param childId - resumable child Session id.
   * @param text - complete message text.
   * @returns whether the child was already live before the delivery.
   */
  const continueChild = async (parent, childId, text) => {
    const liveBefore = ctx.agents.get(childId) !== undefined
    const messageId = await ctx.subagents.sendMessage(
      parent,
      childId,
      [{ type: 'text', text }],
      { signal: AbortSignal.timeout(120_000) },
    )
    const child = ctx.agents.get(childId)
    if (child === undefined) return { live: liveBefore }
    // A cold resume starts its own turn. A resident but idle child keeps the
    // accepted message parked until something wakes it, so wake it with the
    // message the service already accepted: one wake starts one turn.
    const parked = [...child.inbox.nextTurn, ...child.inbox.nextStep]
      .find(message => message.id === messageId)
    if (parked !== undefined) {
      if (child.status === 'running') child.steer(parked)
      else child.followup(parked)
    }
    return { live: true }
  }

  /** Resolve a listed member's Session id from a name or a Session id. */
  const resolveTarget = async (caller, target, signal) => {
    const root = ctx.subagents.rootOf(caller)
    const rows = await ctx.subagents.listDescendants(root.id, signal)
    const named = rows.find(row => addressOf(row) === target || row.id === target)
    if (named !== undefined) {
      if (!resumable(named)) throw new Error(`member "${target}" is not a continuable local subagent`)
      return named.id
    }
    return ctx.subagents.resolveName(caller, target, signal)
  }

  /**
   * Follow one failed child. The policy is the delegating parent's own
   * delegation depth: by default only this agent's own delegations (depth 0),
   * because that is the level where a replacement child would be started from
   * nothing. An explicit `retryDepth` follows a different parent level, and an
   * explicit `false` disables automatic following entirely.
   */
  const follow = (info) => {
    const parent = ctx.agents.get(info.parentSessionId)
    if (parent === undefined) return
    if (maxRetries === 0) return
    const policy = configuredDepth ?? 0
    if (depthOf(parent) !== policy) return
    const used = attempts.get(info.id) ?? 0
    if (used >= maxRetries) {
      if (spent.has(info.id)) return
      spent.add(info.id)
      // The official settlement notice already told the parent this attempt
      // failed; one log line records that this row stops following it.
      ctx.logger.info(
        `subagent-continue: automatic continuations for "${info.name}" are spent; `
        + `continue it with ${CONTINUE_TOOL} to keep its work`,
      )
      return
    }
    attempts.set(info.id, used + 1)
    void (async () => {
      try {
        await continueChild(parent, info.id, RETRY_OPENING)
      } catch (error) {
        ctx.logger.warn(
          `subagent-continue: automatic continuation of "${info.id}" was not delivered: ${describeThrown(error)}`,
        )
      }
    })()
  }

  ctx.on('subagent/end', (info) => {
    if (info.stopReason === 'completed' || info.stopReason === 'aborted') {
      attempts.delete(info.id)
      spent.delete(info.id)
      return
    }
    if (info.local !== true) return
    follow(info)
  })

  ctx.tools.register({
    name: STATUS_TOOL,
    description:
      'List your whole subagent tree: each member\'s session id, full name, task label, activity, and current turn. '
      + 'Use it to find a failed or stopped subagent before continuing it.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['root', 'omitted', 'members'],
        properties: {
          root: { type: 'string' },
          omitted: { type: 'integer' },
          members: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'id', 'kind', 'status', 'resumable'],
              properties: {
                name: { type: 'string' },
                id: { type: 'string' },
                kind: { type: 'string' },
                status: { type: 'string' },
                resumable: { type: 'boolean' },
                description: { type: 'string' },
                turn: { type: 'integer' },
                turnEnded: { type: 'boolean' },
                usage: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.members.length === 0
          ? 'No subagents yet: this session has delegated no work. Start one with `subagent` or `subagent_fork`.'
          : value.members.map(member =>
          `${member.name} [${member.kind}/${member.status}] id=${member.id}`
          + (member.turn === undefined
            ? ''
            : ` turn ${member.turn}${member.turnEnded === true ? ' ended' : ' open'}`)
          + (member.description === undefined ? '' : ` — ${member.description}`)
          + (member.resumable ? '' : ' (not resumable)'),
        ).join('\n') + (value.omitted > 0 ? `\n… ${value.omitted} more members omitted` : ''),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const caller = exec.agent
      if (caller === undefined) throw new Error(`${STATUS_TOOL} requires a calling agent`)
      const root = ctx.subagents.rootOf(caller)
      const rows = await ctx.subagents.listDescendants(root.id, exec.signal)
      const members = rows.slice(0, maxStatusRows).map((row) => {
        const name = addressOf(row)
        if (row.kind === 'diagnostic') {
          return { name, id: row.id, kind: 'unreadable', status: row.reason, resumable: false }
        }
        const base = {
          name,
          id: row.id,
          kind: row.mode,
          status: row.activity,
          ...resumable(row) ? { resumable: true } : {},
          ...row.label === undefined ? {} : { description: row.label },
        }
        const live = ctx.agents.get(row.id)
        if (live === undefined) return base
        const events = live.session.snapshotEvents()
        const frontier = frontierOf(events)
        return {
          ...base,
          ...frontier.turn === undefined ? {} : { turn: frontier.turn, turnEnded: frontier.ended !== undefined },
          usage: usageOf(events),
        }
      })
      return { root: root.id, omitted: Math.max(0, rows.length - members.length), members }
    },
  })

  ctx.tools.register({
    name: CONTINUE_TOOL,
    description:
      'Send a follow-up to a subagent of your tree and continue its own conversation. '
      + 'Use it after a subagent failed, ran out of room, or stopped early: the same session resumes with its '
      + 'transcript, tools, and permissions instead of the task being delegated to a new subagent. '
      + 'An inactive subagent resumes from its saved session. Returns the accepted message id; later work arrives '
      + 'as the usual completion notice.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['agent'],
      properties: {
        agent: {
          type: 'string',
          description: `Name or session id of a member of your subagent tree, as shown by ${STATUS_TOOL}.`,
        },
        message: {
          type: 'string',
          description: 'What the subagent should do next. Omit to tell it to continue the work it was given.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['messageId', 'name', 'resumed'],
        properties: {
          messageId: { type: 'string' },
          name: { type: 'string' },
          resumed: { type: 'boolean' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `continuation delivered to subagent ${value.name} (${args.agent})`
          + (value.resumed ? '; it was resumed from its saved session' : ''),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const caller = exec.agent
      if (caller === undefined) throw new Error(`${CONTINUE_TOOL} requires a calling agent`)
      const target = await resolveTarget(caller, args.agent, exec.signal)
      if (target === caller.id) throw new Error(`${CONTINUE_TOOL} addresses another member of your subagent tree`)
      const text = typeof args.message === 'string' && args.message.trim() !== ''
        ? `${CONTINUE_OPENING}\n\n${args.message}`
        : CONTINUE_OPENING
      const { live } = await continueChild(caller, target, text)
      const child = ctx.agents.get(target)
      const name = child === undefined ? args.agent : ctx.subagents.namesOf(child).self
      return { messageId: String(target), name, resumed: !live }
    },
  })

  ctx.systemPrompt.section({
    name: 'tool:subagent_continue',
    text: (context) => {
      const visible = context.scope === undefined
        ? ctx.tools.get(CONTINUE_TOOL)
        : ctx.tools.get(CONTINUE_TOOL, context.scope, context.toolSet)
      if (visible === undefined) return ''
      return 'A failed delegation is resumed, not replaced: call `subagent_status` to find the member and '
        + '`subagent_continue` to carry its work forward. Delegating the same task again to a new subagent begins '
        + 'from nothing and leaves the failed one behind.'
    },
  })
}
