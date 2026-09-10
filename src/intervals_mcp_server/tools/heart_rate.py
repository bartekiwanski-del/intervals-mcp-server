"""Read-only tools for original FIT transfer and complete heart-rate analysis."""

import asyncio
import base64
import hashlib
from datetime import date
from typing import Any, Literal

import fitdecode  # type: ignore[import-untyped]
from mcp.types import ToolAnnotations

from intervals_mcp_server.api.client import make_intervals_request
from intervals_mcp_server.api.files import fetch_original_fit, validate_activity_id
from intervals_mcp_server.config import get_config
from intervals_mcp_server.mcp_instance import mcp
from intervals_mcp_server.utils.heart_rate import analyze_heart_rate, fit_heart_rate, number
from intervals_mcp_server.utils.validation import resolve_athlete_id

RUN_RIDE_TYPES = {
    "Run",
    "TrailRun",
    "VirtualRun",
    "Ride",
    "VirtualRide",
    "MountainBikeRide",
    "GravelRide",
    "EBikeRide",
    "EMountainBikeRide",
    "Handcycle",
    "Velomobile",
}
Source = Literal["original_fit", "streams"]
READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True)


def _error(message: str) -> dict[str, Any]:
    return {"error": True, "message": message}


async def _streams(activity_id: str, api_key: str | None, types: str) -> dict[str, Any]:
    result = await make_intervals_request(
        f"/activity/{activity_id}/streams.json", api_key=api_key, params={"types": types}
    )
    if isinstance(result, dict) and result.get("error"):
        return result
    if not isinstance(result, list):
        return _error("No accessible streams. This is not evidence of no HR peaks.")
    streams = {
        x["type"]: x["data"]
        for x in result
        if isinstance(x, dict) and isinstance(x.get("data"), list) and x.get("type")
    }
    if not streams:
        return _error("No accessible streams. Check activity source/API access.")
    return {"streams": streams}


@mcp.tool(annotations=READ_ONLY)
async def get_activity_stream_data(
    activity_id: str,
    api_key: str | None = None,
    stream_types: str = "time,heartrate",
    offset: int = 0,
    limit: int = 2000,
) -> dict[str, Any]:
    """Return actual stream samples as paginated arrays, preserving nulls and alignment.

    Follow next_offset until null to obtain the full trace. 'heartrate' is the raw
    API stream, not the corrected summary maximum. It may reflect user stream edits;
    use analyze_activity_heart_rate(source='original_fit') for the original device file.
    Offset/limit refer to sample indices, not seconds. Time is always included.
    """
    try:
        validate_activity_id(activity_id)
        if offset < 0 or not 1 <= limit <= 10000:
            raise ValueError("offset must be >= 0 and limit must be 1..10000.")
        types = list(
            dict.fromkeys(["time"] + [x.strip() for x in stream_types.split(",") if x.strip()])
        )
        if len(types) > 12 or any(not x.replace("_", "").isalnum() for x in types):
            raise ValueError("Request at most 12 valid stream names.")
        result = await _streams(activity_id, api_key, ",".join(types))
        if result.get("error"):
            return result
        streams = result["streams"]
        if "time" not in streams or any(len(v) != len(streams["time"]) for v in streams.values()):
            raise ValueError("Missing time stream or unequal stream lengths; cannot align samples.")
        total = len(streams["time"])
        if offset > total:
            raise ValueError("offset is beyond the end of the streams.")
        end = min(offset + limit, total)
        return {
            "activity_id": activity_id,
            "source": "api_streams",
            "offset": offset,
            "total_samples": total,
            "returned_samples": end - offset,
            "next_offset": end if end < total else None,
            "missing_streams": [x for x in types if x not in streams],
            "streams": {k: v[offset:end] for k, v in streams.items()},
        }
    except ValueError as exc:
        return _error(str(exc))


@mcp.tool(annotations=READ_ONLY)
async def download_activity_fit(
    activity_id: str,
    api_key: str | None = None,
    offset: int = 0,
    chunk_size: int = 32768,
    expected_sha256: str | None = None,
) -> dict[str, Any]:
    """Download the ORIGINAL FIT as base64 chunks; never returns a remote server path.

    Decode each chunk separately and concatenate in offset order. Follow next_offset
    until null. Pass the first page's sha256 as expected_sha256 on subsequent calls,
    then verify the assembled bytes against sha256. The endpoint is /file, never
    /fit-file (which generates an edited file). Gzip is removed, preserving original
    FIT bytes. No public URL, credential, or persistent server copy is created.
    """
    try:
        validate_activity_id(activity_id)
        if offset < 0 or not 1 <= chunk_size <= 65536:
            raise ValueError("offset must be >= 0 and chunk_size must be 1..65536.")
        payload = await fetch_original_fit(activity_id, api_key)
        if isinstance(payload, dict):
            return payload
        digest = hashlib.sha256(payload).hexdigest()
        if expected_sha256 is not None and expected_sha256 != digest:
            raise ValueError("Original file changed between chunks; restart at offset 0.")
        if offset > len(payload):
            raise ValueError("offset is beyond the end of the file.")
        end = min(offset + chunk_size, len(payload))
        return {
            "activity_id": activity_id,
            "filename": f"{activity_id}-original.fit",
            "source": "original_fit",
            "mime_type": "application/vnd.ant.fit",
            "encoding": "base64",
            "sha256": digest,
            "total_bytes": len(payload),
            "offset": offset,
            "returned_bytes": end - offset,
            "next_offset": end if end < len(payload) else None,
            "data_base64": base64.b64encode(payload[offset:end]).decode("ascii"),
        }
    except ValueError as exc:
        return _error(str(exc))


@mcp.tool(annotations=READ_ONLY)
async def analyze_activity_heart_rate(
    activity_id: str,
    api_key: str | None = None,
    threshold: float = 185,
    source: Source = "original_fit",
    max_gap_seconds: float = 10,
    episode_offset: int = 0,
    episode_limit: int = 100,
) -> dict[str, Any]:
    """Analyze ALL HR samples: raw peak, when it occurred, time > threshold and episodes.

    Defaults to the original device FIT to detect peaks removed by Intervals.icu.
    Alternative source='streams' analyzes the full raw heartrate API stream.
    Strictly > threshold, never >=. Single-sample peaks are retained. Duration is
    estimated from timestamps, excluding missing data and gaps > max_gap_seconds.
    Episode pagination affects only the returned list; global metrics always use
    the full trace. API failures/no HR are explicitly reported, never treated as 0 peaks.
    """
    try:
        validate_activity_id(activity_id)
        # Validate parameters before any API calls, including empty/no-HR traces.
        analyze_heart_rate([], [], threshold, max_gap_seconds, episode_offset, episode_limit)
        first_record = None
        if source == "original_fit":
            payload = await fetch_original_fit(activity_id, api_key)
            if isinstance(payload, dict):
                return {"activity_id": activity_id, "source": source, **payload}
            times, hr, first_record = await asyncio.to_thread(fit_heart_rate, payload)
            time_origin = "first_fit_record"
        elif source == "streams":
            result = await _streams(activity_id, api_key, "time,heartrate")
            if result.get("error"):
                return {"activity_id": activity_id, "source": source, **result}
            values = result["streams"]
            if "time" not in values:
                raise ValueError("Missing time stream; cannot time HR peaks.")
            times = values["time"]
            hr = values.get("heartrate", [None] * len(times))
            time_origin = "api_time_stream"
        else:
            raise ValueError("source must be original_fit or streams.")
        analysis = analyze_heart_rate(
            times, hr, threshold, max_gap_seconds, episode_offset, episode_limit
        )
        return {
            "activity_id": activity_id,
            "url": f"https://intervals.icu/activities/{activity_id}",
            "source": source,
            "time_origin": time_origin,
            "first_record_timestamp": first_record,
            **analysis,
        }
    except (ValueError, fitdecode.FitError) as exc:
        return {"activity_id": activity_id, "source": source, **_error(str(exc))}


@mcp.tool(annotations=READ_ONLY)
async def find_heart_rate_peaks(
    start_date: str,
    end_date: str,
    athlete_id: str | None = None,
    api_key: str | None = None,
    threshold: float = 185,
    source: Source = "original_fit",
    offset: int = 0,
    limit: int = 10,
    inventory_sha256: str | None = None,
) -> dict[str, Any]:
    """Scan ALL runs/rides in a date range for raw HR > threshold, in resumable pages.

    Never prefilter by corrected max HR: it can hide spikes. Follow next_offset and
    pass inventory_sha256 on subsequent pages; accumulate matches and unavailable.
    Counts describe this page; inventory totals cover the requested date range.
    Undated/ID-only records are listed as unavailable, never silently dropped.
    Dates are local YYYY-MM-DD inclusive, at most 366 days. At most two file reads
    run concurrently. Use source='streams' explicitly for non-FIT originals.
    """
    try:
        start, end = date.fromisoformat(start_date), date.fromisoformat(end_date)
        if start > end or (end - start).days > 365:
            raise ValueError("Use an ordered date range of at most 366 days.")
        if offset < 0 or not 1 <= limit <= 20:
            raise ValueError("offset must be >= 0 and limit must be 1..20.")
        if source not in {"original_fit", "streams"}:
            raise ValueError("source must be original_fit or streams.")
        analyze_heart_rate([], [], threshold)
        athlete, error = resolve_athlete_id(athlete_id, get_config().athlete_id)
        if error:
            return _error(error)
        result = await make_intervals_request(
            f"/athlete/{athlete}/activities",
            api_key=api_key,
            params={"oldest": start.isoformat(), "newest": end.isoformat()},
        )
        if isinstance(result, dict) and result.get("error"):
            return result
        if not isinstance(result, list) or any(
            not isinstance(x, dict) or not x.get("id") for x in result
        ):
            raise ValueError("Unrecognized activity inventory; completeness cannot be established.")
        inventory = sorted(result, key=lambda x: (x.get("start_date_local") or "~", str(x["id"])))
        digest = hashlib.sha256("\n".join(str(x["id"]) for x in inventory).encode()).hexdigest()
        if inventory_sha256 is not None and inventory_sha256 != digest:
            raise ValueError("Activity inventory changed between pages; restart at offset 0.")
        if offset > len(inventory):
            raise ValueError("offset is beyond the activity inventory.")
        page = inventory[offset : offset + limit]
        semaphore = asyncio.Semaphore(2)

        async def scan(activity: dict[str, Any]) -> dict[str, Any]:
            info = {
                k: activity.get(k) for k in ("id", "name", "type", "start_date_local", "distance")
            }
            if not activity.get("type") or not activity.get("start_date_local"):
                return {
                    **info,
                    "scan_status": "unavailable",
                    "reason": "Missing activity metadata; possible Strava API restriction. Sport/date cannot be verified.",
                }
            if activity["type"] not in RUN_RIDE_TYPES:
                return {**info, "scan_status": "other_sport"}
            local_date = str(activity["start_date_local"])[:10]
            if not start.isoformat() <= local_date <= end.isoformat():
                return {
                    **info,
                    "scan_status": "unavailable",
                    "reason": "API returned an activity outside the requested date range.",
                }
            async with semaphore:
                report = await analyze_activity_heart_rate(
                    str(activity["id"]), api_key, threshold, source, episode_limit=1
                )
            if report.get("error") or report.get("status") != "ok":
                return {**info, "scan_status": "unavailable", "details": report}
            peak = number(report.get("raw_max_bpm"))
            return {
                **info,
                "scan_status": "match"
                if peak is not None and peak > threshold
                else "below_threshold",
                "reported_max_bpm": activity.get("max_heartrate"),
                "analysis": report,
            }

        rows = await asyncio.gather(*(scan(x) for x in page))
        next_offset = offset + len(page)
        unavailable = [x for x in rows if x["scan_status"] == "unavailable"]
        return {
            "start_date": start.isoformat(),
            "end_date": end.isoformat(),
            "source": source,
            "threshold_bpm": threshold,
            "comparison": ">",
            "inventory_count": len(inventory),
            "inventory_sha256": digest,
            "offset": offset,
            "page_count": len(rows),
            "next_offset": next_offset if next_offset < len(inventory) else None,
            "analyzed_count": sum(x["scan_status"] in {"match", "below_threshold"} for x in rows),
            "other_sports_count": sum(x["scan_status"] == "other_sport" for x in rows),
            "matches": [x for x in rows if x["scan_status"] == "match"],
            "unavailable": unavailable,
            "coverage_note": "Process all pages and report unavailable records. No match means no recorded sample > threshold only in successfully analyzed traces.",
        }
    except ValueError as exc:
        return _error(str(exc))
