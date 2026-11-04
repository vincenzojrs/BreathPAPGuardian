# ECG window benchmark

On 2026-11-04, a two-hour synthetic 130 Hz fixture with two hourly CSV files contained 23,783,848 bytes. On this Mac, building verified block indexes took 1.47 seconds. Reading and checking the blocks overlapping a two-minute window took 0.00044 seconds and 832,648 bytes; the next adjacent window read the same number of bytes in 0.00031 seconds. This measures local Python file/index operations, not page rendering, Proton synchronization, peak RAM, real recordings, or cold-client archive opening. Actual PolarPAP CSV rows and file sizes differ.

Reproduce outside the repository using `python3 tools/generate_ecg_benchmark.py /path/to/new/fixture` followed by `python3 tools/benchmark_ecg_window.py /path/to/new/fixture --window-start-ns 1700001800000000000`. The generator refuses to overwrite existing files. The browser also verifies the returned block hashes and maps byte ranges across blob boundaries; its synthetic browser test exercises those paths independently.
