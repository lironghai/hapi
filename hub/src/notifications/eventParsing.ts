import { isObject } from '@hapi/protocol'
import { extractSearchableMessageText, isLiveStreamSnapshot, unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import type { SyncEvent } from '../sync/syncEngine'

type EventEnvelope = {
    type?: unknown
    data?: unknown
}

function extractEventEnvelope(message: unknown): EventEnvelope | null {
    if (!isObject(message)) {
        return null
    }

    if (message.type === 'event') {
        return message as EventEnvelope
    }

    const content = message.content
    if (!isObject(content) || content.type !== 'event') {
        return null
    }

    return content as EventEnvelope
}

export function extractMessageEventType(event: SyncEvent): string | null {
    if (event.type !== 'message-received') {
        return null
    }

    const message = event.message?.content
    const envelope = extractEventEnvelope(message)
    if (!envelope) {
        return null
    }

    const data = isObject(envelope.data) ? envelope.data : null
    const eventType = data?.type
    return typeof eventType === 'string' ? eventType : null
}

export function extractAssistantMessageText(event: SyncEvent): string | null {
    if (event.type !== 'message-received') return null

    const record = unwrapRoleWrappedRecordEnvelope(event.message.content)
    if (!record || (record.role !== 'agent' && record.role !== 'assistant')) return null
    if (isLiveStreamSnapshot(record) || (isObject(record.meta) && record.meta.sentFrom === 'hapi-system')) return null

    const content = record.content
    const data = isObject(content) && isObject(content.data) ? content.data : null
    if (data?.parentToolUseId || data?.parent_tool_use_id || data?.error) return null

    // Use the chat's visible-text projection so tool payloads, reasoning,
    // sidechain output and machine-readable footers stay out of external DMs.
    const visible = extractSearchableMessageText(record)
    return visible?.role === 'assistant' ? visible.text : null
}
