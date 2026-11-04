export async function loadMembers(team: string) {
  return fetch(`/api/members?team=${team}`);
}

export async function dropMember(team: string) {
  return fetch(`/api/members?team=${team}`, { method: "DELETE" });
}

export async function loadInvites(team: string) {
  return fetch(`/api/invites?team=${team}`);
}

export async function sendInvite(team: string, id: string) {
  return fetch(`/api/invites?team=${team}`, { method: "POST", body: JSON.stringify({ id }) });
}

export async function loadTeams() {
  return fetch("/api/teams");
}

export async function renameTeam() {
  return fetch("/api/teams", { method: "PUT" });
}

export default function Roster() {
  return null;
}
