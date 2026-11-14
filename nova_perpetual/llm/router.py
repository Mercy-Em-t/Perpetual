"""
Model router: cheap model for easy traffic, large model only for hard turns,
and a zero-token fast path for high-volume lookups (the Monday-morning
"where is my parcel" spike).
"""

import re
from dataclasses import dataclass
from typing import Optional

from nova_perpetual.llm.providers import ORDER_ID_RE

HARD_SIGNALS = re.compile(
    r"\b(why|compare|analy[sz]e|explain|investigate|dispute|complain|legal|escalat|refund|policy|exception)\w*",
    re.IGNORECASE)
STATUS_SIGNALS = re.compile(r"\b(where|status|track|tracking)\b", re.IGNORECASE)


@dataclass
class Route:
    tier: str  # fast_path | small | large
    model: Optional[str]
    reason: str
    fast_tool: Optional[str] = None
    fast_args: Optional[dict] = None


class ModelRouter:
    def __init__(self, small_model: str, large_model: str):
        self.small_model = small_model
        self.large_model = large_model

    def route(self, text: str, has_untrusted: bool = False) -> Route:
        words = len(text.split())
        order_ids = ORDER_ID_RE.findall(text)

        if not has_untrusted and len(order_ids) == 1 and STATUS_SIGNALS.search(text) \
                and words <= 20 and not HARD_SIGNALS.search(text):
            return Route("fast_path", None, "single order status lookup",
                         fast_tool="get_order_status", fast_args={"order_id": order_ids[0].upper()})
        if has_untrusted:
            return Route("large", self.large_model, "untrusted content requires the strongest model")
        if words > 60 or len(HARD_SIGNALS.findall(text)) >= 1 or text.count("?") > 1:
            return Route("large", self.large_model, "complex or policy-sensitive request")
        return Route("small", self.small_model, "simple request")
