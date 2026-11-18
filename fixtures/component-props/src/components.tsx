import { useChatQuery } from "./hooks";

// A destructured prop, sent from a handler inside the component.
export function DeleteButton({ endpoint, label }: { endpoint: string; label: string }) {
  const onDelete = async () => {
    await fetch(endpoint, { method: "DELETE" });
  };
  return <button onClick={onDelete}>{label}</button>;
}

// A prop read as `props.apiUrl`.
export function ChatInput(props: { apiUrl: string }) {
  const send = () => fetch(props.apiUrl, { method: "POST" });
  return <form onSubmit={send} />;
}

// A path prop and an ID prop.
export function ChatItem({ socketUrl, id }: { socketUrl: string; id: string }) {
  const edit = () => fetch(`${socketUrl}/${id}`, { method: "PATCH" });
  return <button onClick={edit}>edit</button>;
}

// Passes its props on: to a hook's options, and to an element inside a `.map`.
export function ChatMessages({
  apiUrl,
  socketUrl,
  ids,
}: {
  apiUrl: string;
  socketUrl: string;
  ids: string[];
}) {
  const load = useChatQuery({ apiUrl, limit: 10 });
  return (
    <div onClick={load}>
      {ids.map((id) => (
        <ChatItem key={id} id={id} socketUrl={socketUrl} />
      ))}
    </div>
  );
}

// A prop destructured in the body.
export function ArchiveButton(props: { base: string }) {
  const { base } = props;
  const archive = () => fetch(`${base}/archive`, { method: "POST" });
  return <button onClick={archive}>archive</button>;
}
