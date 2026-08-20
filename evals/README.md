# Tool-selection eval

Every other test in this repository asks *does the tool work*. This one asks
the question none of them can:

> **When a person asks a real question, does a model reach for the right tool?**

That failure is invisible to unit tests. A tool can be correct, fast,
well-typed and fully covered, and still never get chosen — or get chosen for
the wrong question — because its description is vague, because two
descriptions overlap, or because the server instructions never say when to
prefer one over another. It is the most common real defect in published MCP
servers and nothing else here would catch it.

## Running it

Put `ANTHROPIC_API_KEY` in a `.env` at the repository root (see
`.env.example`) or export it in your shell, then:

```bash
npm run eval
```

Options:

```bash
npm run eval -- --repeat 3                  # each case three times, to surface flakiness
npm run eval -- --case name-only-profile    # one case
npm run eval -- --model claude-sonnet-5     # a different model
npm run eval -- --out results/baseline.json
```

**No Companies House key is needed.** Nothing is executed — the server is
started only so the eval can read the real tool definitions and the real
instructions, and the model is asked one question with those tools offered.
What it reaches for on that first turn is the whole measurement.

The Anthropic key comes from [console.anthropic.com](https://console.anthropic.com).
A full run is fourteen short requests; at `--repeat 3` it is forty-two.

## What is scored

| Check | Fails when |
|---|---|
| `tool_choice` | The first tool called is not one the case expects. |
| `no_forbidden_tools` | A tool the case rules out was called at all. |
| `arguments` | The right tool was called with the wrong arguments. |
| `no_invented_company_number` | A company number was passed that does not appear in the question. |

The last one is the eval for the decision this whole server is built around.
Given a name and no number, a model will produce a company number that looks
right, and a plausible wrong company number returns *a different real company*
— real directors, real charges — that nothing downstream marks as wrong. Three
cases exist purely to catch that, including one using a well-known real company
name, where a model is most likely to recall a number from training and most
likely to be wrong.

The comparison is deliberately generous: a number counts as grounded if it
appears in the question in any form, including without its leading zeros or
buried in punctuation. Anything that survives that is genuinely invented.

## Flakiness is a finding, not noise

A case that passes twice and fails once is reported as `FLAKY`, not as a pass.
Intermittent selection means two tool descriptions overlap enough that the
model is choosing between them at random. The fix is the descriptions, not the
case. `--repeat 3` is the setting that surfaces it.

The runner exits non-zero when anything fails **or is flaky**, so a regression
in tool selection can fail a pipeline the same way a failing unit test does.

## What is tested without a key

Everything except the model call. `tests/evals.test.ts` covers the scoring
logic exhaustively — including the invented-number detector, which is given
grounded numbers, ungrounded numbers, numbers written short, numbers buried in
prose, and company names in a screening list — plus the case definitions
themselves: unique ids, only real tool names, a rationale on every case, and
coverage of every tool a question could reasonably reach for.

The wiring is proved end to end with a scripted model: real tool definitions
and real instructions from the server, scripted selections, real scoring. An
eval whose scoring is wrong is worse than no eval, because it produces a number
people believe.

## Results

`evals/results/` is gitignored. A run's output is per-key, per-model and
per-day, and committing one would turn a measurement into a claim. Keep a
snapshot deliberately with `--out` if you want a baseline to compare against.
