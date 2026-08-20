# 6. The result payload is sent twice, on purpose

- **Status:** accepted
- **Date:** 2026-08-20

## Context

A tool with an `outputSchema` returns `structuredContent`. The MCP
specification also says such a tool SHOULD return functionally equivalent
unstructured content, for hosts that do not read the structured field.

Following that literally means every response goes out twice, which roughly
doubles the token cost of a call — and this server's whole argument is about
not wasting the model's context.

## Decision

Send it twice: `structuredContent` plus the same object as compact JSON text.

The alternative considered was a short human-readable summary as the text
content — "EXAMPLE FIXTURE TRADING LIMITED (00000006), active, incorporated
1998, one outstanding charge" — which would be smaller and arguably nicer to
read.

It was rejected because the two payloads would then disagree. A host that
reads only text would get a summary, a host that reads structured content
would get the full record, and the same question would produce different
answers depending on which host asked it. Debugging that is miserable, and the
disagreement would be invisible until somebody hit it.

Fidelity beats the saving. The projection layer already does the useful part
of the work.

## Consequences

Every call costs about twice what the structured payload alone would. That is
a known, measured cost rather than an accident.

If the specification later drops the backwards-compatibility recommendation,
or hosts converge on reading `structuredContent`, this becomes an easy win:
delete one line in `ok()` and the cost halves. Worth revisiting then.

Error results are exempt. `isError: true` skips output-schema validation, so
failures carry only the error payload as text and are not duplicated.
