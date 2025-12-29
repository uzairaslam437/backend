// Compatibility shim: forward requests to Groq-based service
const groq = require('./groqService');

console.warn('[geminiService] Deprecated shim in use — forwarding calls to groqService');

module.exports = {
  async getOptimalDriver(context) {
    return groq.getOptimalDriver(context);
  }
};
