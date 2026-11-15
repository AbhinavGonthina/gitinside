export class NotesClient {
  constructor(private baseURL = "/api/notes") {}

  list() {
    return fetch(this.baseURL);
  }

  create(title: string) {
    return fetch(`${this.baseURL}/`, { method: "POST", body: JSON.stringify({ title }) });
  }
}

export class BillingClient {
  constructor(
    private token: string,
    readonly baseURL: string = "/api/billing",
  ) {}

  plans() {
    return fetch(`${this.baseURL}/plans`, { headers: { authorization: this.token } });
  }
}

// Controls: one `new` passes a base, and the other class is handed out as a value.
export class UsersClient {
  constructor(private baseURL = "/api") {}

  users() {
    return fetch(`${this.baseURL}/users`);
  }
}

export class TeamsClient {
  constructor(private baseURL = "/api") {}

  teams() {
    return fetch(`${this.baseURL}/teams`);
  }
}
