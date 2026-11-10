// The server's client for the document collector, which listens on a port of this machine.
class CollectorApi {
  static DEFAULT_PORT = 8888;

  static port() {
    if (!process.env.COLLECTOR_PORT) return this.DEFAULT_PORT;
    return Number(process.env.COLLECTOR_PORT);
  }

  constructor() {
    this.endpoint = `http://127.0.0.1:${CollectorApi.port()}`;
  }

  async acceptedFileTypes() {
    const res = await fetch(`${this.endpoint}/accepts`);
    return res.json();
  }

  async processDocument(filename) {
    const res = await fetch(`${this.endpoint}/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename }),
    });
    return res.json();
  }
}

module.exports = { CollectorApi };
