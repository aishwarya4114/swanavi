"""Live demo orchestration. No Bedrock calls and no remote payment calls."""

from __future__ import annotations

import json
import threading
from http.server import ThreadingHTTPServer

import pytest

from fakes import FakePaymentServer, FakeTransport
from swanavi.config import SwanaviConfig
from swanavi.httpapi import Desk, make_handler
from swanavi.live import LiveBoard, LiveError
from swanavi.payment.client import MastercardClient, UrllibTransport


def _trip(**overrides):
    body = {
        "destination": "Paris",
        "startDate": "2026-11-01",
        "endDate": "2026-11-03",
        "travelers": 2,
        "preferences": "museums",
        "budgetRlusd": "15",
        "hotel": "A hotel",
        "attractions": ["Louvre"],
    }
    body.update(overrides)
    return body


def _snapshot(remaining="15", **health):
    mode = {"mode": "mock", "live": False, "badge": "MOCK"}
    mode.update(health)
    return {
        "configured": True,
        "halted": False,
        "health": dict(mode),
        "budget": {
            **mode,
            "total": "19",
            "remaining": remaining,
            "reserved": "0",
            "spent": "4",
            "killed": False,
            "drift": None,
        },
    }


def _client(server=None):
    server = server or FakePaymentServer()
    client = MastercardClient(
        SwanaviConfig(payment_url="http://127.0.0.1:9", payment_token="test-token"),
        transport=FakeTransport(server, token="test-token"),
    )
    return server, client


def test_create_keeps_the_traveler_destination_and_does_not_start_nova():
    board = LiveBoard()
    with pytest.raises(LiveError) as missing:
        board.create({"startDate": "2026-11-01", "endDate": "2026-11-03", "travelers": 2, "budgetRlusd": "15"})
    assert missing.value.code == "destination_required"

    run = board.create(_trip())
    assert run["destination"] == "Paris"
    assert run["travelers"] == 2
    assert run["budget_rlusd"] == "15"
    assert run["bedrock_invoked"] is False
    assert run["mastercard_mutated"] is False
    steps = [event["step"] for event in run["events"]]
    assert steps[0] == "request_received"
    assert "nova_approval_required" in steps
    assert "master_started" not in steps
    assert "delegated_to_planner" not in steps
    assert "New York" not in json.dumps(run)


def test_nova_evidence_is_required_before_a_delegation_event():
    board = LiveBoard()
    run = board.create(_trip())
    with pytest.raises(LiveError) as missing:
        board.record_nova(run["run_id"], {"confirm": "record-nova-evidence", "modelCalls": 0, "itinerary": "Day one"})
    assert missing.value.code == "no_model_evidence"
    recorded = board.record_nova(run["run_id"], {
        "confirm": "record-nova-evidence",
        "modelCalls": 2,
        "delegatedToPlanner": False,
        "itinerary": "A day in Paris.",
    })
    steps = [event["step"] for event in recorded["events"]]
    assert "master_started" in steps
    assert "planner_itinerary" in steps
    assert "delegated_to_planner" not in steps
    assert recorded["itinerary"] == "A day in Paris."
    assert recorded["destination"] == "Paris"


def test_quote_checks_refuse_before_any_escrow(monkeypatch):
    def boom(*_args, **_kwargs):
        raise AssertionError("network")

    monkeypatch.setattr(UrllibTransport, "_once", boom)
    board = LiveBoard()
    run = board.create(_trip(budgetRlusd="3"))
    with pytest.raises(LiveError) as seller:
        board.prepare_booking(run["run_id"], {"sellerId": "central-park-bikes", "amount": "0.15"}, _snapshot())
    assert seller.value.code == "seller_unsupported"
    status, payload = board.prepare_booking(run["run_id"], {"sellerId": "hotel", "amount": "4"}, _snapshot())
    assert status == 409
    assert payload["error"] == "over_traveler_budget"
    assert payload["mutated"] is False
    assert "mastercard_escrow_requested" not in [event["step"] for event in payload["run"]["events"]]

    live = board.create(_trip())
    status, refused = board.prepare_booking(
        live["run_id"], {"sellerId": "hotel", "amount": "4"}, _snapshot(mode="ap4m", live=True, badge="LIVE"),
    )
    assert status == 409
    assert refused["error"] == "not_mock"
    assert refused["mutated"] is False


def test_approved_mock_escrow_is_created_once_and_admin_routes_stay_closed():
    board = LiveBoard()
    server, client = _client()
    run = board.create(_trip())
    with pytest.raises(LiveError) as unapproved:
        board.approve_booking(run["run_id"], {"sellerId": "hotel", "amount": "4"}, client)
    assert unapproved.value.code == "approval_required"
    assert server.request_log == []

    prepared, gate = board.prepare_booking(run["run_id"], {"sellerId": "hotel", "amount": "4"}, _snapshot())
    assert prepared == 200
    assert gate["mutated"] is False
    status, booked = board.approve_booking(
        run["run_id"],
        {"confirm": "approve-mock-escrow", "sellerId": "hotel", "amount": "4"},
        client,
    )
    assert status == 200
    assert booked["mutated"] is True
    assert booked["run"]["escrow"]["sellerId"] == "hotel"
    assert booked["run"]["escrow"]["badge"] == "MOCK"
    assert booked["run"]["escrow"]["live"] is False
    assert booked["run"]["escrow"]["txHash"] is None
    assert booked["run"]["budget_after"]["reserved"] == "4"
    again, repeat = board.approve_booking(
        run["run_id"],
        {"confirm": "approve-mock-escrow", "sellerId": "hotel", "amount": "4"},
        client,
    )
    assert again == 200
    assert repeat["mutated"] is False
    assert len(server.escrows) == 1
    paths = [item["path"] for item in server.request_log]
    assert paths.count("/escrows") == 1
    assert not any(token in path for path in paths for token in ("/fund", "/kill-switch", "/merchants", "/trip/close"))
    assert "test-token" not in json.dumps(booked)


def test_offline_disruptions_do_not_touch_the_network_or_the_destination(monkeypatch):
    def boom(*_args, **_kwargs):
        raise AssertionError("network")

    monkeypatch.setattr(UrllibTransport, "_once", boom)
    board = LiveBoard()
    run = board.create(_trip())
    rain = board.simulate(run["run_id"], "rain")
    assert rain["destination"] == "Paris"
    assert rain["labels"]["injection"] == "DEMO INJECTION — SIMULATED"
    assert rain["labels"]["recovery"] == "RECOVERY — VERIFIED"
    assert rain["simulations"]["rain"]["verified"] is True
    assert "Mastercard was not called" in rain["events"][-3]["message"] or any(
        "Mastercard was not called" in event["message"] for event in rain["events"]
    )

    over = board.simulate(run["run_id"], "overcharge")
    assert over["destination"] == "Paris"
    assert over["simulations"]["overcharge"]["verified"] is True
    assert over["simulations"]["overcharge"]["escrow_count"] == 1
    assert over["simulations"]["overcharge"]["tx_hash"] is None

    rebook = board.simulate(run["run_id"], "rebook")
    assert rebook["destination"] == "Paris"
    story = rebook["simulations"]["rebook"]
    assert story["verified"] is True
    assert story["refused_status"] == "overcharged"
    assert story["alternative_status"] == "delivered"
    assert story["tx_hash"] is None
    assert story["escrow_count"] == 2
    assert "not an on-chain refund" in rebook["events"][-3]["message"]
    assert "The live Mastercard server was not called." in rebook["events"][-5]["message"]

    timeout = board.simulate(run["run_id"], "timeout")
    assert timeout["simulations"]["timeout"]["verified"] is True
    assert timeout["simulations"]["timeout"]["new_escrows"] == 0
    assert timeout["simulations"]["timeout"]["tx_hash"] is None
    assert timeout["labels"]["bedrock"] == "BEDROCK AI — CLOUD"
    assert timeout["bedrock_invoked"] is False
    assert "master_started" not in [event["step"] for event in timeout["events"]]


def test_sse_replays_only_persisted_events():
    desk = Desk()
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(desk))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        import urllib.request
        port = server.server_address[1]
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/live/runs",
            data=json.dumps(_trip()).encode(),
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            created = json.loads(response.read().decode())
        run_id = created["run"]["run_id"]
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/live/runs/{run_id}/events?once=1", timeout=5) as response:
            raw = response.read().decode()
        assert "request_received" in raw
        assert "master_started" not in raw
        assert "Paris" in raw
        assert "New York" not in raw
    finally:
        server.shutdown()
