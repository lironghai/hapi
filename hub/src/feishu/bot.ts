import * as lark from '@larksuiteoapi/node-sdk'
import { isObject } from '@hapi/protocol'
import type { Session, SyncEngine } from '../sync/syncEngine'
import type { Store } from '../store'
import type { NotificationChannel } from '../notifications/notificationTypes'
import { composeInputRequestNotification, getFirstPendingRequest, isInputRequestTool } from '../notifications/inputRequest'
import { getAgentName, getSessionName } from '../notifications/sessionInfo'
import { parseAccessToken } from '../utils/accessToken'
import { constantTimeEquals } from '../utils/crypto'
import { buildPermissionCard } from './cardBuilder'

export interface FeishuBotConfig {
    syncEngine: SyncEngine
    appId: string
    appSecret: string
    cliApiToken: () => string
    baseUrl?: string
    encryptKey?: string | null
    verificationToken?: string | null
    store: Store
}

// SDK failures can include request bodies, credentials and messages. Report only the category.
const sdkLogging = {
    loggerLevel: lark.LoggerLevel.error,
    logger: {
        error: () => console.error('[FeishuBot] Feishu SDK request failed.'),
        warn: () => {},
        info: () => {},
        debug: () => {},
        trace: () => {}
    }
}
const bindFirst = 'Not bound. Send /bind <CLI_API_TOKEN[:namespace]> in this private chat.'
const chooseSession = 'Use /sessions to list active sessions, then /send <session_id> <message> to select one.'
const help = [
    '/bind <CLI_API_TOKEN[:namespace]> — bind this account',
    '/sessions — list active sessions',
    '/send <session_id> <message> — send and select a session',
    '/cmds — list agent commands for the selected session',
    '/allow <request_id> or /deny <request_id> — answer a permission request',
    '/help — show these commands',
    'Other messages and slash commands go to the selected session, or the only active session.'
].join('\n')

interface MessageEvent {
    app_id?: string
    sender?: { sender_type: string; sender_id?: { open_id?: string } }
    message?: { chat_type: string; message_type: string; message_id: string; content: string }
}

export class FeishuBot implements NotificationChannel {
    private readonly apiClient: lark.Client
    private wsClient: lark.WSClient | null = null
    private readonly currentSessions = new Map<string, string>()
    private readonly platform: string

    constructor(private readonly config: FeishuBotConfig) {
        // Open IDs are scoped to the Feishu application that issued them.
        this.platform = `feishu:${config.appId}`
        this.apiClient = new lark.Client({
            appId: config.appId,
            appSecret: config.appSecret,
            domain: config.baseUrl ?? lark.Domain.Feishu,
            appType: lark.AppType.SelfBuild,
            // SDK error objects can contain request bodies and Authorization headers.
            ...sdkLogging
        })
    }

    async start(): Promise<void> {
        if (this.wsClient) return
        const dispatcher = new lark.EventDispatcher({
            verificationToken: this.config.verificationToken ?? undefined,
            encryptKey: this.config.encryptKey ?? undefined,
            ...sdkLogging
        }).register({
            'im.message.receive_v1': (data) => this.handleMessage(data),
            'card.action.trigger': (data: unknown) => this.handleCardAction(data)
        })
        const client = new lark.WSClient({
            appId: this.config.appId,
            appSecret: this.config.appSecret,
            domain: this.config.baseUrl ?? lark.Domain.Feishu,
            ...sdkLogging,
            onReady: () => console.log('[FeishuBot] WebSocket connected'),
            onError: () => {
                if (this.wsClient === client) this.stop()
                console.error('[FeishuBot] WebSocket connection failed. Check the app credentials and network.')
            }
        })
        this.wsClient = client
        try {
            await client.start({ eventDispatcher: dispatcher })
        } catch {
            if (this.wsClient === client) this.stop()
            console.error('[FeishuBot] Could not start WebSocket connection.')
        }
    }

    stop(): void {
        this.wsClient?.close({ force: true })
        this.wsClient = null
    }

    private async handleMessage({ app_id, sender, message }: MessageEvent): Promise<void> {
        if (app_id && app_id !== this.config.appId) return
        const openId = sender?.sender_id?.open_id
        if (sender?.sender_type !== 'user' || !openId || !message?.message_id ||
            message.chat_type !== 'p2p' || message.message_type !== 'text') return
        let content: unknown
        try {
            content = JSON.parse(message.content)
        } catch {
            return
        }
        if (!isObject(content) || typeof content.text !== 'string') return
        const text = content.text.trim()
        if (!text) return
        const result = await this.runCommand(openId, text, message.message_id).catch(() => 'HAPI could not process this request.')
        try {
            await this.apiClient.im.message.reply({
                path: { message_id: message.message_id },
                data: { msg_type: 'text', content: JSON.stringify({ text: result }) }
            })
        } catch {
            console.error('[FeishuBot] Failed to reply to private message.')
        }
    }

    private async runCommand(openId: string, text: string, messageId: string): Promise<string> {
        const [word, ...args] = text.split(/\s+/u)
        const command = word.toLowerCase().replace(/^\//u, '')
        if (command === 'bind') {
            const parsed = args.length === 1 ? parseAccessToken(args[0]) : null
            if (!parsed || !constantTimeEquals(parsed.baseToken, this.config.cliApiToken())) return 'Invalid access token.'
            // INSERT OR IGNORE preserves any prior binding, including on concurrent attempts.
            const user = this.config.store.users.addUser(this.platform, openId, parsed.namespace)
            return user.namespace === parsed.namespace
                ? `Bound to namespace: ${user.namespace}`
                : 'This account is already bound to another namespace.'
        }
        if (command === 'help' || command === 'start') return help

        const namespace = this.config.store.users.getUser(this.platform, openId)?.namespace
        if (!namespace) return bindFirst
        const engine = this.config.syncEngine
        const active = engine.getSessionsByNamespace(namespace).filter((session) => session.active)
        if (command === 'sessions' || command === 'list') {
            if (!active.length) return 'No active sessions.'
            return active.map((session) => [
                `${getSessionName(session)} (${getAgentName(session)})`, session.id, session.metadata?.path,
                session.metadata?.summary?.text
            ].filter(Boolean).join('\n')).join('\n\n')
        }
        if (['allow', 'approve', 'deny', 'reject'].includes(command)) {
            if (args.length !== 1) return `Usage: /${command} <request_id>`
            const matches = active.flatMap((session) => Object.keys(session.agentState?.requests ?? {})
                .filter((id) => id.startsWith(args[0])).map((id) => ({ session, id })))
            const exact = matches.filter(({ id }) => id === args[0])
            const candidates = exact.length ? exact : matches
            if (candidates.length !== 1) return 'No unique pending request matches this ID. Check the permission card.'
            const { session, id } = candidates[0]
            return this.answerPermission(session, id, command === 'allow' || command === 'approve')
        }

        const selected = active.find((session) => session.id === this.currentSessions.get(openId))
        let target = selected ?? (active.length === 1 ? active[0] : undefined)
        let prompt = text
        if (command === 'send') {
            const parts = /^\S+\s+(\S+)\s+([\s\S]+)$/u.exec(text)
            if (!parts) return 'Usage: /send <session_id> <message>'
            const matches = active.filter((session) => session.id.startsWith(parts[1]))
            target = matches.find((session) => session.id === parts[1]) ?? (matches.length === 1 ? matches[0] : undefined)
            if (!target) return 'No unique active session matches this ID.'
            prompt = parts[2]
        }
        if (command === 'commands' || command === 'cmds') {
            target ??= active.reduce<Session | undefined>((latest, session) =>
                !latest || session.updatedAt > latest.updatedAt ? session : latest, undefined)
            if (!target) return 'No active sessions.'
            const response = await engine.listSlashCommands(target.id, target.metadata?.flavor ?? 'claude')
            if (!response.success || !response.commands?.length) return 'No slash commands found.'
            const lines = response.commands.map((item) => `/${item.name}${item.description ? ' — ' + item.description : ''}`).join('\n')
            return [getSessionName(target), target.metadata?.path, lines].filter(Boolean).join('\n')
        }
        if (!target) return active.length ? chooseSession : 'No active sessions.'

        await engine.sendMessage(target.id, { text: prompt, sentFrom: 'feishu', localId: `${this.platform}:${messageId}` })
        this.currentSessions.set(openId, target.id)
        return `Message sent to ${getSessionName(target)}.`
    }

    private async handleCardAction(data: unknown) {
        const error = (content: string) => ({ toast: { type: 'error', content } })
        if (!isObject(data) || (data.app_id && data.app_id !== this.config.appId) ||
            !isObject(data.operator) || typeof data.operator.open_id !== 'string' || !data.operator.open_id ||
            !isObject(data.action) || !isObject(data.action.value)) return error('Invalid card action.')
        const { action, requestId, sessionId } = data.action.value
        if ((action !== 'approve' && action !== 'deny') || typeof requestId !== 'string' || typeof sessionId !== 'string') {
            return error('Invalid card action.')
        }
        const namespace = this.config.store.users.getUser(this.platform, data.operator.open_id)?.namespace
        if (!namespace) return error(bindFirst)
        const session = this.config.syncEngine.getSessionByNamespace(sessionId, namespace)
        if (!session?.active) return error('This permission request is unavailable.')
        try {
            const content = await this.answerPermission(session, requestId, action === 'approve')
            return { toast: { type: 'success', content } }
        } catch {
            return error('This permission request is unavailable. Open HAPI to check its status.')
        }
    }

    private async answerPermission(session: Session, requestId: string, allow: boolean): Promise<string> {
        const requests = session.agentState?.requests
        if (!requests || !Object.hasOwn(requests, requestId) || isInputRequestTool(requests[requestId].tool)) {
            throw new Error('Request cannot be answered here.')
        }
        if (allow) {
            await this.config.syncEngine.approvePermission(session.id, requestId)
            return 'Permission approved.'
        }
        await this.config.syncEngine.denyPermission(session.id, requestId)
        return 'Permission denied.'
    }

    private async notify(session: Session, msgType: 'text' | 'interactive', content: object): Promise<void> {
        if (!session.active) return
        const users = this.config.store.users.getUsersByPlatformAndNamespace(this.platform, session.namespace)
        for (const user of users) {
            try {
                await this.apiClient.im.message.create({
                    params: { receive_id_type: 'open_id' },
                    data: { receive_id: user.platformUserId, msg_type: msgType, content: JSON.stringify(content) }
                })
            } catch {
                console.error('[FeishuBot] Failed to deliver notification.')
            }
        }
    }

    async sendReady(session: Session): Promise<void> {
        await this.notify(session, 'text', { text: [`${getAgentName(session)} is ready`, getSessionName(session), session.metadata?.path].filter(Boolean).join('\n') })
    }

    async sendPermissionRequest(session: Session): Promise<void> {
        const pending = getFirstPendingRequest(session)
        if (!pending) return
        const input = composeInputRequestNotification(session, pending)
        if (input) {
            await this.notify(session, 'text', { text: `${input.title}\n${input.body}\nOpen the session in HAPI to answer.` })
            return
        }
        await this.notify(session, 'interactive', buildPermissionCard(session, pending))
    }

    async sendMessage(session: Session, text: string): Promise<void> {
        const display = text.length > 2000 ? text.slice(0, 2000) + '…' : text
        const heading = [`${getAgentName(session)} · ${getSessionName(session)}`, session.metadata?.path].filter(Boolean).join('\n')
        await this.notify(session, 'text', { text: `${heading}\n\n${display}` })
    }
}
