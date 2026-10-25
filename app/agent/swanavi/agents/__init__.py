"""Agent layer: tools, permission boundaries, and the four agents."""

from .boundaries import can_agent_act, check_authorization_scope
from .tools import (
    AGENT_FORBIDDEN_TOOLS, AGENT_SAFE_TOOLS, PermissionDenied,
    ToolContext, assert_seller_supported, assert_tool_allowed, build_tools,
)

__all__ = [
    "AGENT_SAFE_TOOLS", "AGENT_FORBIDDEN_TOOLS", "PermissionDenied",
    "ToolContext", "build_tools", "assert_tool_allowed", "assert_seller_supported",
    "can_agent_act", "check_authorization_scope",
]
