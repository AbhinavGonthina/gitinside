/**
 * A fake GitHub REST API for tests: `fetch` answering `GET /repos/{owner}/{repo}` and
 * `GET /repos/{owner}/{repo}/commits/HEAD` (sha media type) like api.github.com does.
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

    const parts = new URL(request.url).pathname.split("/").map(decodeURIComponent);
    const [, kind, owner = "", name = "", ...rest] = parts;
    const repo = kind === "repos" ? find(owner, name) : undefined;
    if (repo === undefined) return Response.json({ message: "Not Found" }, { status: 404 });
    if (rest.length === 0) {
      return Response.json({
        id: repo.id,
        name: repo.name,
        owner: { login: repo.owner },
        private: repo.private ?? false,
        default_branch: repo.defaultBranch ?? "main",
      });
    }
    if (rest.join("/") === "commits/HEAD") {
      if (repo.sha === null) {
        return Response.json({ message: "Git Repository is empty." }, { status: 409 });
      }
      return new Response(repo.sha, { headers: { "content-type": "application/vnd.github.sha" } });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  };

  return { fetch: fakeFetch, requests, failNext: (r) => void failures.push(r) };
}
