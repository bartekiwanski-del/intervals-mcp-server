"""Synthetic traces/FIT only: no personal health data or live API calls."""

import asyncio
import base64
import gzip
import hashlib
import struct

import fitdecode  # type: ignore[import-untyped]
import httpx
import pytest

from intervals_mcp_server.api import files
from intervals_mcp_server.tools import heart_rate as tools
from intervals_mcp_server.utils.heart_rate import analyze_heart_rate, fit_heart_rate


def synthetic_fit(values, timestamps=None):
    """A real CRC-valid FIT with record timestamp and heart_rate fields."""
    if timestamps is None:
        timestamps = range(len(values))
    definition = bytes([0x40, 0, 0]) + struct.pack("<HB", 20, 2)
    definition += bytes([253, 4, 0x86, 3, 1, 0x02])
    records = b"".join(
        struct.pack("<BIB", 0, 1_000_000_000 + t, 255 if hr is None else hr)
        for t, hr in zip(timestamps, values, strict=True)
    )
    data = definition + records
    payload = struct.pack("<BBHI4s", 12, 16, 100, len(data), b".FIT") + data
    return payload + struct.pack("<H", fitdecode.utils.compute_crc(payload))


def test_strict_threshold_and_peak_in_middle():
    hr = [120] * 12 + [185, 201, 200, 180] + [130] * 12
    report = analyze_heart_rate(list(range(len(hr))), hr)
    assert report["raw_max_bpm"] == 201
    assert report["raw_peak_at_seconds"] == 13
    assert report["samples_above_threshold"] == 2
    assert report["seconds_above_threshold"] == 2
    assert report["episodes"][0]["start_seconds"] == 13
    assert report["episodes"][0]["end_seconds"] == 15


def test_irregular_sampling_uses_time_not_sample_count():
    report = analyze_heart_rate([0, 3, 8, 10], [185, 200, 199, 180])
    assert report["samples_above_threshold"] == 2
    assert report["seconds_above_threshold"] == 7


def test_missing_values_and_gaps_split_episodes():
    report = analyze_heart_rate([0, 1, 2, 3, 50, 51], [200, None, 201, 202, 203, 170])
    assert report["seconds_above_threshold"] == 2
    assert report["episode_count"] == 3
    assert report["gap_count"] == 1
    assert report["uncovered_duration_seconds"] == 49


def test_last_single_sample_peak_has_unknown_duration():
    report = analyze_heart_rate([0, 1], [160, 220])
    assert report["raw_max_bpm"] == 220
    assert report["samples_above_threshold"] == 1
    assert report["seconds_above_threshold"] == 0
    assert report["episode_count"] == 1


def test_episodes_are_paginated_but_global_peak_is_not():
    report = analyze_heart_rate([0, 1, 2, 3], [190, 170, 210, 160], episode_limit=1)
    assert report["episode_count"] == 2
    assert report["raw_max_bpm"] == 210
    assert report["next_episode_offset"] == 1
    second = analyze_heart_rate([0, 1, 2, 3], [190, 170, 210, 160], episode_offset=1)
    assert second["episodes"][0]["peak_bpm"] == 210


@pytest.mark.parametrize("values", [[], [None, 0, float("nan"), float("inf"), True]])
def test_no_hr_is_not_zero_peaks(values):
    report = analyze_heart_rate(list(range(len(values))), values)
    assert report["status"] == "no_hr_data"
    assert report["raw_max_bpm"] is None
    assert report["seconds_above_threshold"] is None


@pytest.mark.parametrize(
    "times,hr", [([0], [150, 200]), ([1, 0], [190, 200]), ([0, None], [190, 200])]
)
def test_reject_misaligned_or_invalid_time(times, hr):
    with pytest.raises(ValueError):
        analyze_heart_rate(times, hr)


@pytest.mark.parametrize("threshold", [0, -1, float("nan"), float("inf")])
def test_reject_invalid_threshold(threshold):
    with pytest.raises(ValueError):
        analyze_heart_rate([], [], threshold)


def test_parse_real_fit_records_and_preserve_nulls():
    payload = synthetic_fit([150, 220, None, 170], [0, 2, 5, 8])
    times, hr, origin = fit_heart_rate(payload)
    assert times == [0, 2, 5, 8]
    assert hr == [150, 220, None, 170]
    assert origin is not None
    assert analyze_heart_rate(times, hr)["raw_max_bpm"] == 220


def test_reject_corrupt_fit():
    payload = synthetic_fit([150, 200])
    with pytest.raises(fitdecode.FitError):
        fit_heart_rate(payload[:-2] + b"\xff\xff")


@pytest.mark.parametrize("compressed", [False, True])
def test_unpack_original_fit(compressed):
    payload = synthetic_fit([150, 200])
    assert files.unpack_fit(gzip.compress(payload) if compressed else payload) == payload


def test_reject_non_fit_and_decompression_limit(monkeypatch):
    with pytest.raises(ValueError, match="not FIT"):
        files.unpack_fit(b"<TrainingCenterDatabase/>")
    monkeypatch.setattr(files, "MAX_FILE_BYTES", 100)
    with pytest.raises(ValueError, match="Decompressed"):
        files.unpack_fit(gzip.compress(b"x" * 1000))


@pytest.mark.parametrize(
    "activity_id", ["../file", "https://example.com", "i1/fit-file", "i1?secret=x"]
)
def test_reject_activity_paths(activity_id):
    result = asyncio.run(tools.download_activity_fit(activity_id))
    assert result["error"]


def test_binary_http_original_endpoint_and_gzip(monkeypatch):
    payload = synthetic_fit([150, 220])

    def handler(request):
        assert request.url.path == "/api/v1/activity/i123/file"
        assert request.headers["accept"] == "application/octet-stream"
        return httpx.Response(200, content=gzip.compress(payload))

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:

            async def get_client():
                return client

            monkeypatch.setattr(files, "_get_httpx_client", get_client)
            return await files.fetch_original_fit("i123", "dummy-test-key")

    assert asyncio.run(run()) == payload


@pytest.mark.parametrize("status", [302, 401, 403, 404, 422, 429, 500])
def test_binary_http_failures_are_explicit(monkeypatch, status):
    async def run():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(status, text="private upstream body")
            )
        ) as client:

            async def get_client():
                return client

            monkeypatch.setattr(files, "_get_httpx_client", get_client)
            return await files.fetch_original_fit("i123", "dummy-test-key")

    result = asyncio.run(run())
    assert result["error"] is True
    assert result["status_code"] == status
    assert "private upstream body" not in str(result)


def test_download_chunks_reassemble_and_detect_changes(monkeypatch):
    payload = synthetic_fit([150, 220, 160])

    async def fetch(*args, **kwargs):
        return payload

    monkeypatch.setattr(tools, "fetch_original_fit", fetch)

    async def run():
        chunks, offset, digest = [], 0, None
        while offset is not None:
            page = await tools.download_activity_fit(
                "i123", offset=offset, chunk_size=7, expected_sha256=digest
            )
            digest = page["sha256"]
            chunks.append(base64.b64decode(page["data_base64"]))
            offset = page["next_offset"]
        assert b"".join(chunks) == payload
        assert digest == hashlib.sha256(payload).hexdigest()
        bad = await tools.download_activity_fit("i123", expected_sha256="changed")
        assert bad["error"]

    asyncio.run(run())


def test_original_fit_analysis_finds_corrected_peak(monkeypatch):
    async def fetch(*args, **kwargs):
        return synthetic_fit([150, 225, 180])

    monkeypatch.setattr(tools, "fetch_original_fit", fetch)
    report = asyncio.run(tools.analyze_activity_heart_rate("i123"))
    assert report["source"] == "original_fit"
    assert report["raw_max_bpm"] == 225
    assert report["time_origin"] == "first_fit_record"


def test_full_stream_pagination_and_raw_analysis(monkeypatch):
    async def request(url, **kwargs):
        assert url.endswith("/streams.json")
        return [
            {"type": "time", "data": [0, 1, 2, 3]},
            {"type": "heartrate", "data": [150, None, 220, 170]},
        ]

    monkeypatch.setattr(tools, "make_intervals_request", request)
    first = asyncio.run(tools.get_activity_stream_data("i123", limit=2))
    second = asyncio.run(
        tools.get_activity_stream_data("i123", offset=first["next_offset"], limit=2)
    )
    assert first["streams"]["heartrate"] + second["streams"]["heartrate"] == [150, None, 220, 170]
    assert second["next_offset"] is None
    report = asyncio.run(tools.analyze_activity_heart_rate("i123", source="streams"))
    assert report["raw_max_bpm"] == 220


def test_scan_checks_low_summary_max_and_preserves_unavailable(monkeypatch):
    inventory = [
        {
            "id": "i1",
            "type": "Run",
            "start_date_local": "2026-04-11T10:00:00",
            "max_heartrate": 182,
        },
        {"id": "i2", "type": "Ride", "start_date_local": "2026-04-12T10:00:00"},
        {"id": "i3", "type": "Swim", "start_date_local": "2026-04-13T10:00:00"},
        {"id": "123456789"},
    ]

    async def request(*args, **kwargs):
        return inventory

    async def fetch(activity_id, *args, **kwargs):
        return (
            synthetic_fit([170, 220 if activity_id == "i1" else None, 170])
            if activity_id == "i1"
            else synthetic_fit([None])
        )

    monkeypatch.setattr(tools, "make_intervals_request", request)
    monkeypatch.setattr(tools, "fetch_original_fit", fetch)

    async def run():
        first = await tools.find_heart_rate_peaks(
            "2026-01-01", "2026-09-09", athlete_id="i1", limit=2
        )
        assert first["matches"][0]["analysis"]["raw_max_bpm"] == 220
        assert first["matches"][0]["reported_max_bpm"] == 182
        assert len(first["unavailable"]) == 1
        second = await tools.find_heart_rate_peaks(
            "2026-01-01",
            "2026-09-09",
            athlete_id="i1",
            offset=first["next_offset"],
            inventory_sha256=first["inventory_sha256"],
        )
        assert second["other_sports_count"] == 1
        assert second["unavailable"][0]["id"] == "123456789"
        assert second["next_offset"] is None
        inventory.append({"id": "another"})
        changed = await tools.find_heart_rate_peaks(
            "2026-01-01",
            "2026-09-09",
            athlete_id="i1",
            offset=2,
            inventory_sha256=first["inventory_sha256"],
        )
        assert changed["error"]

    asyncio.run(run())


def test_new_tools_registered_with_mcp():
    from intervals_mcp_server.server import mcp

    names = {x.name for x in asyncio.run(mcp.list_tools())}
    assert {
        "get_activity_stream_data",
        "download_activity_fit",
        "analyze_activity_heart_rate",
        "find_heart_rate_peaks",
    } <= names
