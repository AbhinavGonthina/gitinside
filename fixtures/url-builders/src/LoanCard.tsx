import { useCallback, useEffect, useMemo, useState } from "react";

const LOANS = "/api/loans";

export function LoanCard({ loanId }: { loanId: string }) {
  const [due, setDue] = useState("");
  // React gives back the function itself, so a call of it builds the URL in place.
  const loanEndpoint = useCallback((id: string) => `${LOANS}/${id}`, []);
  const searchUrl = useMemo(() => (q: string) => "/api/catalog/search?q=" + q, []);

  useEffect(() => {
    fetch(loanEndpoint(loanId))
      .then((res) => res.json())
      .then((loan: { due: string }) => setDue(loan.due));
  }, [loanEndpoint, loanId]);

  const findSimilar = () => fetch(searchUrl(loanId));

  return (
    <button type="button" onClick={findSimilar}>
      Due {due}
    </button>
  );
}
