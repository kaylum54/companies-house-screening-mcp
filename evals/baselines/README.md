# Evaluation evidence

The historical JSON files were copied from the existing local final result files and reduced to provider/model, repeat count, summaries and per-case checks. No environment or provider credentials are included. The accompanying narrative dates these runs to 20–21 August 2026, but the original JSON has no timestamp or commit: both remain unknown in the preserved evidence. Do not present these scores as verification of the current source.

New runs record timestamps, commit, dirty state, source fingerprint and a reproducible command. A fingerprint identifies the evaluated source but does not archive it; preserve the matching checkout or commit when publishing a new result. A failed or flaky result is useful evidence and must not be relabelled a pass.

## Review verification

[review-verification.json](review-verification.json) records 58 cases × 3 repeats against GLM 5.2: 54 cases passed all repeats; four were flaky. Grounding passed 7/7. The run exited nonzero, as intended for flaky results. The exact timestamps, commit, dirty state, source fingerprint and command are in the JSON. After the run, only diagnostic prose in evals/run.ts was changed to stop claiming flakiness proves overlapping descriptions; evaluated tool schemas, server instructions and scoring were unchanged. This result does not establish end-to-end report accuracy or guarantee grounded company numbers.
