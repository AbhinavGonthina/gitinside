/**
 * The demo repos' pinned commits (SPEC M9, D13.1; `docs/demos/`): the three commits whose
 * every inferred edge was checked by hand, which the landing page's gallery links. Shared by
 * the website, which analyzes a pin when its permalink is opened and nobody has
 * (`viewRepo`, ADR-0255), and the worker, whose retention never evicts one (`listDemoShas`).
 *
 * Each pin names its repo by GitHub's ID, which survives a rename or transfer, and its commit
 * by the full SHA. `owner` and `name` are the spelling at pinning, which the permalink uses;
 * a test checks every pin against `docs/demos/repos.json`.
 */

/** One demo repo's checked commit. */
export interface DemoPin {
  /** GitHub's repo ID. */
  providerRepoId: number;
  owner: string;
  name: string;
  /** The checked commit: 40 lowercase hex characters. */
  sha: string;
}

/** The three demo pins, in the gallery's order (`docs/demos/README.md`'s table). */
export const DEMO_PINS: readonly DemoPin[] = [
  {
    providerRepoId: 649170660,
    owner: "Mintplex-Labs",
    name: "anything-llm",
    sha: "308b27662b2f6fd4947791d61c797945c609fcbc",
  },
  {
    providerRepoId: 553759919,
    owner: "shadcn-ui",
    name: "taxonomy",
    sha: "298a8857c7128a0d121e7f699dfd729f23b3966d",
  },
  {
    providerRepoId: 709027512,
    owner: "getmaxun",
    name: "maxun",
    sha: "99c6bd0d42b14336b706ba121a3757f62a9814f7",
  },
];

/**
 * The pin `/<owner>/<name>/<sha>` names, if any: the name compared ignoring case (GitHub's
 * own rule), the SHA exactly (permalinks take it lowercase).
 */
export function findDemoPin(
  ref: { owner: string; name: string; sha: string },
  pins: readonly DemoPin[] = DEMO_PINS,
): DemoPin | undefined {
  const owner = ref.owner.toLowerCase();
  const name = ref.name.toLowerCase();
  return pins.find(
    (pin) =>
      pin.sha === ref.sha && pin.owner.toLowerCase() === owner && pin.name.toLowerCase() === name,
  );
}
