export interface Member {
  id: string;
  team: string;
}

const members: Member[] = [];

export async function membersOf(team: string): Promise<Member[]> {
  return members.filter((member) => member.team === team);
}

export async function invitesFor(team: string): Promise<string[]> {
  return (await membersOf(team)).map((member) => member.id);
}

export async function invite(team: string, id: string): Promise<Member> {
  const member = { id, team };
  members.push(member);
  return member;
}
