# Research notebooks

Companion code for the engineering notes at
[saferide.esheria.org/research](https://saferide.esheria.org/research/).

## `saferide-dataset-checks.ipynb`

This notebook reruns the dataset checks from
[Every prompt was unique. Every test answer leaked.](https://saferide.esheria.org/research/every-prompt-was-unique/)

1. It rebuilds the v0.2 and v0.3 training sets, byte for byte, with their
   generators in this repository:
   - `scripts/saferide-gemma4-generate-synthetic-v02-dataset.mjs`
   - `scripts/saferide-gemma4-generate-synthetic-v03-dataset.mjs`
2. It downloads the released v0.5.8 training set,
   [`esherialabs/saferide-safety-guidance-conversations`](https://huggingface.co/datasets/esherialabs/saferide-safety-guidance-conversations).
3. It checks every download against a pinned SHA-256.
4. It then compares prompts and answers across and within the splits.

The core checks need Python 3.9 or later and Node.js 18 or later, and nothing
else. The optional last section downloads LaBSE (1.9 GB) and needs `numpy`,
`onnxruntime`, `safetensors` and `transformers`.

Every conversation in these datasets is synthetic. Some prompts describe
harassment and gender-based violence, and some are jailbreak attempts. The
notebook prints counts and hashes, never conversation text. Its saved outputs
come from a full run.
