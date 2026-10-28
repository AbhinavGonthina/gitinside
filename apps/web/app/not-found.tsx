import Link from "next/link";

/** Any URL that isn't a page or a valid `/<owner>/<repo>`. */
export default function NotFound() {
  return (
    <main className="notice">
      <h1 className="notice__title">There's no page here.</h1>
      <p className="notice__text">
        Repo pages are at <code>/owner/repo</code>, the same path as on GitHub.
      </p>
      <p className="notice__links">
        <Link href="/">Analyze a repo</Link>
      </p>
    </main>
  );
}
