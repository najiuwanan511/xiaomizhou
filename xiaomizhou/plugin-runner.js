import vm from 'node:vm';

export function builtinReply(event, date = new Date()) {
  if (event.hasForward || event.images?.length || !/^(?:\/?time|时间|当前时间)$/i.test(String(event.text || '').trim())) return null;
  const timeZone = 'Asia/Shanghai';
  const time = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(date);
  const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone, weekday: 'long' }).format(date);
  return { type: 'reply', text: `当前时间：${time} ${weekday}\n北京时间（UTC+8）`, plugin: '系统命令' };
}

export function runPlugin(source, event) {
  const safeEvent = JSON.stringify({
    channel: String(event.channel || ''),
    chatId: String(event.chatId || ''),
    userId: String(event.userId || ''),
    text: String(event.text || '').slice(0, 4000)
  });
  const code = `
    "use strict";
    const event = Object.freeze(JSON.parse(${JSON.stringify(safeEvent)}));
    const actions = [];
    const api = Object.freeze({
      reply(text) {
        if (actions.length >= 20) throw new Error('Too many plugin actions');
        actions.push({ type: 'reply', text: String(text).slice(0, 4000) });
      },
      forward(channel, target, text) {
        if (actions.length >= 20) throw new Error('Too many plugin actions');
        actions.push({ type: 'forward', channel: String(channel).slice(0, 40), target: String(target).slice(0, 120), text: String(text).slice(0, 4000) });
      }
    });
    ${source}
    if (typeof handle !== 'function') throw new Error('Define function handle(event, api)');
    handle(event, api);
    JSON.stringify(actions);
  `;
  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
  return JSON.parse(vm.runInContext(code, context, { timeout: 250 }));
}
