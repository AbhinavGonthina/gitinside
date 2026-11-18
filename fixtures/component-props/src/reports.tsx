import { DeleteButton } from "./components";
import { useChatQuery } from "./hooks";

// A prop after every spread stands.
export function SpreadFirstPage({ rest }: { rest: { label: string } }) {
  return <DeleteButton {...rest} endpoint="/api/agents/2" label="x" />;
}

// A prop's default applies when the element doesn't set it.
export function ReportViewer({ base = "/api/reports", id }: { base?: string; id: string }) {
  const load = () => fetch(`${base}/${id}`);
  return <button onClick={load}>open</button>;
}

export function ReportPage() {
  return <ReportViewer id="1" />;
}

// A hook given a `const` options object.
const INBOX = { apiUrl: "/api/messages", limit: 5 };

export function useInbox() {
  return useChatQuery(INBOX);
}

// A component passing its props on whole.
export function Feed(props: { apiUrl: string; limit: number }) {
  const load = useChatQuery(props);
  return <div onClick={load} />;
}

export function FeedPage() {
  return <Feed apiUrl="/api/messages" limit={20} />;
}
