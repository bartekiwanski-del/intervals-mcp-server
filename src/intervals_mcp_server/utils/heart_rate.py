"""Unclipped heart-rate analysis. No diagnosis or automatic spike removal."""

import io
import math
from datetime import datetime
from typing import Any

import fitdecode  # type: ignore[import-untyped]


def number(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return float(value)
    return None


def fit_heart_rate(payload: bytes) -> tuple[list[float], list[Any], str | None]:
    """Keep record timestamps and missing HR; never substitute session summaries."""
    times: list[float] = []
    heart_rates: list[Any] = []
    first: datetime | None = None
    with fitdecode.FitReader(io.BytesIO(payload), check_crc=fitdecode.CrcCheck.RAISE) as reader:
        for frame in reader:
            if not isinstance(frame, fitdecode.FitDataMessage) or frame.name != "record":
                continue
            timestamp = frame.get_value("timestamp", fallback=None)
            if not isinstance(timestamp, datetime):
                raise ValueError("FIT contains a record without a timestamp; timing is incomplete.")
            if first is None:
                first = timestamp
            times.append((timestamp - first).total_seconds())
            heart_rates.append(frame.get_value("heart_rate", fallback=None))
            if len(times) > 500_000:
                raise ValueError("FIT exceeds the 500000 record analysis limit.")
    return times, heart_rates, first.isoformat() if first else None


def analyze_heart_rate(
    times: list[Any],
    heart_rates: list[Any],
    threshold: float = 185,
    max_gap_seconds: float = 10,
    episode_offset: int = 0,
    episode_limit: int = 100,
) -> dict[str, Any]:
    """Use strict > threshold and time-weighted, left-held samples.

    Count duration only between adjacent valid HR samples separated by <= max_gap_seconds.
    Gaps/invalid values split episodes. Never extrapolate beyond the last timestamp.
    Single-sample peaks remain included even when their duration cannot be estimated.
    """
    if number(threshold) is None or threshold <= 0:
        raise ValueError("threshold must be finite and positive.")
    if number(max_gap_seconds) is None or max_gap_seconds <= 0:
        raise ValueError("max_gap_seconds must be finite and positive.")
    if episode_offset < 0 or not 1 <= episode_limit <= 1000:
        raise ValueError("episode_offset must be >= 0 and episode_limit must be 1..1000.")
    if len(times) != len(heart_rates):
        raise ValueError("Time and HR streams have different lengths; cannot align samples.")
    t = [number(x) for x in times]
    if any(x is None or x < 0 for x in t):
        raise ValueError("Time stream contains invalid or negative timestamps.")
    timeline = [float(x) for x in t if x is not None]
    if any(b < a for a, b in zip(timeline, timeline[1:], strict=False)):
        raise ValueError("Time stream is not monotonic.")
    hr = [number(x) for x in heart_rates]
    hr = [x if x is not None and x > 0 else None for x in hr]
    valid = [(i, x) for i, x in enumerate(hr) if x is not None]
    if not valid:
        return {
            "status": "no_hr_data",
            "total_samples": len(hr),
            "valid_hr_samples": 0,
            "raw_max_bpm": None,
            "seconds_above_threshold": None,
            "episodes": [],
        }

    episodes: list[dict[str, Any]] = []
    episode: dict[str, Any] | None = None
    known_seconds = 0.0
    above_seconds = 0.0
    unknown_seconds = 0.0
    gap_count = 0
    for i, value in enumerate(hr):
        dt = timeline[i + 1] - timeline[i] if i + 1 < len(hr) else 0.0
        connected = (
            i + 1 < len(hr)
            and value is not None
            and hr[i + 1] is not None
            and 0 < dt <= max_gap_seconds
        )
        known_seconds += dt if connected else 0
        unknown_seconds += dt if not connected else 0
        if dt > max_gap_seconds:
            gap_count += 1
        if value is not None and value > threshold:
            if episode is None:
                episode = {
                    "start_seconds": timeline[i],
                    "end_seconds": timeline[i],
                    "peak_bpm": value,
                    "peak_at_seconds": timeline[i],
                    "samples": 0,
                    "estimated_seconds": 0.0,
                }
            episode["samples"] += 1
            if value > episode["peak_bpm"]:
                episode.update(peak_bpm=value, peak_at_seconds=timeline[i])
            duration = dt if connected else 0.0
            episode["end_seconds"] = timeline[i] + duration
            episode["estimated_seconds"] += duration
            above_seconds += duration
        next_hr = hr[i + 1] if i + 1 < len(hr) else None
        if episode is not None and (not connected or next_hr is None or next_hr <= threshold):
            episodes.append(episode)
            episode = None

    peak_index, peak = max(valid, key=lambda item: item[1])
    page = episodes[episode_offset : episode_offset + episode_limit]
    return {
        "status": "ok",
        "threshold_bpm": threshold,
        "comparison": ">",
        "total_samples": len(hr),
        "valid_hr_samples": len(valid),
        "missing_or_invalid_hr_samples": len(hr) - len(valid),
        "raw_max_bpm": peak,
        "raw_peak_at_seconds": timeline[peak_index],
        "samples_above_threshold": sum(x > threshold for _, x in valid),
        "seconds_above_threshold": above_seconds,
        "observed_duration_seconds": timeline[-1] - timeline[0],
        "covered_duration_seconds": known_seconds,
        "uncovered_duration_seconds": unknown_seconds,
        "gap_count": gap_count,
        "max_gap_seconds": max_gap_seconds,
        "longest_episode_seconds": max((x["estimated_seconds"] for x in episodes), default=0.0),
        "episode_count": len(episodes),
        "episode_offset": episode_offset,
        "episodes": page,
        "next_episode_offset": episode_offset + len(page)
        if episode_offset + len(page) < len(episodes)
        else None,
        "duration_method": "Left-hold between adjacent valid HR samples; gaps above max_gap_seconds excluded; final sample not extrapolated.",
        "interpretation": "Recorded values only. Peaks may be physiological or measurement artefacts; no diagnosis or automatic removal.",
    }
