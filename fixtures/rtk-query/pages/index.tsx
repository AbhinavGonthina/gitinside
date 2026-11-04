import { useAddTaskMutation, useListTasksQuery } from "../store/api";
import { useListLabelsQuery } from "../store/labels";
import { useStats } from "../hooks/stats";

export default function Board() {
  const { data: tasks } = useListTasksQuery();
  const { data: labels } = useListLabelsQuery();
  const [addTask] = useAddTaskMutation();
  const { totals } = useStats("week");
  return (
    <main>
      <h1>{tasks?.length ?? 0} tasks</h1>
      <p>{labels?.join(", ") ?? "no labels"}</p>
      <p>{totals.data ? "stats loaded" : "loading stats"}</p>
      <button onClick={() => addTask({ title: "New task" })}>Add</button>
    </main>
  );
}
