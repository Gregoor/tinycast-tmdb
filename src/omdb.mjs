/// Reading OMDb's responses.
///
/// Lives in its own module because it holds a bug worth a regression test, and importing the fetch
/// script would run a real pass.

/// This reads the fields the pass uses out of the body rather than parsing the body as JSON, because
/// OMDb's responses are not reliably JSON: some titles carry a stray backslash in a field nobody reads
/// — `"Writer":"Matthew Clark \, Tesha Clark"`, a name list it failed to escape — which makes the
/// whole response unparseable and, since it is stored data, would cost that title its ratings on every
/// future run. Repairing the escapes is guesswork (the same body also has `\"` that must be left
/// alone); reading four known-shaped fields is not. Measured: 1 in 481,000.
export const readResponse = (body) => {
  const field = (name) => new RegExp(`"${name}":"([^"]*)"`).exec(body)?.[1];
  if (field("Response") === "False") return { Response: "False", Error: field("Error") };
  return {
    Response: field("Response"),
    imdbRating: field("imdbRating"),
    imdbVotes: field("imdbVotes"),
    Metascore: field("Metascore"),
    Ratings: [...body.matchAll(/\{"Source":"([^"]+)","Value":"([^"]+)"\}/g)]
      .map(([, Source, Value]) => ({ Source, Value })),
  };
};
