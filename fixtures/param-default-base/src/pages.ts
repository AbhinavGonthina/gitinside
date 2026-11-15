import { BillingClient, NotesClient, TeamsClient, UsersClient } from "./clients";

const notes = new NotesClient();
const billing = new BillingClient("token");
const users = new UsersClient();
const remoteUsers = new UsersClient("https://users.example.com/api");
const teams = new TeamsClient();

export function register(make: new () => object): object {
  return new make();
}

export async function dashboard(): Promise<unknown[]> {
  register(TeamsClient);
  return [await notes.list(), await notes.create("x"), await billing.plans(), await users.users(), remoteUsers, teams];
}
