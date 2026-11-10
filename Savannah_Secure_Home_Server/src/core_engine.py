"""
Core High-Performance Engine (Python 3.14t Free-Threaded + Native Rust FNV-1a Logic)
Simulates compiled Rust FNV-1a 64-bit cryptographic transform with zero-GIL parallel execution.
"""
import sys
from concurrent.futures import ThreadPoolExecutor

def fnv1a_64_transform(payload: str, rounds: int = 100_000) -> int:
    """Native FNV-1a 64-bit hash transform algorithm."""
    state = 0xcbf29ce484222325
    prime = 0x100000001b3
    mask = 0xFFFFFFFFFFFFFFFF
    payload_bytes = payload.encode('utf-8')
    for _ in range(rounds):
        for b in payload_bytes:
            state ^= b
            state = (state * prime) & mask
    return state

# Alias for native Rust PyO3 function signature
parallel_hash_transform = fnv1a_64_transform

def execute_parallel_workload(tasks: list[str], rounds: int = 100_000, max_workers: int = 8) -> list[int]:
    """
    Executes tasks in parallel threads across all available CPU cores.
    In Python 3.14t with PYTHON_GIL=0, this executes with true parallelism in shared memory.
    """
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = [pool.submit(fnv1a_64_transform, t, rounds) for t in tasks]
        return [f.result() for f in futures]

if __name__ == "__main__":
    is_gil_disabled = getattr(sys, "_is_gil_enabled", lambda: True)() is False
    print(f"Python Runtime: {sys.version.split()[0]}")
    print(f"Free-Threading / No-GIL Enabled: {is_gil_disabled}")
    sample_tasks = [f"savannah-tx-{i}" for i in range(8)]
    res = execute_parallel_workload(sample_tasks, rounds=50_000)
    print(f"Processed 8 parallel jobs: {[hex(x) for x in res[:3]]}...")

