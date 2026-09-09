"""Read original FIT files without creating public links or server-side files."""

import gzip
import io
import re
from typing import Any

import httpx

from intervals_mcp_server.api.client import _get_httpx_client, _prepare_request_config

MAX_FILE_BYTES = 32 * 1024 * 1024


def validate_activity_id(activity_id: str) -> None:
    """Only accept an activity ID, never a URL or path."""
    if not re.fullmatch(r"i?\d+", activity_id):
        raise ValueError("activity_id must be an Intervals.icu activity ID (e.g. i123).")


def unpack_fit(payload: bytes) -> bytes:
    """Decode optional file-level gzip, bounded before and after decompression."""
    if len(payload) > MAX_FILE_BYTES:
        raise ValueError("Original file exceeds the 32 MiB limit.")
    if payload.startswith(b"\x1f\x8b"):
        with gzip.GzipFile(fileobj=io.BytesIO(payload)) as compressed:
            payload = compressed.read(MAX_FILE_BYTES + 1)
    if len(payload) > MAX_FILE_BYTES:
        raise ValueError("Decompressed file exceeds the 32 MiB limit.")
    if len(payload) < 14 or payload[8:12] != b".FIT":
        raise ValueError("The original file is not FIT; no generated/edited FIT was substituted.")
    return payload


async def fetch_original_fit(
    activity_id: str, api_key: str | None = None
) -> bytes | dict[str, Any]:
    """Fetch authenticated, bounded binary data from /file, never /fit-file."""
    validate_activity_id(activity_id)
    url, auth, headers, error = _prepare_request_config(
        f"/activity/{activity_id}/file", api_key, "GET"
    )
    if error:
        return {"error": True, "message": error}
    headers["Accept"] = "application/octet-stream"
    try:
        client = await _get_httpx_client()
        async with client.stream(
            "GET", url, auth=auth, headers=headers, timeout=60.0, follow_redirects=False
        ) as response:
            if response.status_code != 200:
                return {
                    "error": True,
                    "status_code": response.status_code,
                    "message": "Original file unavailable through the API. Check access and data source; Strava API activities cannot be forwarded.",
                }
            data = bytearray()
            async for chunk in response.aiter_bytes(chunk_size=65536):
                data.extend(chunk)
                if len(data) > MAX_FILE_BYTES:
                    raise ValueError("Original file exceeds the 32 MiB limit.")
        return unpack_fit(bytes(data))
    except (httpx.HTTPError, OSError, EOFError, ValueError) as exc:
        # Do not expose response bodies, credentials, or redirects in errors.
        message = (
            str(exc)
            if isinstance(exc, ValueError)
            else "Could not download/decompress the original FIT file."
        )
        return {"error": True, "message": message}
