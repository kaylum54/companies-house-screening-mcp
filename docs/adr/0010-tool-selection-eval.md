# 10. A tool-selection eval, and why the scoring is tested harder than the model

- **Status:** accepted
- **Date:** 2026-08-20

## Context

By the end of phase 4 this repository had 223 tests, all of them answering the
same shape of question: given these inputs, does the code produce the right
outputs. Every one of them can pass while the server is useless, because none
of them touches the thing that decides whether a tool ever runs — a model
reading a description and choosing.

That defect has a particular character. It is silent. The tool works. The
tests pass. The tool simply never gets picked for the question it was built
for, or gets picked for a question it answers badly, and the only symptom is
that the server seems unhelpful.

## Decision

**Ask a real model which tool it would reach for, and score the answer.**
Fourteen questions phrased the way a person would phrase them, each with the
tool or tools that would be a correct first move, and — where it matters —
tools that would be wrong to call at all.

**Only the first turn.** Nothing is executed. The eval measures what the model
*reaches for*, which the first turn settles; running the full loop would cost
several times as much and would mix selection failures together with
everything downstream of them.

**The server's own instructions are the system prompt.** They are part of what
is being tested. "Prefer company_snapshot" and "never guess a number" either
change behaviour here or they are decoration, and until this existed there was
no way to tell which.

**Grounding is checked, not just tool names.** A case can require that no
company number appears in a call unless it appeared in the question. Three
cases exist for this, including one using a well-known real company name where
a model is most likely to recall a number from training and most likely to be
wrong. This is the eval for ADR 5.

**Flaky counts as failed.** A case that passes two runs in three is reported
as flaky and fails the run. Intermittent selection means two descriptions
overlap enough that the model is picking between them at random; the fix is
the descriptions.

**The scoring is pure and tested exhaustively; the model call is behind an
interface.** An eval whose scoring is wrong is worse than no eval, because it
produces a number people believe. So the judgement half runs with no key, no
network and no cost, and it is covered harder than most of the server —
including the invented-number detector, which is fed grounded numbers, short
numbers, numbers buried in punctuation, and names in a screening list.

**Two providers, and a cheap default.** The eval works through OpenRouter or
the Anthropic API. OpenRouter defaults to GLM 5.2 rather than to a frontier
model: a full pass is about 56k input tokens, four pence rather than thirty,
and an eval nobody runs because of the bill is not doing anything.

That is not only a cost argument. Running the same questions across several
models is the more useful thing to do, because a tool description only a
frontier model reads correctly is a tool description with a problem — the
cheaper model failing a case is a finding about the *description*. Every result
file records the provider and model, because a pass rate with no model beside
it means nothing.

The free tier is deliberately not the default. Free tiers queue and throttle,
and this eval reports inconsistency as a finding about overlapping
descriptions; throttling would manufacture exactly the noise the suite must
not manufacture.

## Consequences

Running it costs money and needs a key from one of two providers, so it is not
in CI by default. That is a real gap: tool descriptions can regress between runs. The
mitigation is that it is one command and the failure output names the case,
the check and the reason the case exists.

The pass rate is a property of a model at a moment, not of this repository.
`evals/results/` is gitignored for that reason — committing a run would turn a
measurement into a claim. A baseline can be kept deliberately with `--out`.

Cases are written by the same person who wrote the tool descriptions, which is
the usual weakness of a self-authored eval: it tests the questions the author
thought of. The counter is that the cases are about *behaviour under
ambiguity* — a name with no number, a list rather than one company, an
out-of-scope request — rather than about phrasing, and those are the
situations where a wrong choice does damage rather than merely wasting a call.
