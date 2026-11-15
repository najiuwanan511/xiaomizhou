// Test-only transport and clock. Production never imports this module.
import fs from 'node:fs';
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const originalInterval = globalThis.setInterval;
Date.now = () => originalNow() + Number(fs.readFileSync(process.env.QQ_NOTIFY_TEST_CLOCK, 'utf8'));
globalThis.setInterval = (callback, milliseconds, ...args) => originalInterval(callback, milliseconds === 15000 ? 50 : milliseconds, ...args);
globalThis.fetch = async (url, options) => {
  if (String(url) === 'https://www.pushplus.plus/send') {
    fs.appendFileSync(process.env.QQ_NOTIFY_TEST_CAPTURE, options.body + '\n');
    return new Response(JSON.stringify({ code: 200 }), { headers: { 'Content-Type': 'application/json' } });
  }
  return originalFetch(url, options);
};
