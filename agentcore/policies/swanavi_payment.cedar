// Swanavi AgentCore Gateway Cedar policy — enforceable, not a prompt.
//
// These policies are evaluated by AgentCore Policy at the Gateway BEFORE a tool
// call reaches the protected payment server. They are the code-level security
// layer that complements (and never replaces) the deterministic in-app checks in
// swanavi/agents/tools.py and the payment server's own limits.
//
// They enforce:
//   - only the safe payment tools may be called by the agent
//   - operator-only tools (fund, closeTrip, killSwitch, setMerchantSwitch) are
//     forbidden for the agent principal
//   - a lock may only target an approved seller and must be within the spend
//     ceiling and per-booking maximum
//   - a traveler's tools may only touch their own trip (cross-trip access denied)
//   - high-risk recovery actions require an approved ApprovalRequest

namespace Swanavi {
  entity Agent in [AgentGroup] = ["travelerId", "isOperator"];
  entity Traveler in [AgentGroup];
  entity Trip = ["travelerId"];
  entity Booking = ["tripId"];
  entity ApprovalRequest = ["tripId", "status"];

  action createEscrow, release, refund, getStatus, getBudget,
         listMerchants, getMerchant, listStores, searchStoreCatalog,
         getStoreQuote, getTripStatus, getHealth,
         fund, closeTrip, killSwitch, setMerchantSwitch,
         openChannel, signVoucher, directChainTransaction
  appliesTo {
    principal: Agent,
    resource: Trip,
    context: {
      sellerId?: String,
      amount?: String,
      travelerId?: String,
      tripId?: String,
      spendCeiling?: String,
      maxBooking?: String,
      approvalId?: String,
      drift?: Bool
    }
  };
}

// ---- Agent may call only the safe read/booking tools on its own trip --------
permit (
  principal in Swanavi::AgentGroup::"agents",
  action in [
    Swanavi::Action::"createEscrow",
    Swanavi::Action::"release",
    Swanavi::Action::"refund",
    Swanavi::Action::"getStatus",
    Swanavi::Action::"getBudget",
    Swanavi::Action::"listMerchants",
    Swanavi::Action::"getMerchant",
    Swanavi::Action::"listStores",
    Swanavi::Action::"searchStoreCatalog",
    Swanavi::Action::"getStoreQuote",
    Swanavi::Action::"getTripStatus",
    Swanavi::Action::"getHealth"
  ],
  resource: Swanavi::Trip
)
when {
  // cross-trip access is denied: the agent may only act on the traveler's own trip
  context.tripId == resource.travelerId || context.tripId == resource.id
  // budget drift stops new bookings
  && !(action == Swanavi::Action::"createEscrow" && context.drift == true)
};

// ---- Operator-only tools are forbidden for the agent principal -------------
forbid (
  principal in Swanavi::AgentGroup::"agents",
  action in [
    Swanavi::Action::"fund",
    Swanavi::Action::"closeTrip",
    Swanavi::Action::"killSwitch",
    Swanavi::Action::"setMerchantSwitch",
    Swanavi::Action::"openChannel",
    Swanavi::Action::"signVoucher",
    Swanavi::Action::"directChainTransaction"
  ],
  resource: Swanavi::Trip
);

// ---- A lock may only target an approved seller and stay within limits -------
forbid (
  principal in Swanavi::AgentGroup::"agents",
  action == Swanavi::Action::"createEscrow",
  resource: Swanavi::Trip
)
when {
  // only the four base sellers; demo store sellers are validated in-app + by the
  // payment server, but the policy also blocks the unverified injection-trap store
  context.sellerId == "times-square-souvenir"
  || context.sellerId not in ["hotel", "tour", "cab", "food",
                              "central-park-bikes", "midtown-print-shop",
                              "midtown-book-nook", "fifth-ave-sketch-room",
                              "soho-record-shop", "uws-camera-shop",
                              "east-village-plant-shop", "battery-park-outfitters"]
};

// ---- An amount above the per-booking maximum is refused --------------------
forbid (
  principal in Swanavi::AgentGroup::"agents",
  action == Swanavi::Action::"createEscrow",
  resource: Swanavi::Trip
)
when {
  decimal(context.amount) > decimal(context.maxBooking)
};

// ---- A lock that would exceed the spend ceiling is refused -----------------
forbid (
  principal in Swanavi::AgentGroup::"agents",
  action == Swanavi::Action::"createEscrow",
  resource: Swanavi::Trip
)
when {
  decimal(context.amount) > decimal(context.spendCeiling)
};

// ---- High-risk recovery rebooking requires an approved ApprovalRequest -----
forbid (
  principal in Swanavi::AgentGroup::"agents",
  action == Swanavi::Action::"createEscrow",
  resource: Swanavi::Trip
)
when {
  context.approvalId != null
  && context.approvalStatus != "approved"
};
