/** Text generation — Groq (streaming). */
const groq = require('./groq');

const generate = (opts) => groq.streamChat(opts);

module.exports = { generate };
