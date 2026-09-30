import vm from 'node:vm';

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
