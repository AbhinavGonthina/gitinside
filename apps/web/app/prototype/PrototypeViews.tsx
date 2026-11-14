import { ViewLinks } from "@gitinside/viewer";
import { prototypeApiHref, prototypeHref, type PrototypeRepo } from "../../lib/prototypeLinks";

/**
 * The prototype bar's `Diagram | API map` switch (M10-design §3.3, M10.3f3): links between a repo's
 * two pages, plain `<a>`s so the page transition runs (M10.3e2b).
 */
export function PrototypeViews({
  repo,
  current,
}: {
  repo: PrototypeRepo;
  current: "diagram" | "api";
}) {
  return (
    <ViewLinks
      label="Views"
      links={[
        { label: "Diagram", href: prototypeHref(repo), current: current === "diagram" },
        { label: "API map", href: prototypeApiHref(repo), current: current === "api" },
      ]}
    />
  );
}
