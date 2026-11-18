import { ArchiveButton, ChatInput, ChatMessages, DeleteButton } from "./components";

export function AgentsPage({ agents }: { agents: { id: string }[] }) {
  return (
    <ul>
      {agents.map((agent) => (
        <DeleteButton key={agent.id} endpoint={`/api/agents/${agent.id}`} label="Delete" />
      ))}
    </ul>
  );
}

export function ChannelPage({ ids }: { ids: string[] }) {
  return (
    <div>
      <ChatMessages apiUrl="/api/messages" socketUrl="/api/socket/messages" ids={ids} />
      <ChatInput apiUrl="/api/socket/messages" />
    </div>
  );
}

export function NotesPage() {
  return <ArchiveButton base="/api/notes" />;
}
