# url-builders

Tests (M5C.7d, ADR-0032 amendment): URLs returned by repo functions that only build a string from their parameters, against an Express server in the same package.

- `paths.ts` holds the builders: `shelfPath(shelfId)` (a function declaration returning one template), `shelfUrls.books(shelfId)` (an arrow property calling `shelfPath`), `shelfUrls.shelfPath` (a shorthand property), and `loanUrl(loanId)` (an arrow `const` concatenating with `+`). Each call is read with its arguments bound: `openShelf` ⇒ `GET /api/shelves/{}`, `listBooks` ⇒ `GET /api/shelves/{}/books`, `addBook` ⇒ `POST /api/shelves/{}/books`, `returnLoan` ⇒ `DELETE /api/loans/{}`.
- `LoanCard.tsx` builds URLs with React's `useCallback((id) => …, [])` and `useMemo(() => (q) => …, [])`, which give back that function: `GET /api/loans/{}` and `GET /api/catalog/search` (the query dropped).
- `trimSlashes(base)` changes its argument with `replace`, so it isn't a builder: `searchCatalog`'s URL starts with its unknown result and is `DYNAMIC_URL`.

All matches are `exact` (one service).
