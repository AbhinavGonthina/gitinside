# component-props

React function components and hooks whose request reads a prop (M12.1e6, ADR-0312), as in agentboard-ce's `<DeleteButton endpoint={…}>` and discord-clone's chat components. React calls a component with one object, its element's attributes, so each element is a call of the component:

- `AgentsPage`'s `<DeleteButton endpoint={…}>` (a destructured prop, sent from a handler inside the component; the element inside a `.map`) links `DELETE /api/agents/:id`.
- `ChannelPage`'s `<ChatMessages>` links `GET /api/messages` through the hook `useChatQuery({ apiUrl })` (its options destructured) and `PATCH /api/socket/messages/:messageId` through the `<ChatItem socketUrl={socketUrl}>` it renders in a `.map`. Its `<ChatInput>` (`props.apiUrl`) links `POST /api/socket/messages`.
- `NotesPage`'s `<ArchiveButton>` (`const { base } = props`) links `POST /api/notes/archive`.
- In `reports.tsx`: `ReportPage`'s `<ReportViewer id="1">` takes the prop's default `base`; `useInbox` passes a `const` options object; `FeedPage`'s `<Feed>` passes its props on whole to the hook; `SpreadFirstPage` writes `endpoint` after a spread, so it stands.

Each request sits at the outermost element or call, as EVALUATION.md §1 labels it.

The controls in `controls.tsx` stay where their request can't be read:

- Spread attributes alone (`SpreadPage`) or after the prop (`SpreadLastPage`), and an element whose body gives `children` (`ChildrenPage`, not the prop's default): `DYNAMIC_URL` at the element.
- A component wrapped in `memo` (`MemoDelete`) and a component only passed around as a value (`ReportButton`): at their own `fetch`.
- A lowercase tag (`<deleteButton>`, an alias of a component): an HTML element, no request.
- A prop that fills only the query (`SearchBox`): its route is fixed, so it stays at its own `fetch`.
- A plain function's options (`notify(config)`'s `config.url`): not props, at its own `fetch`.
- `.href` on a hook's parameter (`useDownload`): read as before, at the caller.
