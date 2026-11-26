import type { Session } from '../sync/syncEngine'
import type { PendingNotificationRequest } from '../notifications/inputRequest'
import { getAgentName, getSessionName } from '../notifications/sessionInfo'
import { formatToolArgumentsDetailed } from '../notifications/toolArgs'

export function buildPermissionCard(session: Session, { request, requestId }: PendingNotificationRequest) {
    const detail = formatToolArgumentsDetailed(request.tool, request.arguments)
    const message = [
        getSessionName(session),
        session.metadata?.path,
        request.tool,
        detail,
        `/allow ${requestId}  ·  /deny ${requestId}`
    ].filter(Boolean).join('\n')
    const button = (action: 'approve' | 'deny', title: string) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: title },
        type: action === 'approve' ? 'primary' : 'danger',
        value: { action, sessionId: session.id, requestId }
    })
    return {
        config: { wide_screen_mode: true, enable_forward: false },
        header: { title: { tag: 'plain_text', content: `${getAgentName(session)} requests permission` } },
        elements: [
            { tag: 'div', text: { tag: 'plain_text', content: message } },
            { tag: 'action', actions: [button('approve', 'Allow'), button('deny', 'Deny')] }
        ]
    }
}
