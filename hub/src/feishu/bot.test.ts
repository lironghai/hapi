import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as lark from '@larksuiteoapi/node-sdk'
import { Store } from '../store'
import type { Session, SyncEngine } from '../sync/syncEngine'
import { FeishuBot } from './bot'

const appId = 'cli_0123456789abcdef'
const platform = 'feishu:' + appId

function session(id: string, namespace: string, requests: Record<string, { tool: string; arguments: unknown }> = {}) {
    return { id, namespace, active: true, metadata: { name: id }, agentState: { requests } } as Session
}

describe('Feishu WebSocket events', () => {
    let bot: FeishuBot
    let store: Store
    let dispatcher: lark.EventDispatcher
    let token: string
    let sessions: Session[]
    const send = mock(async (_id: string, _payload: unknown) => {})
    const approve = mock(async (_id: string, _requestId: string) => {})
    const deny = mock(async (_id: string, _requestId: string) => {})
    const commands = mock(async () => ({ success: true, commands: [{ name: 'compact' }] }))
    const reply = mock(async (_payload: { data: { content: string } }) => ({}))
    const create = mock(async (_payload: { data: { receive_id: string; msg_type: string; content: string } }) => ({}))

    beforeEach(async () => {
        token = 'test-token'
        sessions = [session('alpha-main', 'alpha'), session('beta-main', 'beta')]
        store = new Store(':memory:')
        bot = new FeishuBot({
            appId, appSecret: 'test-secret', cliApiToken: () => token, store,
            syncEngine: {
                getSessionsByNamespace: (ns: string) => sessions.filter((s) => s.namespace === ns),
                getSessionByNamespace: (id: string, ns: string) => sessions.find((s) => s.id === id && s.namespace === ns),
                sendMessage: send,
                approvePermission: approve,
                denyPermission: deny,
                listSlashCommands: commands
            } as unknown as SyncEngine
        })
        Object.defineProperty(bot['apiClient'], 'im', { value: { message: { reply, create } } })
        spyOn(lark.WSClient.prototype, 'start').mockImplementation(async ({ eventDispatcher }) => {
            dispatcher = eventDispatcher
        })
        await bot.start()
    })

    afterEach(() => {
        bot.stop()
        store.close()
        mock.restore()
        for (const fn of [send, approve, deny, commands, reply, create]) fn.mockClear()
    })

    function dispatch(type: string, event: Record<string, unknown>) {
        return dispatcher.invoke({ schema: '2.0', header: { event_type: type, app_id: appId }, event }, { needCheck: false })
    }

    function receive(text: string, openId = 'alice', overrides: Record<string, unknown> = {}) {
        return dispatch('im.message.receive_v1', {
            sender: { sender_type: 'user', sender_id: { open_id: openId } },
            message: { chat_type: 'p2p', message_type: 'text', message_id: 'om_1', content: JSON.stringify({ text }) },
            ...overrides
        })
    }

    function click(openId: string, sessionId: string, requestId: string, action = 'approve') {
        return dispatch('card.action.trigger', {
            operator: { open_id: openId },
            action: { tag: 'button', value: { sessionId, requestId, action } }
        })
    }

    it('requires a current token, a private human sender, and an app-scoped open ID', async () => {
        await receive('/bind wrong:alpha')
        expect(store.users.getUsersByPlatform(platform)).toEqual([])
        await receive('/bind test-token:alpha', 'alice', { sender: { sender_type: 'user' }, open_id: 'injected' })
        await receive('/bind test-token:alpha', 'alice', { sender: { sender_type: 'app', sender_id: { open_id: 'app' } } })
        await receive('/bind test-token:alpha', 'alice', {
            message: { chat_type: 'group', message_type: 'text', message_id: 'om_2', content: '{"text":"/bind test-token:alpha"}' }
        })
        expect(reply).toHaveBeenCalledTimes(1)
        expect(store.users.getUsersByPlatform(platform)).toEqual([])

        await receive('/bind test-token:alpha')
        await receive('/bind test-token:alpha', 'bob')
        await receive('/bind test-token:beta')
        expect(store.users.getUsersByPlatformAndNamespace(platform, 'alpha').map((u) => u.platformUserId).sort())
            .toEqual(['alice', 'bob'])
        expect(store.users.getUsersByPlatformAndNamespace(platform, 'beta')).toEqual([])
        token = 'new-token'
        await receive('/bind test-token', 'carol')
        expect(store.users.getUser(platform, 'carol')).toBeNull()
        await receive('/bind new-token', 'carol')
        expect(store.users.getUser(platform, 'carol')?.namespace).toBe('default')
    })

    it('routes prompts and agent commands only to active sessions in the bound namespace', async () => {
        store.users.addUser(platform, 'alice', 'alpha')
        store.users.addUser('feishu:another-app', 'other', 'beta')
        await receive('/send beta-main hello')
        await receive('hello', 'other')
        expect(send).not.toHaveBeenCalled()
        sessions.push(session('alpha-secondary', 'alpha'))
        await receive('/send alp ambiguous')
        await receive('ambiguous')
        expect(send).not.toHaveBeenCalled()
        await receive('/send alpha-s code\n    indented')
        expect(send).toHaveBeenCalledWith('alpha-secondary', {
            text: 'code\n    indented', sentFrom: 'feishu', localId: platform + ':om_1'
        })
        await receive('/compact')
        expect(send.mock.lastCall?.[0]).toBe('alpha-secondary')
        await receive('/cmds')
        expect(commands).toHaveBeenCalledWith('alpha-secondary', 'claude')
        await receive('/sessions')
        expect(reply.mock.lastCall?.[0].data.content).not.toContain('beta-main')
    })

    it('validates the actual card operator and live request before every decision', async () => {
        const request = { tool: 'Bash', arguments: { command: 'pwd' } }
        sessions = [
            session('alpha-main', 'alpha', { 'request-1': request, 'request-2': request }),
            session('beta-main', 'beta', { 'foreign-request': request })
        ]
        store.users.addUser(platform, 'alice', 'alpha')
        store.users.addUser(platform, 'bob', 'beta')
        await bot.sendPermissionRequest(sessions[0])
        const delivery = create.mock.lastCall?.[0].data
        expect(delivery?.receive_id).toBe('alice')
        expect(delivery?.msg_type).toBe('interactive')
        const value = JSON.parse(delivery!.content).elements[1].actions[0].value
        expect(value).toEqual({ action: 'approve', sessionId: 'alpha-main', requestId: 'request-1' })
        await click('bob', value.sessionId, value.requestId)
        await dispatch('card.action.trigger', { open_id: 'alice', action: { value } })
        await click('alice', value.sessionId, 'stale-request')
        await receive('/allow request-')
        await receive('/allow foreign-request')
        expect(approve).not.toHaveBeenCalled()
        expect(await click('alice', value.sessionId, value.requestId)).toMatchObject({ toast: { type: 'success' } })
        expect(approve).toHaveBeenCalledWith('alpha-main', 'request-1')
        await receive('/deny request-2')
        expect(deny).toHaveBeenCalledWith('alpha-main', 'request-2')
    })

    it('sends questions without permission buttons and directs the operator to HAPI', async () => {
        store.users.addUser(platform, 'alice', 'alpha')
        sessions = [session('alpha-main', 'alpha', {
            question: { tool: 'request_user_input', arguments: { questions: [{ question: 'Which color?' }] } }
        })]
        await bot.sendPermissionRequest(sessions[0])
        expect(create.mock.lastCall?.[0].data).toMatchObject({ msg_type: 'text', receive_id: 'alice' })
        expect(create.mock.lastCall?.[0].data.content).toContain('Which color?')
        await receive('/allow question')
        await click('alice', 'alpha-main', 'question')
        expect(approve).not.toHaveBeenCalled()
    })

    it('closes the active socket once and can restart', async () => {
        const close = spyOn(lark.WSClient.prototype, 'close')
        await bot.start()
        expect(lark.WSClient.prototype.start).toHaveBeenCalledTimes(1)
        bot.stop()
        bot.stop()
        expect(close).toHaveBeenCalledTimes(1)
        expect(close).toHaveBeenCalledWith({ force: true })
        await bot.start()
        expect(lark.WSClient.prototype.start).toHaveBeenCalledTimes(2)
    })
})
