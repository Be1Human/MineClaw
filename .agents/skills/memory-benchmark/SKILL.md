---
name: memory-benchmark
description: Run and evaluate the checked-in MineClaw memory benchmark without relying on external model calls.
---

# Memory Benchmark

Use the repository benchmark and fixtures to validate memory behavior such as facts, places, episodes, retrieval, and persistence.

Run the narrowest benchmark or test suite relevant to the change first. Record the command, fixtures, result counts, and any changed expectation. Keep benchmark reports reproducible from checked-in source and fixtures; do not store personal conversations, live provider responses, or credentials in benchmark artifacts.

When a benchmark fails, classify whether the defect is retrieval, persistence, projection, scoring, or test setup before changing implementation or expected data.
