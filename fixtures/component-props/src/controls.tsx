import { memo } from "react";
import { DeleteButton, DeleteButton as deleteButton } from "./components";

// Spread attributes could set any prop, so the element's request stays unread.
export function SpreadPage({ rest }: { rest: { endpoint: string; label: string } }) {
  return <DeleteButton {...rest} />;
}

// A component wrapped in `memo` isn't followed: its own request stays where it is.
export const MemoDelete = memo(function MemoDelete({ endpoint }: { endpoint: string }) {
  const onDelete = () => fetch(endpoint, { method: "DELETE" });
  return <button onClick={onDelete}>delete</button>;
});

export function ReportsPage() {
  return <MemoDelete endpoint="/api/reports/1" />;
}

// A component only passed around as a value: no element calls it.
export function ReportButton({ endpoint }: { endpoint: string }) {
  const onDelete = () => fetch(endpoint, { method: "DELETE" });
  return <button onClick={onDelete}>delete</button>;
}

export const BUTTONS = { report: ReportButton };

// A prop that only fills the query leaves the route fixed: the request stays here.
export function SearchBox({ q }: { q?: string }) {
  const search = () => fetch(`/api/messages?q=${q || ""}`);
  return <input onChange={search} />;
}

export function SearchPage() {
  return <SearchBox q="hello" />;
}

// A plain function's options aren't props: its request stays where it is, unread.
export function notify(config: { url: string }) {
  return fetch(config.url, { method: "POST" });
}

export function alertAll() {
  return notify({ url: "/api/notes/archive" });
}

// A spread after a prop could override it.
export function SpreadLastPage({ rest }: { rest: { label: string } }) {
  return <DeleteButton endpoint="/api/agents/1" label="x" {...rest} />;
}

// An element's children are its `children` prop, so the default doesn't apply.
export function Fetcher({ children = "/api/messages" }: { children?: string }) {
  const load = () => fetch(children);
  return <button onClick={load} />;
}

export function ChildrenPage() {
  return <Fetcher>/api/reports/9</Fetcher>;
}

// A lowercase tag is an HTML element, even when its name is a component's alias.
export function LowercasePage() {
  return <deleteButton endpoint="/api/agents/3" label="x" />;
}

// `.href` reads the URL a parameter holds, as before props.
export function useDownload(target: URL) {
  return fetch(target.href);
}

export function useReportDownload() {
  return useDownload(new URL("/api/reports/7", window.location.origin));
}
