"""Shared pytest fixtures.

Everything runs offline: an in-process FakePaymentServer stands in for the
protected Node payment server, and an in-memory SwanaviStore stands in for
DynamoDB. No network, no keys, no LLM.
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone

import pytest

# ensure the agent package is importable when running pytest from app/agent
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from swanavi.config import SwanaviConfig
from swanavi.domain.enums import ActivityType
from swanavi.domain.models import Activity, Itinerary, new_id, Trip, Traveler
from swanavi.payment.client import MastercardClient
from swanavi.storage.store import SwanaviStore

from fakes import FakePaymentServer, FakeTransport


@pytest.fixture
def fake_server():
    return FakePaymentServer()


@pytest.fixture
def transport(fake_server):
    return FakeTransport(fake_server, token="test-token")


@pytest.fixture
def config():
    return SwanaviConfig(
        payment_url="http://127.0.0.1:8787", payment_token="test-token",
        sqlite_path=None, demo_mode=True,
    )


@pytest.fixture
def client(config, transport):
    return MastercardClient(config, transport=transport)


@pytest.fixture
def store():
    s = SwanaviStore()
    yield s
    s.close()


@pytest.fixture
def trip(store):
    """A trip with one outdoor bookable activity (central-park-bikes)."""
    traveler = Traveler(traveler_id="tv_1", name="Ada")
    store.save("traveler", traveler)
    t = Trip(trip_id="trip_1", traveler_id=traveler.traveler_id,
             title="NYC weekend", destination="New York",
             budget_rlusd="19", status="planning")
    store.save("trip", t)
    itin = Itinerary(itinerary_id=new_id("itin"), trip_id=t.trip_id, version=1)
    activity = Activity(
        activity_id=new_id("act"), trip_id=t.trip_id,
        title="Central Park bike rental", activity_type=ActivityType.OUTDOOR_TOUR,
        seller_id="central-park-bikes", store_id="central-park-bikes",
        sku="BIKE-2H", amount="0.15", indoor=False, refundable=True,
        lat=40.7829, lng=-73.9654, verified=True,
        start_at=datetime.now(timezone.utc) + timedelta(days=1, hours=2),
        end_at=datetime.now(timezone.utc) + timedelta(days=1, hours=4),
    )
    store.save("activity", activity)
    itin.activities = [activity]
    store.save("itinerary", itin)
    t.current_itinerary_id = itin.itinerary_id
    store.save("trip", t)
    return t, activity


@pytest.fixture
def booker(client, store, trip):
    from swanavi.booking import Booker
    t, _ = trip
    return Booker(client, store, t.trip_id)
