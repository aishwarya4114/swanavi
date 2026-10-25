"""Configuration.

Payment server connection is read from environment only — the token is never
hardcoded, never logged, and never written to a file. The ``SWANAVI_PAYMENT_TOKEN``
env var (or the server's own ``SWANAVI_TOKEN``) is the single source of truth.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional


DEFAULT_PAYMENT_URL = "http://127.0.0.1:8787"


@dataclass(frozen=True)
class SwanaviConfig:
    payment_url: str
    payment_token: Optional[str]           # read from env; None means unauthenticated
    request_timeout_seconds: float = 30.0
    # monitoring intervals (seconds)
    pre_travel_interval: int = 1800        # 30 min before travel
    active_travel_interval: int = 300      # 5 min on active travel days
    critical_interval: int = 60            # 1 min during an unresolved critical incident
    # local storage
    sqlite_path: Optional[str] = None      # None => in-memory
    # demo / local run
    demo_mode: bool = True                 # allows scripted weather scenarios

    def authorized(self) -> bool:
        return bool(self.payment_token)


def _token_from_env() -> Optional[str]:
    # Prefer the agent-scoped name; fall back to the server's own var name.
    return os.getenv("SWANAVI_PAYMENT_TOKEN") or os.getenv("SWANAVI_TOKEN")


def load_config(**overrides) -> SwanaviConfig:
    cfg = SwanaviConfig(
        payment_url=os.getenv("SWANAVI_PAYMENT_URL", DEFAULT_PAYMENT_URL),
        payment_token=_token_from_env(),
        pre_travel_interval=int(os.getenv("SWANAVI_PRE_TRAVEL_INTERVAL", "1800")),
        active_travel_interval=int(os.getenv("SWANAVI_ACTIVE_TRAVEL_INTERVAL", "300")),
        critical_interval=int(os.getenv("SWANAVI_CRITICAL_INTERVAL", "60")),
        sqlite_path=os.getenv("SWANAVI_SQLITE_PATH") or None,
        demo_mode=os.getenv("SWANAVI_DEMO_MODE", "1") != "0",
        request_timeout_seconds=float(os.getenv("SWANAVI_HTTP_TIMEOUT", "30")),
    )
    if not overrides:
        return cfg
    # immutable dataclass -> rebuild with overrides
    from dataclasses import replace
    return replace(cfg, **{k: v for k, v in overrides.items() if v is not None})
