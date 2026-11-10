// Outside services the server reads, each base held in a class or object member.
class Catalog {
  static CATALOG_URL = "https://catalog.example.com/v1/models";

  static async models() {
    const res = await fetch(this.CATALOG_URL);
    return res.json();
  }
}

class Mailer {
  #deploymentId;

  constructor(deploymentId) {
    this.#deploymentId = deploymentId;
  }

  #getBaseUrl() {
    console.log("Getting the base URL");
    return `https://script.google.com/macros/s/${this.#deploymentId}/exec`;
  }

  async send(params) {
    const res = await fetch(this.#getBaseUrl(), {
      method: "POST",
      body: JSON.stringify(params),
    });
    return res.json();
  }
}

const Hub = {
  apiBase: "https://hub.example.com/v1",

  explore: async function () {
    const res = await fetch(`${this.apiBase}/explore`);
    return res.json();
  },
};

module.exports = { Catalog, Mailer, Hub };
