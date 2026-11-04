/**
 * A fake GitHub REST API for tests: `fetch` answering `GET /repos/{owner}/{repo}` and
 * `GET /repos/{owner}/{repo}/commits/HEAD` (sha media type), and
 * `GET /repos/{owner}/{repo}/languages` like api.github.com does.
 * Names match ignoring case, as on GitHub.
 */

export interface FakeRepo {
  id: number;
  owner: string;
  name: string;
  private?: boolean;
  defaultBranch?: string;
  /** The default branch's head; `null` for an empty repo (GitHub answers 409). */
  sha: string | null;
  /** GitHub's `size` in KiB; default 1,024. `null` leaves the field out. */
  sizeKb?: number | null;
  /** `GET …/languages`'s answer, bytes by language; default 50,000 bytes of TypeScript. */
  languages?: Record<string, unknown>;
  /**
   * Names it had before a rename or transfer (`owner/name`). Like GitHub, a request under one
   * is a `301` to `/repositories/{id}` (plus the rest of the path), answered as the repo.
   */
  formerNames?: string[];
}

export interface FakeGitHub {
  fetch: typeof fetch;
  /** Every request seen: method, URL, and whether it carried a token. */
  requests: { url: string; authorization: string | null; accept: string | null }[];
  /** Answer the next request with this instead (once). */
  failNext(response: Response | Error): void;
}

export function fakeGitHub(repos: FakeRepo[]): FakeGitHub {
  const requests: FakeGitHub["requests"] = [];
  const failures: (Response | Error)[] = [];
  const find = (owner: string, name: string) =>
    repos.find(
      (r) =>
        r.owner.toLowerCase() === owner.toLowerCase() &&
        r.name.toLowerCase() === name.toLowerCase(),
    );

  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push({
      url: request.url,
      authorization: request.headers.get("authorization"),
      accept: request.headers.get("accept"),
    });
    const failure = failures.shift();
    if (failure instanceof Error) throw failure;
    if (failure !== undefined) return failure;

    const url = new URL(request.url);
    const parts = url.pathname.split("/").map(decodeURIComponent);
    const [, kind, owner = "", name = "", ...more] = parts;
    let rest = more;
    let repo = kind === "repos" ? find(owner, name) : undefined;
    if (kind === "repos" && repo === undefined) {
      const former = `${owner}/${name}`.toLowerCase();
      const moved = repos.find((r) => r.formerNames?.some((n) => n.toLowerCase() === former));
      if (moved !== undefined) {
        const location = new URL(`/repositories/${moved.id}`, url);
        if (rest.length > 0) location.pathname += `/${rest.join("/")}`;
        return Response.json(
          { message: "Moved Permanently", url: location.href },
          { status: 301, headers: { location: location.href } },
        );
      }
    }
    if (kind === "repositories") {
      repo = repos.find((r) => String(r.id) === owner);
      rest = [name, ...more].filter((part) => part !== "");
    }
    if (repo === undefined) return Response.json({ message: "Not Found" }, { status: 404 });
    if (rest.length === 0) {
      return Response.json({
        id: repo.id,
        name: repo.name,
        owner: { login: repo.owner },
        private: repo.private ?? false,
        default_branch: repo.defaultBranch ?? "main",
        ...(repo.sizeKb === null ? {} : { size: repo.sizeKb ?? 1_024 }),
      });
    }
    if (rest.join("/") === "commits/HEAD") {
      if (repo.sha === null) {
        return Response.json({ message: "Git Repository is empty." }, { status: 409 });
      }
      return new Response(repo.sha, { headers: { "content-type": "application/vnd.github.sha" } });
    }
    if (rest.join("/") === "languages") {
      return Response.json(repo.languages ?? { TypeScript: 50_000 });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  };

  return { fetch: fakeFetch, requests, failNext: (r) => void failures.push(r) };
}
