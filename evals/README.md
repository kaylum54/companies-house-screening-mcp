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

Works through **OpenRouter** or the **Anthropic API**. Put one key in a `.env`
at the repository root (see `.env.example`) or export it, then:

```bash
npm run eval
```

If both keys are set, OpenRouter is used unless `--provider` says otherwise.

```bash
npm run eval -- --repeat 3                          # surface flakiness
npm run eval -- --model moonshotai/kimi-k3          # a different model
npm run eval -- --provider anthropic                # force the other route
npm run eval -- --case name-only-profile            # one case
npm run eval -- --out results/baseline.json         # keep a baseline
```

**No Companies House key is needed.** Nothing is executed — the server is
started only so the eval can read the real tool definitions and the real
instructions, and the model is asked one question with those tools offered.
What it reaches for on that first turn is the whole measurement.

### What a run costs

A full pass is fourteen questions at roughly four thousand input tokens each —
about 56k tokens, because eleven tool schemas and the server instructions go in
every time. Output is negligible.

| Model | Per M in / out | A full run |
|---|---|---|
| `z-ai/glm-5.2` *(default on OpenRouter)* | $0.97 / $3.04 | ~4p |
| `z-ai/glm-5.2:free` | free | free, but see below |
| `z-ai/glm-4.7` | $0.40 / $1.75 | ~2p |
| `deepseek/deepseek-v4-flash` | $0.08 / $0.16 | under 1p |
| `deepseek/deepseek-v4-pro` | $1.60 / $3.20 | ~7p |
| `moonshotai/kimi-k3` | $3.00 / $15.00 | ~13p |
| `anthropic/claude-opus-5` | $5.00 / $25.00 | ~22p |

Prices move; `curl https://openrouter.ai/api/v1/models` is the current answer.

**On the free tier.** `z-ai/glm-5.2:free` works and is not the default on
purpose. Free tiers queue and throttle, and this eval reports an inconsistent
result as a *finding* about overlapping tool descriptions. Throttling would
show up as flakiness with nothing to do with the descriptions — the one kind of
noise this suite must not manufacture. Use it for a quick look, not for a
number you intend to trust.

**Running it across several models is the better use.** A tool description that
only a frontier model reads correctly is a tool description with a problem. The
cheaper model failing a case is a finding about the description, not about the
model — and at these prices you can afford to find out. Every result file
records the provider and model, because a pass rate without a model beside it
means nothing.

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
