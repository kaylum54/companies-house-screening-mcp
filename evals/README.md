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

## What it found, and what changed because of it

The first version had 15 cases and scored 100%, which is a smoke test rather
than a measurement — an eval nothing fails cannot tell you which descriptions
are weak. Rebuilt to 58 cases weighted towards the hard ones, it scored **93%**
and produced four findings. Three were acted on; the fourth is left open on
purpose.

| Finding | What it was | What changed |
|---|---|---|
| A VAT number became a company number | Asked to check a supplier by VAT number, the model turned `745938421` into `07459384` and called `get_company` with it. Exactly the failure this server exists to prevent, arriving by a route the grounding check could not see — the digits *were* in the question. | The trap cases now forbid **any** company number, because these questions contain none. Enumerating a decoy's derivations is a losing game. |
| `screen_companies` was described by an example | Its description led with "the list-of-suppliers question — paste from a spreadsheet". Two of four phrasings of the same intent missed it entirely and looped `company_snapshot` three times instead, at four times the request cost. | Rewritten to lead with the trigger condition — *more than one company* — rather than one example use case. |
| "Read only" read as background | Asked to file a confirmation statement, the model called `get_company` on two runs in three, presenting a read as progress. The instruction saying the server cannot write sat near the bottom and was being read as context. | Moved to the first line of the server instructions and made directive: say it is not possible, do not call a read tool instead. |
| Charges asked without the word "charges" | "Has 04138203 borrowed against its assets?" goes to `get_company` first on one run in three, before correcting to `get_charges`. | **Left open.** It could be made to pass by adding `get_company` to the accepted tools, but the profile's `has_charges` flag is [demonstrably unreliable](../tests/fixtures/README.md), so reaching for the profile on a charges question is a mild error. Widening the expectation to reach 100% would be tuning the test to the result. |

After the three fixes, the same 58 cases × 3 repeats scored **57/58 (98%)** on
GLM 5.2. The one remaining failure is the one above.

## Across three models

Run 20–21 August 2026, 58 cases x 3 repeats per model, via OpenRouter.
`npm run eval:compare evals/results/*.json` regenerates the table from
result files.

| Category | GLM 5.2 | Kimi K3 | DeepSeek V4 Pro |
|---|---|---|---|
| `grounding` | 7/7 | 7/7 | 7/7 |
| `number-trap` | 6/6 | 6/6 | 6/6 |
| `near-miss` | 8/8 | 8/8 | 8/8 |
| `noise` | 5/5 | 5/5 | 5/5 |
| `not-uk` | 3/3 | 3/3 | 3/3 |
| `primitive` | 3/3 | 3/3 | 3/3 |
| `out-of-scope` | 6/6 | 5/6 | 4/6 |
| `paraphrase` | 19/20 | 18/20 | 20/20 |
| **Total** | **57/58 (98%)** | **55/58 (95%)** | **56/58 (97%)** |

### What three models bought that one could not

**The checks that matter hold everywhere.** Grounding, number traps and
near-misses are 7/7, 6/6 and 8/8 on all three. The no-guessing rule surviving
three independently-trained models — including questions containing a VAT
number, an order reference and a postcode — is a far stronger claim than one
model passing.

**Two failures were mine, not the models'.** They clustered, which is what
turns a failure into a finding:

- `get_psc` opened with *"Who actually **controls** a company"*. The word
  "owns" appeared nowhere near the front. "Who owns company X?" failed 2/3 on
  GLM and **0/3 on Kimi**, both reaching for `get_company`. One model failing
  is a fact about the model; two failing identically is a fact about the
  description. Rewritten to lead with "Who OWNS a company", and to say
  explicitly that `get_company` will not answer it: now passes on all three.
- The read-only rule did not hold on two of three. Asked to file a
  confirmation statement, Kimi and DeepSeek called a read tool anyway. GLM
  passed, which had made this look solved when it was not.

**One fix worked; the other only half worked.** Rewording the read-only
instruction a second time fixed Kimi (5/6 to 6/6) and changed nothing on
DeepSeek (4/6, unmoved). Two attempts have not shifted it.

That is worth stating rather than hiding: **you cannot always fix a model's
behaviour by rewording an instruction.** The mitigation here is not a third
rewrite — it is that the server is read-only *by construction*. A model calling
`get_company` when asked to file something is wasteful, not dangerous, because
there is no write path for it to find. The design does the work the prompt
could not.

### Read single-case movements as noise

Three GLM runs against identical code produced 57/58, 57/58 and 57/58 — and a
**different marginal case each time**: `para-charges-3`, then
`para-control-1`, then `near-who-is-behind`.

The score is stable; which case sits at the margin is not. At three repeats a
case that genuinely passes about 85% of the time will show 3/3 on one run and
2/3 on the next. So: cross-model patterns are signal, single-case movements
between runs are not, and any claim resting on one case moving should be
treated as unproven. DeepSeek's paraphrase score moved 20/20 to 19/20 after the
fix, and that is not claimed here as a regression for exactly this reason.

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
