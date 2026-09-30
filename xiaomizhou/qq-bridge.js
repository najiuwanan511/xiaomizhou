export function oneBotEvent(input) {
  if (input?.post_type !== 'message' || !['private', 'group'].includes(input.message_type)) return null;
  const userId = String(input.user_id ?? '');
  const chatId = String(input.message_type === 'group' ? input.group_id ?? '' : input.user_id ?? '');
  const messageId = String(input.message_id ?? '');
  if (!/^\d+$/.test(userId) || !/^\d+$/.test(chatId) || !messageId || messageId.length > 120) return null;
  if (userId === String(input.self_id ?? '')) return null;
  const text = Array.isArray(input.message)
    ? input.message.filter(part => part?.type === 'text').map(part => String(part.data?.text ?? '')).join('')
    : String(input.raw_message ?? input.message ?? '').replace(/\[CQ:[^\]]*\]/g, '');
  if (!text.trim()) return null;
  return { channel: 'qq', chatId, userId, text: text.slice(0, 4000), messageType: input.message_type, messageId, deliveryKey: `${input.self_id ?? ''}:${input.message_type}:${chatId}:${messageId}` };
}

export function qqDestination(action, event) {
  if (action.type === 'reply') return { type: event.messageType, id: event.chatId };
  if (action.type !== 'forward' || action.channel !== 'qq') return null;
  const match = /^(group|private):(\d+)$/.exec(action.target);
  return match ? { type: match[1], id: match[2] } : null;
}

export async function oneBotCall(config, action, params) {
  const endpoint = new URL(action, config.endpoint.endsWith('/') ? config.endpoint : `${config.endpoint}/`);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(config.accessToken ? { Authorization: `Bearer ${config.accessToken}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(10000),
    redirect: 'error'
  });
  if (!response.ok) throw new Error(`OneBot HTTP ${response.status}`);
  const result = await response.json();
  if (result.status !== 'ok' && result.retcode !== 0) throw new Error(`OneBot retcode ${result.retcode ?? 'unknown'}`);
  return result.data;
}

export async function sendQq(config, destination, text) {
  if (!/^\d+$/.test(destination.id) || !Number.isSafeInteger(Number(destination.id))) throw new Error('Invalid QQ destination');
  const params = { message: String(text).slice(0, 4000), auto_escape: true };
  params[destination.type === 'group' ? 'group_id' : 'user_id'] = Number(destination.id);
  return oneBotCall(config, destination.type === 'group' ? 'send_group_msg' : 'send_private_msg', params);
}
