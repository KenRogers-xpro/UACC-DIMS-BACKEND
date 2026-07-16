// Shared by lib/embeddings.js and lib/insights.js — pulled out on its own
// so neither has to import the other (which would otherwise be a circular
// import, since embeddings.js's ingestDocument() calls into insights.js's
// matchUnansweredQueriesForDocument()).
export function toVectorLiteral(values) {
  return `[${values.join(',')}]`
}
