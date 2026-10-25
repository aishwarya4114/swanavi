"""Swanavi deterministic core.

Pure-Python domain, storage, payment client, booker, monitoring and recovery.
No LLM dependency here — safety invariants live in code, not prompts. The agent
layer (``swanavi.agents``) wraps this core with Strands tools.
"""

__version__ = "0.1.0"
