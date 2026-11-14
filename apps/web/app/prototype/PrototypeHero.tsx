"use client";

import { encodeState, Explorer, type ExplorerState } from "@gitinside/viewer";
import { useEffect, useState } from "react";
import { prototypeGraphUrl, prototypeHref, type PrototypeRepo } from "../../lib/prototypeLinks";
import { loadGraph, type GraphLoad } from "../../lib/repoStatus";
import { layoutWorker } from "./PrototypeDiagram";

/**
 * The prototype landing's hero (M10-design §3.5, M10.3e1): the real explorer in its `hero` mode
 * on a pin's stored graph, its suggested trace looping. It's interactive; "Open the full diagram"
 * opens the pin's prototype page in the state the hero is in (what's broken down, the trace and
 * its step), so a reader who started exploring here goes on from there.
 *
 * The hero is part of the page: a plain wheel scrolls past it, and Ctrl K stays the page's.
 * While the graph loads, the frame keeps its size with a line moving along its top (M10-design
 * §4, "loading that moves"; text alone under reduced motion). A load that fails says so in the
 * frame, and the link still opens the pin's page.
 */
export function PrototypeHero({ repo }: { repo: PrototypeRepo }) {
  const [load, setLoad] = useState<GraphLoad>();
  const [state, setState] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    loadGraph(prototypeGraphUrl(repo), { signal: controller.signal }).then(setLoad, () => {
      // aborted: the page moved on
    });
    return () => controller.abort();
  }, [repo]);

  return (
    <figure className="hero" aria-labelledby="hero-caption">
      <div className="hero__frame" data-loading={load === undefined ? "" : undefined}>
        {load === undefined ? (
          <p className="hero__state" role="status">
            Loading {repo.owner}/{repo.name}
          </p>
        ) : load.ok ? (
          <Explorer
            graph={load.graph}
            design="prototype"
            hero
            layoutWorker={layoutWorker}
            onStateChange={(s: ExplorerState) => setState(encodeState(s))}
          />
        ) : (
          <p className="hero__state" role="alert">
            {load.title}
          </p>
        )}
      </div>
      <figcaption id="hero-caption" className="hero__caption">
        <span>
          <span className="hero__repo">
            {repo.owner}/{repo.name}
          </span>
          , drawn live. Drag, zoom, click: it&apos;s real.
        </span>
        <a className="hero__open" href={prototypeHref(repo, state)}>
          Open the full diagram
        </a>
      </figcaption>
    </figure>
  );
}
