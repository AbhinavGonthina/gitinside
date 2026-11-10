const { OpenAI } = require("openai");

// A provider whose base is set once, in its constructor, and handed to the SDK client.
class RouterLLM {
  constructor() {
    this.basePath = "https://openrouter.ai/api/v1";
    this.openai = new OpenAI({ baseURL: this.basePath, apiKey: process.env.ROUTER_KEY });
  }

  async complete(messages) {
    return this.openai.chat.completions.create({ model: "auto", messages });
  }
}

// A base reassigned after construction stays a value only known at runtime.
class Mirror {
  constructor() {
    this.base = "https://mirror-a.example.com";
  }

  init(region) {
    this.base = `https://mirror-${region}.example.com`;
  }

  async status() {
    const res = await fetch(`${this.base}/status`);
    return res.json();
  }
}

module.exports = { RouterLLM, Mirror };
