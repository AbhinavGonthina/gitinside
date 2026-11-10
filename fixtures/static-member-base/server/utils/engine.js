// The server's handle on a local model engine it runs as a child process on this machine.
function port() {
  return Number(process.env.ENGINE_PORT) || 8000;
}

class Engine {
  static get baseUrl() {
    return `http://127.0.0.1:${port()}`;
  }

  static async isRunning() {
    const res = await fetch(`${this.baseUrl}/api/v1/health`);
    return res.ok;
  }
}

class EngineLLM {
  static apiBasePath() {
    return `${Engine.baseUrl}/api/v1`;
  }

  async load(model) {
    const res = await fetch(`${EngineLLM.apiBasePath()}/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    return res.json();
  }
}

module.exports = { Engine, EngineLLM };
