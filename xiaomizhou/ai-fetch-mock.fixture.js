const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  if (String(input) === 'https://api.openai.com/v1/responses') {
    const count = JSON.parse(options.body).input.length;
    return Promise.resolve(new Response(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: `AI-${count}` }] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }
  return originalFetch(input, options);
};
